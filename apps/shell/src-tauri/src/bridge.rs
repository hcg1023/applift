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
    let (result, was_ready) = {
        let mut guard = state.supervisor.lock().unwrap();
        // M-2：仅非 Ready → Ready 的转变重启守护线程；Ready 态幂等重试不得叠加 monitor
        let was_ready = guard
            .as_ref()
            .is_some_and(|s| matches!(s.state(), ServerState::Ready { .. }));
        let result = match guard.as_mut() {
            Some(sup) => sup.retry(),
            None => Err("node 缺失（壳未初始化 supervisor）".into()),
        };
        (result, was_ready)
    };
    if let Ok(port) = result {
        crate::nav_port(&app, port);
        if !was_ready {
            crate::spawn_monitor(app);
        }
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

// -- 托盘角标 + popup 唤起（T4）------------------------------------------------

/// 未读数落地：托盘标题数字（macOS NSStatusButton 标题 / Linux 面板文本；
/// tray-icon 0.25 无 set_overlay，Windows 标题为 no-op——角标为 macOS/Linux 增强）
fn apply_badge(app: &AppHandle, n: u32) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(crate::tray::TRAY_ID) else {
        return Ok(()); // 托盘缺席（异常构建）静默：未读数仍有前端侧栏兜底
    };
    tray.set_title(crate::tray::badge_title(n).as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_badge(app: AppHandle, n: u32) -> Result<(), String> {
    apply_badge(&app, n)
}

/// 路由白名单化：仅接受本应用 "#/..." hash、长度受控、无控制字符（防任意串注入导航）
pub(crate) fn sanitize_route(route: Option<&str>) -> Option<String> {
    let r = route?;
    if r.len() > 512 || !r.starts_with("#/") || r.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(r.to_string())
}

/// popup 行点击/快捷入口：唤起主窗并导航到对应路由（route None 仅唤起）
#[tauri::command]
pub fn open_main(app: AppHandle, route: Option<String>) -> Result<(), String> {
    crate::tray::show_main(&app);
    let Some(route) = sanitize_route(route.as_deref()) else {
        return Ok(());
    };
    // 端口缺席（服务未就绪/失败态）：主窗仍在 startup 态展示，跳过导航
    if let (Some(win), Some(port)) = (
        app.get_webview_window("main"),
        with_supervisor(&app, |s| s.port()).flatten(),
    ) {
        crate::navigate(&win, &format!("index.html?serverPort={port}{route}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::sanitize_route;

    #[test]
    fn sanitize_route_accepts_app_hashes_only() {
        assert_eq!(sanitize_route(None), None);
        assert_eq!(sanitize_route(Some("#/project/p1")).as_deref(), Some("#/project/p1"));
        assert_eq!(sanitize_route(Some("#/release")).as_deref(), Some("#/release"));
        assert_eq!(sanitize_route(Some("")).as_deref(), None, "空串拒绝");
        assert_eq!(sanitize_route(Some("https://evil.example")).as_deref(), None, "外域拒绝");
        assert_eq!(sanitize_route(Some("/local/path")).as_deref(), None, "非 hash 拒绝");
        assert_eq!(sanitize_route(Some("#/x\u{0000}y")).as_deref(), None, "控制字符拒绝");
        assert_eq!(sanitize_route(Some(&format!("#/{}", "a".repeat(600)))).as_deref(), None, "超长拒绝");
    }
}
