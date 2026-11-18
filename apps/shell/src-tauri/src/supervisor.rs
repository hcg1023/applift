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

/// 子进程 PATH 增补：GUI 启动（Finder/open/launchd）继承的 PATH 常缺 Homebrew 等安装目录
/// （node 与全局 applift 装在那里）——spawn node / ui-server 前并入常见前缀（去重、保序）。
/// Windows 的 PATH 由安装器维护，无需增补（返回原值）。
pub fn augmented_path(base: Option<&str>) -> String {
    let current = base
        .map(str::to_string)
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    let mut seen: Vec<std::path::PathBuf> = std::env::split_paths(&current).collect();
    let mut extras: Vec<std::path::PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        extras.push("/opt/homebrew/bin".into());
        extras.push("/usr/local/bin".into());
        // node 版本管理器稳定目录（存在才加；nvm 目录带版本号不可枚举，不覆盖）
        if let Some(home) = std::env::var_os("HOME") {
            let h = std::path::PathBuf::from(home);
            extras.push(h.join(".local/share/fnm/aliases/default/bin"));
            extras.push(h.join(".volta/bin"));
        }
    }
    for e in extras {
        if !seen.contains(&e) && e.is_dir() {
            seen.push(e);
        }
    }
    std::env::join_paths(&seen)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or(current)
}

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
            .env("PATH", augmented_path(None))
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
    /// POST /api/refresh：触发服务端立即轮询（托盘菜单「立即刷新」）
    fn post_refresh(&self, port: u16) -> bool;
}

/// 极简阻塞 HTTP/1.1 客户端：仅面向 127.0.0.1 的 ui-server，无重定向/分块需求
#[derive(Clone, Copy)]
pub struct LocalHttp {
    pub timeout: Duration,
}

impl Default for LocalHttp {
    fn default() -> Self {
        Self {
            timeout: Duration::from_millis(1500),
        }
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

    fn post_refresh(&self, port: u16) -> bool {
        raw_request("POST", port, "/api/refresh", self.timeout)
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
        self.log
            .push("[shell] server process handle dropped".into());
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
            // GUI 启动的 PATH 缺 homebrew 目录：ui-server 内部的 applift 检索链（PATH 扫描）靠它命中全局安装
            .env("PATH", augmented_path(None))
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
        Ok(Box::new(ChildProcess {
            child,
            log: self.log.clone(),
        }))
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
    /// Ready 后稳定运行该时长即重置重启额度（运行期慢性崩溃不至于永久失去守护）
    pub stable_reset: Duration,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            port_file: default_port_file(),
            ready_timeout: Duration::from_secs(10),
            poll_interval: Duration::from_millis(200),
            shutdown_grace: Duration::from_secs(3),
            stable_reset: Duration::from_secs(60),
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
    /// 端口文件是否由本 supervisor 写入（复用实例的文件不归我们删）
    own_port_file: bool,
    /// 连续 health 失联计数（≥2 才判死——单次抖动不触发重启）
    health_misses: u32,
    /// 进入 Ready 的时刻（稳定运行 stable_reset 后重置重启额度）
    ready_since: Option<Instant>,
}

impl Supervisor {
    pub fn new(
        http: Box<dyn UiHttp>,
        launcher: Box<dyn ServerLauncher>,
        cfg: SupervisorConfig,
    ) -> Self {
        Self {
            http,
            launcher,
            cfg,
            state: ServerState::Starting,
            child: None,
            restarts: 0,
            owns_server: false,
            own_port_file: false,
            health_misses: 0,
            ready_since: None,
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

    /// 托盘「立即刷新」：Ready 态 POST /api/refresh（触发服务端立即轮询一轮）
    pub fn request_refresh(&self) -> bool {
        match &self.state {
            ServerState::Ready { port, .. } => self.http.post_refresh(*port),
            _ => false,
        }
    }

    fn read_saved_port(&self) -> Option<u16> {
        let raw = fs::read_to_string(&self.cfg.port_file).ok()?;
        let n: u16 = raw.trim().parse().ok()?;
        (n > 0).then_some(n)
    }

    fn write_port_file(&mut self, port: u16) {
        if let Some(dir) = self.cfg.port_file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(&self.cfg.port_file, port.to_string());
        self.own_port_file = true;
    }

    /// 进入 Ready：统一落状态/计时/端口文件（复用与 spawn 两条路共用）
    fn enter_ready(&mut self, port: u16, reused_existing: bool) {
        self.owns_server = !reused_existing;
        self.state = ServerState::Ready {
            port,
            reused_existing,
        };
        self.health_misses = 0;
        self.ready_since = Some(Instant::now());
        if !reused_existing {
            self.write_port_file(port);
        }
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
            self.enter_ready(port, true);
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
                            self.enter_ready(ready_port, false);
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

    /// 运行期守护（monitor 线程周期调用）：
    /// - health 通 → 清失联计数；稳定运行 ≥ stable_reset 后重置重启额度（I2）
    /// - 连续 2 次失联才判死（M2：单次抖动不触发）
    /// - 重启优先原端口（URL 不变免二次导航）；未就绪则换新端口再试一次（M1：
    ///   Some(new_port) 由调用方重导航兜底）
    pub fn check_and_restart(&mut self) -> Option<u16> {
        let port = match &self.state {
            ServerState::Ready { port, .. } => *port,
            _ => return None,
        };
        if self.http.health_ok(port) {
            self.health_misses = 0;
            if let Some(since) = self.ready_since {
                if since.elapsed() >= self.cfg.stable_reset && self.restarts > 0 {
                    self.restarts = 0;
                    self.ready_since = Some(Instant::now());
                }
            }
            return None;
        }
        self.health_misses += 1;
        if self.health_misses < 2 {
            return None; // 首次失联：下一 tick 复核（M2）
        }
        if self.restarts >= MAX_RESTARTS {
            self.state = ServerState::Failed {
                reason: "ui-server 崩溃且重启次数用尽".into(),
            };
            return None;
        }
        self.restarts += 1;
        self.health_misses = 0;
        if let Some(mut child) = self.child.take() {
            child.kill();
        }
        let mut ports = [Some(port), pick_free_port()];
        for next in ports.iter_mut().flatten() {
            match self.launcher.launch(*next) {
                Err(_) => {
                    self.state = ServerState::Failed {
                        reason: "ui-server 重启失败".into(),
                    };
                    return None;
                }
                Ok(child) => {
                    self.child = Some(child);
                    if let Some(ready) = self.wait_ready(*next) {
                        self.enter_ready(ready, false);
                        return Some(ready);
                    }
                }
            }
        }
        self.state = ServerState::Failed {
            reason: "ui-server 重启后未就绪".into(),
        };
        None
    }

    /// 手动重试（startup.html 重试按钮 → bridge invoke）：Ready 幂等返回；否则清零计数重走启动链
    pub fn retry(&mut self) -> Result<u16, String> {
        if let ServerState::Ready { port, .. } = self.state {
            return Ok(port);
        }
        self.restarts = 0;
        self.health_misses = 0;
        self.own_port_file = false; // Failed 期间残留的端口文件若是我们写的，重试成功后会覆盖
        self.ensure_started()
    }

    /// 退出清理：自己拉起的实例 POST /api/shutdown → 等待自然退出 → kill 兜底 + 清端口文件；
    /// 复用的既有实例不杀（属用户 `applift ui` 的进程）。
    /// Starting/Failed 态仍有活 child 时（启动窗口期退出，I3）同样 kill 兜底。
    pub fn shutdown(&mut self) {
        match self.state {
            ServerState::Ready { port, .. } if self.owns_server => {
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
            }
            _ => {
                // 非 Ready（复用/启动窗口期/失败）：只处理自己 spawn 的 child
                if let Some(mut child) = self.child.take() {
                    child.kill();
                    child.wait();
                }
                self.state = ServerState::Starting;
                if self.own_port_file {
                    self.remove_port_file();
                }
                return;
            }
        }
        self.child = None;
        self.state = ServerState::Starting;
        if self.own_port_file {
            self.remove_port_file();
        }
    }

    /// 测试专用：直接置 Starting 态活 child（模拟 ensure_started 进行中被退出打断）
    #[cfg(test)]
    pub(crate) fn inject_child_for_test(&mut self, child: Box<dyn ServerProcess>) {
        self.child = Some(child);
    }

    #[cfg(test)]
    pub(crate) fn mark_own_port_file_for_test(&mut self) {
        self.own_port_file = true;
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

    #[test]
    fn augmented_path_appends_missing_common_dirs() {
        // 输入/断言均按平台分隔符构造（Windows 是 ';'，Unix 是 ':'——写死 ':' 会在 win 上被
        // split_paths 当单个路径，join 回来后断言错位）
        let input = std::env::join_paths(["/usr/bin", "/bin"])
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let p = augmented_path(Some(&input));
        if cfg!(target_os = "macos") {
            assert!(p.starts_with(&input), "got {p}");
        } else {
            assert_eq!(p, input, "非 macOS 无增补，原样返回");
        }
    }

    #[test]
    fn augmented_path_dedupes_existing_entries() {
        let input = std::env::join_paths(["/usr/local/bin", "/usr/bin"])
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let p = augmented_path(Some(&input));
        if cfg!(target_os = "macos") {
            // 已存在的不重复：/usr/local/bin 只出现一次，且保持原序在前
            let first_local = p.find("/usr/local/bin").expect("kept original entry");
            let last_local = p.rfind("/usr/local/bin").expect("kept original entry");
            assert_eq!(first_local, last_local, "duplicated entry in {p}");
            assert!(p.starts_with(&input), "got {p}");
        } else {
            assert_eq!(p, input);
        }
    }

    #[derive(Default)]
    struct Shared {
        events: Vec<String>,
        healthy: HashSet<u16>,
        /// 这些端口即使 spawn 也不会变健康（模拟端口被占/起不来）
        never_healthy: HashSet<u16>,
        fail_launches: u32,
        /// 第 N 次 launch 起 spawn 即就绪（0 = 永不）
        auto_healthy_from: u32,
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
        fn post_refresh(&self, port: u16) -> bool {
            let mut s = self.0.lock().unwrap();
            s.events.push(format!("refresh:{port}"));
            s.healthy.contains(&port)
        }
    }

    /// launches 达到 Shared.auto_healthy_from 后，spawn 即把端口置为健康（模拟 server 就绪）
    struct StubLauncher {
        shared: Arc<Mutex<Shared>>,
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
            if s.auto_healthy_from > 0
                && n >= s.auto_healthy_from
                && !s.never_healthy.contains(&port)
            {
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
        p.push(format!(
            "applift-shell-test-{tag}-{}.port",
            std::process::id()
        ));
        let _ = fs::remove_file(&p);
        p
    }

    fn fast_cfg(port_file: PathBuf) -> SupervisorConfig {
        SupervisorConfig {
            port_file,
            ready_timeout: Duration::from_millis(200),
            poll_interval: Duration::from_millis(10),
            shutdown_grace: Duration::from_millis(100),
            stable_reset: Duration::from_secs(60),
        }
    }

    fn make(shared: Arc<Mutex<Shared>>, port_file: PathBuf) -> Supervisor {
        Supervisor::new(
            Box::new(StubHttp(shared.clone())),
            Box::new(StubLauncher { shared }),
            fast_cfg(port_file),
        )
    }

    /// 两次失联 tick（M2：连续 2 次才判死）——重启动作发生在第二次
    fn two_miss_ticks(sup: &mut Supervisor) -> Option<u16> {
        let first = sup.check_and_restart();
        assert_eq!(first, None, "首次失联只计数不重启");
        sup.check_and_restart()
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
        let mut sup = make(shared.clone(), pf.clone());
        let port = sup.ensure_started().unwrap();
        assert_eq!(port, 47999);
        assert_eq!(shared.lock().unwrap().launches, 0, "复用不 spawn");
        assert_eq!(
            sup.state(),
            &ServerState::Ready {
                port: 47999,
                reused_existing: true
            }
        );
        // 复用实例退出不杀、不删端口文件
        sup.shutdown();
        assert!(pf.exists());
        assert!(shared
            .lock()
            .unwrap()
            .events
            .iter()
            .all(|e| !e.starts_with("shutdown")));
    }

    #[test]
    fn spawns_and_becomes_ready() {
        let shared = Arc::new(Mutex::new(Shared::default()));
        shared.lock().unwrap().auto_healthy_from = 1;
        let pf = temp_port_file("spawn");
        let mut sup = make(shared.clone(), pf.clone());
        let port = sup.ensure_started().unwrap();
        assert!(port > 0);
        assert_eq!(shared.lock().unwrap().launches, 1);
        assert!(matches!(
            sup.state(),
            ServerState::Ready {
                reused_existing: false,
                ..
            }
        ));
        assert_eq!(
            fs::read_to_string(&pf).unwrap(),
            port.to_string(),
            "就绪后补写端口文件"
        );
    }

    #[test]
    fn restarts_once_when_child_dies_before_ready() {
        let shared = Arc::new(Mutex::new(Shared::default()));
        {
            let mut s = shared.lock().unwrap();
            s.exit_before_ready = 1;
            s.auto_healthy_from = 2;
        }
        let pf = temp_port_file("restart1");
        let mut sup = make(shared.clone(), pf);
        let port = sup.ensure_started().unwrap();
        assert!(port > 0);
        assert_eq!(shared.lock().unwrap().launches, 2, "崩溃后重启 1 次");
        assert_eq!(sup.restarts(), 0, "启动期重试不计入运行期守护额度");
    }

    #[test]
    fn fails_after_exhausting_restarts() {
        let shared = Arc::new(Mutex::new(Shared::default()));
        {
            let mut s = shared.lock().unwrap();
            s.exit_before_ready = 10; // 每次都崩
            s.auto_healthy_from = 99;
        }
        let pf = temp_port_file("fail");
        let mut sup = make(shared.clone(), pf);
        let err = sup.ensure_started().unwrap_err();
        assert!(err.contains("not ready"), "err={err}");
        assert!(matches!(sup.state(), ServerState::Failed { .. }));
        assert_eq!(shared.lock().unwrap().launches, 2, "初始 + 1 次重试后放弃");
    }

    #[test]
    fn shutdown_posts_then_kills_in_order() {
        let shared = Arc::new(Mutex::new(Shared::default()));
        shared.lock().unwrap().auto_healthy_from = 1;
        let pf = temp_port_file("order");
        let mut sup = make(shared.clone(), pf.clone());
        let port = sup.ensure_started().unwrap();
        sup.shutdown();
        let events = shared.lock().unwrap().events.clone();
        let shutdown_at = events
            .iter()
            .position(|e| e == &format!("shutdown:{port}"))
            .expect("POST /api/shutdown 先行");
        let kill_at = events
            .iter()
            .position(|e| e == "kill")
            .expect("未就绪则 kill 兜底");
        assert!(
            shutdown_at < kill_at,
            "调用序：shutdown → kill（events={events:?}）"
        );
        assert!(!pf.exists(), "关停后清理端口文件");
    }

    #[test]
    fn monitor_restarts_crashed_server_then_gives_up() {
        let shared = Arc::new(Mutex::new(Shared::default()));
        shared.lock().unwrap().auto_healthy_from = 1;
        let pf = temp_port_file("monitor");
        let mut sup = make(shared.clone(), pf);
        let port = sup.ensure_started().unwrap();

        // 正常运行：tick 无动作
        assert_eq!(sup.check_and_restart(), None);

        // 模拟进程被杀：连续 2 次失联（M2）→ 同端口重启恢复
        shared.lock().unwrap().healthy.remove(&port);
        assert_eq!(
            two_miss_ticks(&mut sup),
            Some(port),
            "同端口恢复，URL 不变免再导航"
        );
        assert_eq!(sup.restarts(), 1);

        // 再次崩溃：额度用尽 → Failed
        shared.lock().unwrap().healthy.remove(&port);
        assert_eq!(two_miss_ticks(&mut sup), None);
        assert!(matches!(sup.state(), ServerState::Failed { .. }));
    }

    #[test]
    fn single_health_blip_does_not_restart() {
        // M2：单次失联（下一 tick 已恢复）不触发重启
        let shared = Arc::new(Mutex::new(Shared::default()));
        shared.lock().unwrap().auto_healthy_from = 1;
        let pf = temp_port_file("blip");
        let mut sup = make(shared.clone(), pf);
        let port = sup.ensure_started().unwrap();

        shared.lock().unwrap().healthy.remove(&port);
        assert_eq!(sup.check_and_restart(), None, "首次失联只计数");
        shared.lock().unwrap().healthy.insert(port);
        assert_eq!(sup.check_and_restart(), None, "恢复即清零");
        assert_eq!(shared.lock().unwrap().launches, 1, "没有多余 spawn");
    }

    #[test]
    fn stable_run_resets_restart_budget() {
        // I2：重启恢复后稳定运行 ≥ stable_reset → 额度重置，可再次守护
        let shared = Arc::new(Mutex::new(Shared::default()));
        shared.lock().unwrap().auto_healthy_from = 1;
        let pf = temp_port_file("stable");
        let mut sup = Supervisor::new(
            Box::new(StubHttp(shared.clone())),
            Box::new(StubLauncher {
                shared: shared.clone(),
            }),
            SupervisorConfig {
                stable_reset: Duration::from_millis(20),
                ..fast_cfg(pf)
            },
        );
        let port = sup.ensure_started().unwrap();

        shared.lock().unwrap().healthy.remove(&port);
        assert_eq!(two_miss_ticks(&mut sup), Some(port));
        assert_eq!(sup.restarts(), 1);

        std::thread::sleep(Duration::from_millis(40)); // 稳定期 > stable_reset
        assert_eq!(sup.check_and_restart(), None);
        assert_eq!(sup.restarts(), 0, "稳定运行后额度重置");

        // 再崩：有新额度，仍能恢复
        shared.lock().unwrap().healthy.remove(&port);
        assert_eq!(two_miss_ticks(&mut sup), Some(port));
    }

    #[test]
    fn monitor_restart_falls_back_to_fresh_port() {
        // M1：原端口起不来（never_healthy）→ 换新端口恢复，Some(new) 触发壳重导航
        let shared = Arc::new(Mutex::new(Shared::default()));
        shared.lock().unwrap().auto_healthy_from = 1;
        let pf = temp_port_file("freshport");
        let mut sup = make(shared.clone(), pf);
        let port = sup.ensure_started().unwrap();

        shared.lock().unwrap().healthy.remove(&port);
        shared.lock().unwrap().never_healthy.insert(port);
        let new_port = two_miss_ticks(&mut sup).expect("换端口兜底恢复");
        assert_ne!(new_port, port);
        let events = shared.lock().unwrap().events.clone();
        assert!(events.contains(&format!("launch:{port}")), "先试原端口");
        assert!(events.contains(&format!("launch:{new_port}")), "再换新端口");
    }

    #[test]
    fn shutdown_during_startup_kills_orphan_child() {
        // I3：启动窗口期（Starting、child 已 spawn 未就绪）退出 → kill 兜底 + 清端口文件
        let shared = Arc::new(Mutex::new(Shared::default()));
        let pf = temp_port_file("orphan");
        let mut sup = make(shared.clone(), pf.clone());
        sup.inject_child_for_test(Box::new(StubProcess {
            shared: shared.clone(),
            exit_code: None,
            polled: AtomicU32::new(0),
        }));
        sup.mark_own_port_file_for_test();
        fs::write(&pf, "1").unwrap();
        sup.shutdown();
        let events = shared.lock().unwrap().events.clone();
        assert!(
            events.iter().any(|e| e == "kill"),
            "启动窗口期退出 kill 兜底"
        );
        assert!(!pf.exists(), "自己写的端口文件被清理");
    }

    #[test]
    fn retry_recovers_from_failed_state() {
        // I4：Failed → retry 重走启动链恢复；Ready 态 retry 幂等
        let shared = Arc::new(Mutex::new(Shared::default()));
        {
            let mut s = shared.lock().unwrap();
            s.exit_before_ready = 10;
            s.auto_healthy_from = 99;
        }
        let pf = temp_port_file("retry");
        let mut sup = make(shared.clone(), pf);
        assert!(sup.ensure_started().is_err());
        assert!(matches!(sup.state(), ServerState::Failed { .. }));

        // 环境修复：下一次（第 3 次）launch 起正常就绪
        {
            let mut s = shared.lock().unwrap();
            s.exit_before_ready = 0;
            s.auto_healthy_from = 3;
        }
        let port = sup.retry().expect("retry 恢复");
        assert!(matches!(sup.state(), ServerState::Ready { .. }));
        assert_eq!(sup.retry(), Ok(port), "Ready 态幂等返回");
    }

    #[test]
    fn pick_free_port_returns_valid() {
        let port = pick_free_port().unwrap();
        assert!(port > 0);
    }

    #[test]
    fn request_refresh_only_when_ready() {
        let shared = Arc::new(Mutex::new(Shared::default()));
        {
            let mut s = shared.lock().unwrap();
            s.auto_healthy_from = 1; // spawn 即就绪
        }
        let pf = temp_port_file("refresh");
        let mut sup = make(shared.clone(), pf);
        assert!(!sup.request_refresh(), "Starting 态不投递");
        let port = sup.ensure_started().expect("就绪");
        assert!(sup.request_refresh(), "Ready 态投递");
        let events = shared.lock().unwrap().events.clone();
        assert!(events.contains(&format!("refresh:{port}")));
    }

    /// LocalHttp::post_refresh 真实回环：POST /api/refresh 命中 200 → true；
    /// 无人监听端口 → false（连接拒绝路径）
    #[test]
    fn local_http_post_refresh_roundtrip() {
        use std::io::{Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let n = sock.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                .unwrap();
            req
        });
        assert!(LocalHttp::default().post_refresh(port));
        let req = handle.join().unwrap();
        assert!(
            req.starts_with("POST /api/refresh HTTP/1.1"),
            "请求行：{req}"
        );

        let dead = pick_free_port().unwrap(); // 短暂绑定后已释放：连接必拒
        assert!(!LocalHttp::default().post_refresh(dead));
    }
}
