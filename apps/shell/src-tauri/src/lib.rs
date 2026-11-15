//! applift 桌面壳：薄 Tauri 2 壳（窗口 + ui-server supervisor + 单例 + 自启）。
//! 主窗口加载内嵌 asset（与 webui 同一份 ui 构建产物），API 由壳经
//! `index.html?serverPort=<n>` 注入端口，前端 fetch/WS 显式指向 127.0.0.1。

mod bridge;
mod supervisor;
mod tray;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_autostart::MacosLauncher;
use supervisor::{
    detect_node, default_port_file, LocalHttp, NodeServerLauncher, ServerLog, ServerState,
    Supervisor, SupervisorConfig, SysNodeProbe,
};

/// 壳侧共享状态：supervisor 单线程持有（monitor 线程），退出时由主事件循环取走清理
struct ShellState {
    supervisor: Arc<Mutex<Option<Supervisor>>>,
}

/// 解析 ui-server 入口（dist/main.mjs）：
///   env 覆盖 > 相对 cwd 候选（dev：本仓 dist，防 resource_dir 内旧装配快照静默胜出）
///   > resource_dir 打包布局（release：cwd 无仓库，bundle resources 内 ui-server/dist 必中）
fn resolve_server_entry(cwd: Option<&std::path::Path>, resource_dir: Option<&std::path::Path>) -> String {
    if let Some(p) = std::env::var_os("APPLIFT_UI_SERVER_ENTRY") {
        return p.to_string_lossy().into_owned();
    }
    const CANDIDATES: [&str; 3] = [
        "apps/ui-server/dist/main.mjs",  // cwd = 仓库根
        "../../ui-server/dist/main.mjs", // cwd = apps/shell/src-tauri（cargo tauri dev）
        "../ui-server/dist/main.mjs",    // cwd = apps/shell
    ];
    if let Some(cwd) = cwd {
        for c in CANDIDATES {
            if cwd.join(c).is_file() {
                return c.to_string();
            }
        }
    }
    if let Some(dir) = resource_dir {
        let bundled = dir.join("ui-server").join("dist").join("main.mjs");
        if bundled.is_file() {
            return bundled.to_string_lossy().into_owned();
        }
    }
    CANDIDATES[1].to_string()
}

/// 导航到 frontendDist 内的相对路径（保留 asset origin，跨 Windows/macOS 两种协议）
pub(crate) fn navigate(win: &WebviewWindow, path: &str) {
    if let Ok(cur) = win.url() {
        if let Ok(target) = cur.join(path) {
            let _ = win.navigate(target);
        }
    }
}

fn nav_port(app: &AppHandle, port: u16) {
    if let Some(win) = app.get_webview_window("main") {
        navigate(&win, &format!("index.html?serverPort={port}"));
    }
}

/// 运行期守护线程：Ready 态 health 连续失联 → 重启（额度内）；端口变化则重导航。
/// Failed 退出线程——后续由 retry_server_start（手动重试）重新拉起。
pub(crate) fn spawn_monitor(app: AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<ShellState>();
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let mut guard = state.supervisor.lock().unwrap();
            let Some(sup) = guard.as_mut() else { break };
            match sup.state() {
                ServerState::Failed { .. } => break,
                ServerState::Ready { .. } => {
                    if let Some(new_port) = sup.check_and_restart() {
                        nav_port(&app, new_port);
                    }
                }
                ServerState::Starting => {}
            }
        }
    });
}

/// 壳主链路（后台线程）：node 自检 → supervisor 启动/复用 → 导航主窗口 → 运行期守护。
/// supervisor 先入共享状态再 ensure_started（I3）：启动窗口期退出时清理链也能拿到它兜底 kill。
fn shell_main(app: AppHandle) {
    if detect_node(&SysNodeProbe).is_none() {
        if let Some(win) = app.get_webview_window("main") {
            navigate(&win, "node-required.html");
        }
        return;
    }
    let cfg = SupervisorConfig {
        port_file: default_port_file(),
        ..Default::default()
    };
    let log = Arc::new(ServerLog::default());
    let sup = Supervisor::new(
        Box::new(LocalHttp::default()),
        Box::new(NodeServerLauncher {
            node_bin: "node".into(),
            server_entry: resolve_server_entry(
                std::env::current_dir().ok().as_deref(),
                app.path().resource_dir().ok().as_deref(),
            ),
            log: log.clone(),
        }),
        cfg,
    );
    let state = app.state::<ShellState>();
    // 先占位再启动：Exit 清理锁到的是 Some（哪怕 ensure_started 还在等就绪）
    let result = {
        let mut guard = state.supervisor.lock().unwrap();
        let sup_entry = guard.insert(sup);
        sup_entry.ensure_started()
    };
    match result {
        Ok(port) => nav_port(&app, port),
        Err(reason) => {
            for line in log.tail() {
                eprintln!("[shell] server: {line}");
            }
            eprintln!("[shell] ui-server 启动失败：{reason}");
            if let Some(win) = app.get_webview_window("main") {
                navigate(
                    &win,
                    &format!("startup.html?reason={}", urlencoding_min(&reason)),
                );
            }
        }
    }
    spawn_monitor(app);
}

/// 极简百分号编码（仅失败 reason 展示用）
fn urlencoding_min(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let supervisor: Arc<Mutex<Option<Supervisor>>> = Arc::new(Mutex::new(None));


    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 二次启动：唤起既有主窗口
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(ShellState { supervisor })
        .invoke_handler(tauri::generate_handler![
            bridge::get_server_port,
            bridge::server_status,
            bridge::get_autostart,
            bridge::retry_server_start,
            bridge::set_autostart,
            bridge::set_badge,
            bridge::open_main,
            bridge::is_main_visible,
        ])
        .on_window_event(|window, event| {
            // 常驻语义（spec §4）：主窗关=隐藏到托盘（菜单退出才真退）；
            // popup 失焦即隐藏（点外部关闭的 menubar 面板语义）
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            } else if window.label() == tray::POPUP_LABEL {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
            }
        })
        .setup(move |app| {
            // 登录自启：默认开（首次运行未写设置文件时启用），用户在设置页关闭后持久尊重。
            // debug 构建（tauri dev 高频起停）跳过 reconcile，不反复写 LaunchAgent（M3）
            #[cfg(not(debug_assertions))]
            {
                use tauri_plugin_autostart::ManagerExt;
                let settings = bridge::autostart_settings_path(app.handle())?;
                let enabled = bridge::read_autostart_setting(&settings).unwrap_or(true);
                let launch = app.autolaunch();
                match launch.is_enabled() {
                    Ok(true) if !enabled => {
                        let _ = launch.disable();
                    }
                    Ok(false) if enabled => {
                        let _ = launch.enable();
                    }
                    _ => {}
                }
            }
            // 托盘（spec §4）：图标+角标+左键 popup+右键菜单；失败不阻断壳主链路
            if let Err(e) = tray::build_tray(app.handle()) {
                eprintln!("[shell] 托盘初始化失败：{e}");
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || shell_main(handle));
            // SIGINT/SIGTERM/SIGHUP（dev 终端 Ctrl-C、pkill、nohup 挂断）默认不触发
            // RunEvent::Exit——转 app.exit(0) 走统一退出清理（带走自己拉起的 ui-server）
            let sig_handle = app.handle().clone();
            ctrlc::set_handler(move || sig_handle.exit(0)).ok();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app, event| {
            match event {
                tauri::RunEvent::Exit => {
                    if let Some(sup) = app.state::<ShellState>().supervisor.lock().unwrap().as_mut() {
                        sup.shutdown();
                    }
                }
                // macOS：点 Dock 图标/通知激活应用 → 唤起主窗（通知点击的最接近可达语义：
                // notification 插件不暴露点击回调，激活即 Reopen）
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => tray::show_main(app),
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::resolve_server_entry;
    use std::path::PathBuf;

    /// 空临时目录作 cwd：cwd 候选必然全 miss（隔离仓库真实 dist，测优先级本身）
    fn empty_cwd(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("applift-shell-cwd-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn server_entry_cwd_candidates_beat_resource_dir() {
        // dev 语义：本仓 dist 存在时优先——即使 resource_dir 也有（防旧装配快照胜出）
        let cwd = empty_cwd("dev");
        let repo_dist = cwd.join("apps/ui-server/dist");
        std::fs::create_dir_all(&repo_dist).unwrap();
        std::fs::write(repo_dist.join("main.mjs"), "// dev").unwrap();
        let res = empty_cwd("res");
        let res_dist = res.join("ui-server/dist");
        std::fs::create_dir_all(&res_dist).unwrap();
        std::fs::write(res_dist.join("main.mjs"), "// stale").unwrap();
        let got = resolve_server_entry(Some(&cwd), Some(&res));
        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&res).ok();
        assert_eq!(got, "apps/ui-server/dist/main.mjs");
    }

    #[test]
    fn server_entry_release_falls_to_resource_dir() {
        // release 语义：cwd（如 /）无仓库形态 → resource_dir 打包布局必中
        let cwd = empty_cwd("rel");
        let res = empty_cwd("res2");
        let dist = res.join("ui-server").join("dist");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("main.mjs"), "// bundled").unwrap();
        let got = resolve_server_entry(Some(&cwd), Some(&res));
        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&res).ok();
        assert_eq!(PathBuf::from(&got), dist.join("main.mjs"));
    }

    #[test]
    fn server_entry_all_missing_falls_back_to_default_candidate() {
        let cwd = empty_cwd("none");
        let nope = std::env::temp_dir().join("applift-shell-no-such-resource");
        let got = resolve_server_entry(Some(&cwd), Some(&nope));
        std::fs::remove_dir_all(&cwd).ok();
        assert_eq!(got, "../../ui-server/dist/main.mjs");
    }
}
