//! ui-server 生命周期管理：node 自检、已有实例探测、spawn + 就绪等待（崩溃重启 ≤1 次）、
//! 运行期守护与退出清理。所有外部交互（node 探测 / HTTP / 进程 spawn）走 trait，
//! cargo test 全部用桩注入（见文件尾 #[cfg(test)]）。

use std::fs;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 最低 Node 大版本（spec §2：≥20）
pub const MIN_NODE_MAJOR: u32 = 20;
/// 单次运行内崩溃重启上限（简报：≤1 次）
pub const MAX_RESTARTS: u32 = 1;

// ---------------------------------------------------------------------------
// node 自检
// ---------------------------------------------------------------------------

pub trait NodeProbe: Send {
    /// `node --version` 原始输出（如 "v20.11.0"）；不可用返回 None
    fn node_version_output(&self) -> Option<String>;
}

pub struct SysNodeProbe;

impl NodeProbe for SysNodeProbe {
    fn node_version_output(&self) -> Option<String> {
        Command::new("node")
            .arg("--version")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    }
}

/// "v20.11.0" / "20.11.0" / "v20" → (20, 11, 0)；畸形输入 None
pub fn parse_node_version(s: &str) -> Option<(u32, u32, u32)> {
    let trimmed = s.trim().trim_start_matches('v');
    let mut parts = trimmed.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().map(|p| p.parse().unwrap_or(0)).unwrap_or(0);
    let patch = parts.next().map(|p| p.parse().unwrap_or(0)).unwrap_or(0);
    Some((major, minor, patch))
}

/// node 可用且 ≥ MIN_NODE_MAJOR 时返回版本串（如 "v24.8.0"）
pub fn detect_node(probe: &dyn NodeProbe) -> Option<String> {
    let out = probe.node_version_output()?;
    let (major, _, _) = parse_node_version(&out)?;
    (major >= MIN_NODE_MAJOR).then(|| out.trim().to_string())
}

// ---------------------------------------------------------------------------
// 本机 HTTP（health 探测 / 优雅关停）
// ---------------------------------------------------------------------------

pub trait UiHttp: Send {
    fn health_ok(&self, port: u16) -> bool;
    fn post_shutdown(&self, port: u16) -> bool;
}

/// 极简阻塞 HTTP/1.1 客户端：仅面向 127.0.0.1 的 ui-server，无重定向/分块需求
#[derive(Clone, Copy)]
pub struct LocalHttp {
    pub timeout: Duration,
}

impl Default for LocalHttp {
    fn default() -> Self {
        Self { timeout: Duration::from_millis(1500) }
    }
}

fn raw_request(method: &str, port: u16, path: &str, timeout: Duration) -> Option<String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream.set_read_timeout(Some(timeout)).ok()?;
    stream.set_write_timeout(Some(timeout)).ok()?;
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = String::new();
    stream.read_to_string(&mut buf).ok()?;
    Some(buf)
}

impl UiHttp for LocalHttp {
    fn health_ok(&self, port: u16) -> bool {
        raw_request("GET", port, "/api/health", self.timeout)
            .map(|r| r.starts_with("HTTP/1.1 200") && r.contains("\"ok\""))
            .unwrap_or(false)
    }

    fn post_shutdown(&self, port: u16) -> bool {
        raw_request("POST", port, "/api/shutdown", self.timeout)
            .map(|r| r.starts_with("HTTP/1.1 200"))
            .unwrap_or(false)
    }
}

// ---------------------------------------------------------------------------
// 进程 spawn
// ---------------------------------------------------------------------------

pub trait ServerProcess: Send {
    /// 已退出返回退出码；仍在运行返回 None
    fn poll_exit(&mut self) -> Option<i32>;
    /// 强杀（兜底）
    fn kill(&mut self);
    /// 阻塞等待退出（优雅关停确认用）
    fn wait(&mut self);
}

pub trait ServerLauncher: Send {
    fn launch(&mut self, port: u16) -> io::Result<Box<dyn ServerProcess>>;
}

/// 捕获的 server 输出尾部（诊断用；容量有限）
#[derive(Default)]
pub struct ServerLog {
    pub lines: Mutex<Vec<String>>,
}

impl ServerLog {
    fn push(&self, line: String) {
        let mut lines = self.lines.lock().unwrap();
        if lines.len() >= 200 {
            lines.remove(0);
        }
        lines.push(line);
    }

    pub fn tail(&self) -> Vec<String> {
        self.lines.lock().unwrap().clone()
    }
}

struct ChildProcess {
    child: Child,
    log: Arc<ServerLog>,
}

impl ServerProcess for ChildProcess {
    fn poll_exit(&mut self) -> Option<i32> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(status.code().unwrap_or(-1)),
            Ok(None) => None,
            Err(_) => Some(-1),
        }
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
    }

    fn wait(&mut self) {
        let _ = self.child.wait();
    }
}

impl Drop for ChildProcess {
    fn drop(&mut self) {
        // stdio 管道读端随句柄关闭，drain 线程自然退出
        self.log.push("[shell] server process handle dropped".into());
    }
}

/// `node <server_entry> --port <n>`：stdout/stderr piped 并 drain 到 ServerLog（防管道写满阻塞子进程）
pub struct NodeServerLauncher {
    pub node_bin: String,
    pub server_entry: String,
    pub log: Arc<ServerLog>,
}

impl ServerLauncher for NodeServerLauncher {
    fn launch(&mut self, port: u16) -> io::Result<Box<dyn ServerProcess>> {
        let mut child = Command::new(&self.node_bin)
            .arg(&self.server_entry)
            .arg("--port")
            .arg(port.to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        if let Some(out) = child.stdout.take() {
            let log = self.log.clone();
            std::thread::spawn(move || {
                for line in io::BufReader::new(out).lines().map_while(|l| l.ok()) {
                    log.push(line);
                }
            });
        }
        if let Some(err) = child.stderr.take() {
            let log = self.log.clone();
            std::thread::spawn(move || {
                for line in io::BufReader::new(err).lines().map_while(|l| l.ok()) {
                    log.push(line);
                }
            });
        }
        Ok(Box::new(ChildProcess { child, log: self.log.clone() }))
    }
}

use std::io::BufRead;

/// 让系统分配一个空闲端口（短暂绑定后释放；与子进程 bind 存在窗口期竞态，本地场景可接受）
pub fn pick_free_port() -> Option<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).ok()?;
    listener.local_addr().ok().map(|a| a.port())
}

// ---------------------------------------------------------------------------
// supervisor 状态机
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub enum ServerState {
    Starting,
    Ready { port: u16, reused_existing: bool },
    Failed { reason: String },
}

#[derive(Clone, Debug)]
pub struct SupervisorConfig {
    /// ui.port 文件路径（与 CLI `applift ui` 互通：复用探测 + 就绪后补写）
    pub port_file: PathBuf,
    pub ready_timeout: Duration,
    pub poll_interval: Duration,
    /// POST /api/shutdown 后等待进程自然退出的时长（超时 kill 兜底）
    pub shutdown_grace: Duration,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            port_file: default_port_file(),
            ready_timeout: Duration::from_secs(10),
            poll_interval: Duration::from_millis(200),
            shutdown_grace: Duration::from_secs(3),
        }
    }
}

/// ~/.applift/ui.port（APPLIFT_HOME 可覆盖——与 CLI ui-command 同一约定）
pub fn default_port_file() -> PathBuf {
    let home = std::env::var_os("APPLIFT_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".applift").join("ui.port")
}

pub struct Supervisor {
    http: Box<dyn UiHttp>,
    launcher: Box<dyn ServerLauncher>,
    pub cfg: SupervisorConfig,
    state: ServerState,
    child: Option<Box<dyn ServerProcess>>,
    restarts: u32,
    owns_server: bool,
}

impl Supervisor {
    pub fn new(http: Box<dyn UiHttp>, launcher: Box<dyn ServerLauncher>, cfg: SupervisorConfig) -> Self {
        Self {
            http,
            launcher,
            cfg,
            state: ServerState::Starting,
            child: None,
            restarts: 0,
            owns_server: false,
        }
    }

    pub fn state(&self) -> &ServerState {
        &self.state
    }

    pub fn restarts(&self) -> u32 {
        self.restarts
    }

    pub fn port(&self) -> Option<u16> {
        match &self.state {
            ServerState::Ready { port, .. } => Some(*port),
            _ => None,
        }
    }

    fn read_saved_port(&self) -> Option<u16> {
        let raw = fs::read_to_string(&self.cfg.port_file).ok()?;
        let n: u16 = raw.trim().parse().ok()?;
        (n > 0).then_some(n)
    }

    fn write_port_file(&self, port: u16) {
        if let Some(dir) = self.cfg.port_file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(&self.cfg.port_file, port.to_string());
    }

    fn remove_port_file(&self) {
        let _ = fs::remove_file(&self.cfg.port_file);
    }

    /// 已有实例探测：ui.port 记录的端口 health 仍通 → 复用（不 spawn、退出时不杀）
    fn probe_existing(&mut self) -> Option<u16> {
        let port = self.read_saved_port()?;
        self.http.health_ok(port).then_some(port)
    }

    /// 启动主链路：探测复用 → 否则 spawn + 等就绪（就绪前崩溃/超时重启 ≤ MAX_RESTARTS）
    pub fn ensure_started(&mut self) -> Result<u16, String> {
        if let Some(port) = self.probe_existing() {
            self.owns_server = false;
            self.state = ServerState::Ready { port, reused_existing: true };
            return Ok(port);
        }
        let mut port = pick_free_port().ok_or_else(|| "无法分配空闲端口".to_string())?;
        let mut failures = 0u32;
        loop {
            match self.launcher.launch(port) {
                Err(e) => {
                    failures += 1;
                    if failures > MAX_RESTARTS {
                        self.state = ServerState::Failed {
                            reason: format!("ui-server 启动失败：{e}"),
                        };
                        return Err(format!("launch failed: {e}"));
                    }
                }
                Ok(child) => {
                    self.child = Some(child);
                    match self.wait_ready(port) {
                        Some(ready_port) => {
                            self.owns_server = true;
                            self.state =
                                ServerState::Ready { port: ready_port, reused_existing: false };
                            self.write_port_file(ready_port);
                            return Ok(ready_port);
                        }
                        None => {
                            failures += 1;
                            if failures > MAX_RESTARTS {
                                self.state = ServerState::Failed {
                                    reason: "ui-server 启动后未就绪（已重试）".to_string(),
                                };
                                return Err("server not ready after restart".to_string());
                            }
                            port = pick_free_port().unwrap_or(port);
                        }
                    }
                }
            }
        }
    }

    /// 就绪等待：health 通=Some；进程退出或超时=None（child 已清理）
    fn wait_ready(&mut self, port: u16) -> Option<u16> {
        let deadline = Instant::now() + self.cfg.ready_timeout;
        loop {
            if let Some(child) = self.child.as_mut() {
                if let Some(_code) = child.poll_exit() {
                    self.child = None;
                    return None;
                }
            }
            if self.http.health_ok(port) {
                return Some(port);
            }
            if Instant::now() >= deadline {
                if let Some(mut child) = self.child.take() {
                    child.kill();
                }
                return None;
            }
            std::thread::sleep(self.cfg.poll_interval);
        }
    }

    /// 运行期守护（monitor 线程周期调用）：Ready 态 health 失联 → 重启（累计 ≤ MAX_RESTARTS，
    /// 优先原端口——webview URL 不变免二次导航）；Some(port) 表示已恢复（端口可能变化）
    pub fn check_and_restart(&mut self) -> Option<u16> {
        let port = match &self.state {
            ServerState::Ready { port, .. } => *port,
            _ => return None,
        };
        if self.http.health_ok(port) {
            return None;
        }
        if self.restarts >= MAX_RESTARTS {
            self.state = ServerState::Failed { reason: "ui-server 崩溃且重启次数用尽".into() };
            return None;
        }
        self.restarts += 1;
        if let Some(mut child) = self.child.take() {
            child.kill();
        }
        loop {
            match self.launcher.launch(port) {
                Err(_) => {
                    // 启动器报错也计入已用重启额度：直接判失败
                    self.state = ServerState::Failed { reason: "ui-server 重启失败".into() };
                    return None;
                }
                Ok(child) => {
                    self.child = Some(child);
                    match self.wait_ready(port) {
                        Some(ready) => {
                            self.owns_server = true;
                            self.state = ServerState::Ready { port: ready, reused_existing: false };
                            self.write_port_file(ready);
                            return Some(ready);
                        }
                        None => {
                            self.state = ServerState::Failed {
                                reason: "ui-server 重启后未就绪".into(),
                            };
                            return None;
                        }
                    }
                }
            }
        }
    }

    /// 退出清理：自己拉起的实例 POST /api/shutdown → 等待自然退出 → kill 兜底 + 清端口文件；
    /// 复用的既有实例不杀（属用户 `applift ui` 的进程）
    pub fn shutdown(&mut self) {
        let port = match self.state {
            ServerState::Ready { port, .. } => port,
            _ => return,
        };
        if !self.owns_server {
            return;
        }
        self.http.post_shutdown(port);
        if let Some(child) = self.child.as_mut() {
            // 优雅等待：在 grace 内轮询退出，超时强杀
            let deadline = Instant::now() + self.cfg.shutdown_grace;
            loop {
                if child.poll_exit().is_some() {
                    break;
                }
                if Instant::now() >= deadline {
                    child.kill();
                    child.wait();
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        self.child = None;
        self.state = ServerState::Starting;
        self.remove_port_file();
    }
}

// ---------------------------------------------------------------------------
// tests（全桩注入：node 探测 / http / launcher）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct StubProbe(Option<String>);
    impl NodeProbe for StubProbe {
        fn node_version_output(&self) -> Option<String> {
            self.0.clone()
        }
    }

    #[derive(Default)]
    struct Shared {
        events: Vec<String>,
        healthy: HashSet<u16>,
        fail_launches: u32,
        /// 前 N 次拉起的进程在首次 poll_exit 即视为已退出（模拟就绪前崩溃）
        exit_before_ready: u32,
        launches: u32,
    }

    struct StubHttp(Arc<Mutex<Shared>>);
    impl UiHttp for StubHttp {
        fn health_ok(&self, port: u16) -> bool {
            self.0.lock().unwrap().healthy.contains(&port)
        }
        fn post_shutdown(&self, port: u16) -> bool {
            let mut s = self.0.lock().unwrap();
            s.events.push(format!("shutdown:{port}"));
            s.healthy.remove(&port);
            true
        }
    }

    /// launches >= auto_healthy_from 后，spawn 即把端口置为健康（模拟 server 起来就绪）
    struct StubLauncher {
        shared: Arc<Mutex<Shared>>,
        auto_healthy_from: u32,
    }

    struct StubProcess {
        shared: Arc<Mutex<Shared>>,
        /// None = 一直活着；Some(0) = 立即退出
        exit_code: Option<i32>,
        polled: AtomicU32,
    }

    impl ServerProcess for StubProcess {
        fn poll_exit(&mut self) -> Option<i32> {
            if self.polled.fetch_add(1, Ordering::SeqCst) == 0 && self.exit_code.is_some() {
                return self.exit_code;
            }
            None
        }
        fn kill(&mut self) {
            self.shared.lock().unwrap().events.push("kill".into());
        }
        fn wait(&mut self) {}
    }

    impl ServerLauncher for StubLauncher {
        fn launch(&mut self, port: u16) -> io::Result<Box<dyn ServerProcess>> {
            let mut s = self.shared.lock().unwrap();
            s.launches += 1;
            s.events.push(format!("launch:{port}"));
            let n = s.launches;
            if s.fail_launches > 0 {
                s.fail_launches -= 1;
                return Err(io::Error::other("spawn boom"));
            }
            if self.auto_healthy_from > 0 && n >= self.auto_healthy_from {
                s.healthy.insert(port);
            }
            let exit_code = if s.exit_before_ready > 0 {
                s.exit_before_ready -= 1;
                Some(1)
            } else {
                None
            };
            Ok(Box::new(StubProcess {
                shared: self.shared.clone(),
                exit_code,
                polled: AtomicU32::new(0),
            }))
        }
    }

    fn temp_port_file(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("applift-shell-test-{tag}-{}.port", std::process::id()));
        let _ = fs::remove_file(&p);
        p
    }

    fn fast_cfg(port_file: PathBuf) -> SupervisorConfig {
        SupervisorConfig {
            port_file,
            ready_timeout: Duration::from_millis(600),
            poll_interval: Duration::from_millis(20),
            shutdown_grace: Duration::from_millis(100),
        }
    }

    fn make(
        shared: Arc<Mutex<Shared>>,
        auto_healthy_from: u32,
        port_file: PathBuf,
    ) -> Supervisor {
        Supervisor::new(
            Box::new(StubHttp(shared.clone())),
            Box::new(StubLauncher { shared, auto_healthy_from }),
            fast_cfg(port_file),
        )
    }

    // -- node 自检矩阵 ------------------------------------------------------

    #[test]
    fn parse_node_version_matrix() {
        assert_eq!(parse_node_version("v20.11.0"), Some((20, 11, 0)));
        assert_eq!(parse_node_version("v24.8.0\n"), Some((24, 8, 0)));
        assert_eq!(parse_node_version("20.1.2"), Some((20, 1, 2)));
        assert_eq!(parse_node_version("v20"), Some((20, 0, 0)));
        assert_eq!(parse_node_version("v20.0.0-nightly"), Some((20, 0, 0)));
        assert_eq!(parse_node_version(""), None);
        assert_eq!(parse_node_version("not found"), None);
        assert_eq!(parse_node_version("vX.Y.Z"), None);
    }

    #[test]
    fn detect_node_matrix() {
        let ok = |s: &str| detect_node(&StubProbe(Some(s.to_string())));
        assert_eq!(ok("v20.0.0").as_deref(), Some("v20.0.0"));
        assert_eq!(ok("v24.8.0").as_deref(), Some("v24.8.0"));
        assert_eq!(ok("v19.9.9"), None, "低于 20 拒绝");
        assert_eq!(ok("garbage"), None);
        assert_eq!(detect_node(&StubProbe(None)), None, "node 缺失");
    }

    // -- supervisor 状态机 --------------------------------------------------

    #[test]
    fn reuses_existing_instance_from_port_file() {
        let shared = Arc::new(Mutex::new(Shared::default()));
        shared.lock().unwrap().healthy.insert(47999);
        let pf = temp_port_file("reuse");
        fs::write(&pf, "47999").unwrap();
        let mut sup = make(shared.clone(), 0, pf.clone());
        let port = sup.ensure_started().unwrap();
        assert_eq!(port, 47999);
        assert_eq!(shared.lock().unwrap().launches, 0, "复用不 spawn");
        assert_eq!(
            sup.state(),
            &ServerState::Ready { port: 47999, reused_existing: true }
        );
        // 复用实例退出不杀、不删端口文件
        sup.shutdown();
        assert!(pf.exists());
        assert!(shared.lock().unwrap().events.iter().all(|e| !e.starts_with("shutdown")));
    }

    #[test]
    fn spawns_and_becomes_ready() {
        let shared = Arc::new(Mutex::new(Shared::default()));
        let pf = temp_port_file("spawn");
        let mut sup = make(shared.clone(), 1, pf.clone());
        let port = sup.ensure_started().unwrap();
        assert!(port > 0);
        assert_eq!(shared.lock().unwrap().launches, 1);
        assert!(matches!(sup.state(), ServerState::Ready { reused_existing: false, .. }));
        assert_eq!(fs::read_to_string(&pf).unwrap(), port.to_string(), "就绪后补写端口文件");
    }

    #[test]
    fn restarts_once_when_child_dies_before_ready() {
        let shared = Arc::new(Mutex::new(Shared::default()));
        shared.lock().unwrap().exit_before_ready = 1;
        let pf = temp_port_file("restart1");
        let mut sup = make(shared.clone(), 2, pf);
        let port = sup.ensure_started().unwrap();
        assert!(port > 0);
        assert_eq!(shared.lock().unwrap().launches, 2, "崩溃后重启 1 次");
        assert_eq!(sup.restarts(), 0, "启动期重试不计入运行期守护额度");
    }

    #[test]
    fn fails_after_exhausting_restarts() {
        let shared = Arc::new(Mutex::new(Shared::default()));
        shared.lock().unwrap().exit_before_ready = 10; // 每次都崩
        let pf = temp_port_file("fail");
        let mut sup = make(shared.clone(), 99, pf);
        let err = sup.ensure_started().unwrap_err();
        assert!(err.contains("not ready"), "err={err}");
        assert!(matches!(sup.state(), ServerState::Failed { .. }));
        assert_eq!(shared.lock().unwrap().launches, 2, "初始 + 1 次重试后放弃");
    }

    #[test]
    fn shutdown_posts_then_kills_in_order() {
        let shared = Arc::new(Mutex::new(Shared::default()));
        let pf = temp_port_file("order");
        let mut sup = make(shared.clone(), 1, pf.clone());
        let port = sup.ensure_started().unwrap();
        sup.shutdown();
        let events = shared.lock().unwrap().events.clone();
        let shutdown_at = events
            .iter()
            .position(|e| e == &format!("shutdown:{port}"))
            .expect("POST /api/shutdown 先行");
        let kill_at = events.iter().position(|e| e == "kill").expect("未就绪则 kill 兜底");
        assert!(shutdown_at < kill_at, "调用序：shutdown → kill（events={events:?}）");
        assert!(!pf.exists(), "关停后清理端口文件");
    }

    #[test]
    fn monitor_restarts_crashed_server_then_gives_up() {
        let shared = Arc::new(Mutex::new(Shared::default()));
        let pf = temp_port_file("monitor");
        let mut sup = make(shared.clone(), 1, pf);
        let port = sup.ensure_started().unwrap();

        // 正常运行：tick 无动作
        assert_eq!(sup.check_and_restart(), None);

        // 模拟进程被杀：端口失联 → 同端口重启恢复
        shared.lock().unwrap().healthy.remove(&port);
        assert_eq!(sup.check_and_restart(), Some(port), "同端口恢复，URL 不变免再导航");
        assert_eq!(sup.restarts(), 1);

        // 再次崩溃：额度用尽 → Failed
        shared.lock().unwrap().healthy.remove(&port);
        assert_eq!(sup.check_and_restart(), None);
        assert!(matches!(sup.state(), ServerState::Failed { .. }));
    }

    #[test]
    fn pick_free_port_returns_valid() {
        let port = pick_free_port().unwrap();
        assert!(port > 0);
    }
}
