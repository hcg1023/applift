//! 前端 invoke 命令（HostAdapter 落地点之一；设置页接线在 T3）。

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

use super::supervisor::ServerState;
use super::ShellState;

#[derive(Serialize)]
pub struct ServerStatus {
    pub state: String,
    pub port: Option<u16>,
    pub reused_existing: Option<bool>,
    pub reason: Option<String>,
    pub restarts: u32,
}

#[tauri::command]
pub fn get_server_port(app: AppHandle) -> Option<u16> {
    with_supervisor(&app, |s| s.port()).flatten()
}

#[tauri::command]
pub fn server_status(app: AppHandle) -> ServerStatus {
    let state = app.state::<ShellState>();
    let sup = state.supervisor.lock().unwrap();
    match sup.as_ref().map(|s| (s.state().clone(), s.restarts())) {
        Some((ServerState::Ready { port, reused_existing }, restarts)) => ServerStatus {
            state: "ready".into(),
            port: Some(port),
            reused_existing: Some(reused_existing),
            reason: None,
            restarts,
        },
        Some((ServerState::Failed { reason }, restarts)) => ServerStatus {
            state: "failed".into(),
            port: None,
            reused_existing: None,
            reason: Some(reason),
            restarts,
        },
        _ => ServerStatus {
            state: "starting".into(),
            port: None,
            reused_existing: None,
            reason: None,
            restarts: 0,
        },
    }
}

fn with_supervisor<T>(
    app: &AppHandle,
    f: impl FnOnce(&super::supervisor::Supervisor) -> T,
) -> Option<T> {
    let state = app.state::<ShellState>();
    let guard = state.supervisor.lock().unwrap();
    guard.as_ref().map(f)
}


/// 手动重试（startup.html 重试按钮）：Failed → 重走启动链；成功后重导航主窗并重启守护线程
#[tauri::command]
pub fn retry_server_start(app: AppHandle) -> Result<u16, String> {
    let state = app.state::<ShellState>();
    let result = {
        let mut guard = state.supervisor.lock().unwrap();
        match guard.as_mut() {
            Some(sup) => sup.retry(),
            None => Err("node 缺失（壳未初始化 supervisor）".into()),
        }
    };
    if let Ok(port) = result {
        crate::nav_port(&app, port);
        crate::spawn_monitor(app);
    }
    result
}

// -- 登录自启（默认开；用户设置持久化在 app_config_dir/shell-settings.json）-----------
pub fn autostart_settings_path(app: &AppHandle) -> std::io::Result<std::path::PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| std::io::Error::other(format!("app_config_dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("shell-settings.json"))
}

pub fn read_autostart_setting(path: &std::path::Path) -> Option<bool> {
    serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(path).ok()?)
        .ok()?
        .get("autostart")?
        .as_bool()
}

#[tauri::command]
pub fn get_autostart(app: AppHandle) -> Result<bool, String> {
    let settings = autostart_settings_path(&app).map_err(|e| e.to_string())?;
    Ok(read_autostart_setting(&settings).unwrap_or(true))
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let launch = app.autolaunch();
    if enabled {
        launch.enable()
    } else {
        launch.disable()
    }
    .map_err(|e| e.to_string())?;
    let settings = autostart_settings_path(&app).map_err(|e| e.to_string())?;
    std::fs::write(&settings, serde_json::json!({ "autostart": enabled }).to_string())
        .map_err(|e| e.to_string())?;
    Ok(enabled)
}
