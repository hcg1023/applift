//! 系统托盘（spec §4）：常驻图标 + 未读数字 + 左键 popup 窗口（360×480 无边框）
//! + 右键菜单（打开主窗口/立即刷新/退出）。窗口交互见 lib.rs 的事件接线
//! （主窗 CloseRequested=隐藏到托盘；popup 失焦自动隐藏）。
//!
//! 可测性：图标位图、角标文案、菜单规格、popup 定位、rect 换算全部走纯函数，
//! 壳 API（tauri 托盘/窗口）只做薄接线。

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Manager, PhysicalPosition, Position, Size, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use super::ShellState;
pub const TRAY_ID: &str = "applift-tray";
pub const POPUP_LABEL: &str = "popup";
/// popup 逻辑尺寸（spec §4：360×480）
pub const POPUP_SIZE: (f64, f64) = (360.0, 480.0);
/// popup 与托盘/屏幕边缘的最小间距（逻辑像素）
const EDGE_GAP: f64 = 6.0;
/// 托盘图标边长（物理像素；macOS 菜单栏 @2x 约 44px，Windows 托盘 32px 邻域）
const TRAY_ICON_PX: u32 = 44;

// -- 纯函数面（cargo test） --------------------------------------------------

/// 右键菜单规格：(id, label)。注册与展示分离，命令 id 即分发键
pub fn menu_spec() -> [(&'static str, &'static str); 3] {
    [("open_main", "打开主窗口"), ("refresh_now", "立即刷新"), ("quit", "退出 applift")]
}

/// 未读数 → 托盘数字文案：0=清空（None）；1..=99 直显；>99 折叠 99+
pub fn badge_title(n: u32) -> Option<String> {
    match n {
        0 => None,
        1..=99 => Some(n.to_string()),
        _ => Some("99+".to_string()),
    }
}

/// 托盘图标位图（RGBA）：applift 品牌棱镜 A 剪影（与 docs/brand/assets/logo-favicon.svg 同形），
/// 黑色 + alpha 蒙版——macOS template 模式按 alpha 渲染系统单色，Windows/Linux 直接显示剪影。
/// 形状（brand 坐标 1024 系，evenodd）：外轮廓三角 (512,232)-(268,792)-(756,792)，
/// 字腔三角 (512,396)-(580,566)-(444,566) 掏空；含横梁内衬（两腿之间保持实心的横杠区域）。
pub fn tray_icon_rgba(size: u32) -> Vec<u8> {
    let s = size.max(1) as f64;
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);
    // 三角形内测试（叉积同号法），p1-p2-p3 逆时针
    let in_tri = |px: f64, py: f64, p1: (f64, f64), p2: (f64, f64), p3: (f64, f64)| -> bool {
        let d1 = (px - p2.0) * (p1.1 - p2.1) - (p1.0 - p2.0) * (py - p2.1);
        let d2 = (px - p3.0) * (p2.1 - p3.1) - (p2.0 - p3.0) * (py - p3.1);
        let d3 = (px - p1.0) * (p3.1 - p1.1) - (p3.0 - p1.0) * (py - p1.1);
        let neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
        let pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
        !(neg && pos)
    };
    // brand 1024 坐标 → 归一化（留 6% 边距让剪影不顶满格子）
    let n = |v: f64| (v / 1024.0 - 0.06) / 0.88;
    let outer = [(n(512.0), n(232.0)), (n(268.0), n(792.0)), (n(756.0), n(792.0))];
    let counter = [(n(512.0), n(396.0)), (n(580.0), n(566.0)), (n(444.0), n(566.0))];
    // 横梁内衬：字腔中补回的横杠（brand y 512-592 区间、腿内侧之间）
    let bar = |nx: f64, ny: f64| -> bool {
        let (bx, by) = ((nx * 0.88 + 0.06) * 1024.0, (ny * 0.88 + 0.06) * 1024.0); // 归一化 → brand
        by >= 512.0 && by <= 592.0 && bx >= 424.0 && bx <= 600.0
    };
    // 顶部脱离四芒火花（与正标/favicon 同位：A 顶点上方，中心 (512,208)、臂展 ±44/+40/-40）：
    // 四条尖臂（上/下/左/右菱形），alpha 蒙版下保留「脱离火花」特征
    let spark = |nx: f64, ny: f64| -> bool {
        let (bx, by) = ((nx * 0.88 + 0.06) * 1024.0, (ny * 0.88 + 0.06) * 1024.0); // brand
        let (dx, dy) = ((bx - 512.0).abs(), (by - 208.0).abs());
        // 四芒：菱形臂（|dx|/44 + |dy|/40 <= 1 太胖，用十字收窄：主轴窄次轴宽）
        dx / 44.0 + dy / 40.0 <= 1.0 && (dx <= 44.0 || dy <= 12.0)
    };
    for y in 0..size {
        for x in 0..size {
            let nx = (x as f64 + 0.5) / s;
            let ny = (y as f64 + 0.5) / s;
            let in_outer = in_tri(nx, ny, outer[0], outer[1], outer[2]);
            let in_counter = in_tri(nx, ny, counter[0], counter[1], counter[2]);
            let inside = (in_outer && !in_counter) || (in_counter && bar(nx, ny)) || spark(nx, ny);
            let a = if inside { 255 } else { 0 };
            rgba.extend_from_slice(&[0, 0, 0, a]);
        }
    }
    rgba
}

/// popup 定位（物理像素，屏幕本地坐标系）：托盘正下方水平居中；屏幕右缘夹取；
/// 下方放不下（Windows 底部任务栏托盘）时翻转到托盘上方。screen=None 不夹取。
pub fn popup_origin(
    tray: (f64, f64, f64, f64),
    popup: (f64, f64),
    screen: Option<(f64, f64)>,
) -> (f64, f64) {
    let (tx, ty, tw, th) = tray;
    let (pw, ph) = popup;
    let mut x = tx + tw / 2.0 - pw / 2.0;
    let mut y = ty + th + EDGE_GAP;
    if let Some((sw, sh)) = screen {
        x = x.clamp(EDGE_GAP, (sw - pw - EDGE_GAP).max(EDGE_GAP));
        if y + ph > sh - EDGE_GAP {
            y = ty - ph - EDGE_GAP;
        }
    }
    (x, y)
}

/// tauri Rect → 物理像素四元组（x, y, w, h）；Logical 分量按 scale 折算
pub fn rect_to_physical(rect: tauri::Rect, scale: f64) -> (f64, f64, f64, f64) {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    match (rect.position, rect.size) {
        (Position::Physical(p), Size::Physical(s)) => {
            (p.x as f64, p.y as f64, s.width as f64, s.height as f64)
        }
        (Position::Physical(p), Size::Logical(s)) => {
            (p.x as f64, p.y as f64, s.width * scale, s.height * scale)
        }
        (Position::Logical(p), Size::Physical(s)) => {
            (p.x * scale, p.y * scale, s.width as f64, s.height as f64)
        }
        (Position::Logical(p), Size::Logical(s)) => {
            (p.x * scale, p.y * scale, s.width * scale, s.height * scale)
        }
    }
}

// -- 壳接线 -------------------------------------------------------------------

/// 建托盘：菜单（右键）+ 图标 + 事件（左键 popup、菜单命令分发）
pub fn build_tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let menu = Menu::new(app)?;
    for (id, label) in menu_spec() {
        menu.append(&MenuItem::with_id(app, id, label, true, None::<&str>)?)?;
    }
    let icon = tauri::image::Image::new_owned(tray_icon_rgba(TRAY_ICON_PX), TRAY_ICON_PX, TRAY_ICON_PX);
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("applift")
        .menu(&menu)
        // 左键留给 popup（默认左键也弹菜单）；右键仍弹菜单
        .show_menu_on_left_click(false)
        // macOS：按 alpha 蒙版渲染系统单色（随明暗外观）；Windows/Linux 忽略
        .icon_as_template(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open_main" => show_main(app),
            "refresh_now" => request_refresh(app), // 自带后台线程（HTTP/锁不占主线程）
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                // 后台线程处理：current_port 抢 supervisor 锁（启动期 ensure_started 持锁可达秒级），
                // 窗口创建/定位亦非必须主线程同步
                let app = tray.app_handle().clone();
                std::thread::spawn(move || toggle_popup(&app, Some(rect)));
            }
        })
        .build(app)
}

/// 唤起主窗口（show + unminimize + focus）：菜单/单例二启/Reopen/open_main 共用
pub(crate) fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 菜单「立即刷新」：POST /api/refresh 触发服务端立即轮询（未就绪时记日志）。
/// 后台线程执行：HTTP 超时 1.5s + supervisor 锁等待，不占主线程。
pub(crate) fn request_refresh(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<ShellState>();
        let ok = state
            .supervisor
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| s.request_refresh())
            .unwrap_or(false);
        if !ok {
            eprintln!("[shell] 立即刷新未送达：ui-server 未就绪");
        }
    });
}

fn current_port(app: &AppHandle) -> Option<u16> {
    let state = app.state::<ShellState>();
    let port = state.supervisor.lock().unwrap().as_ref().and_then(|s| s.port());
    port
}

/// 左键托盘：popup 可见→隐藏；否则显示（无 rect 时贴主屏右上角）
fn toggle_popup(app: &AppHandle, rect: Option<tauri::Rect>) {
    if let Some(win) = app.get_webview_window(POPUP_LABEL) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
            return;
        }
        // 服务未就绪（无端口）：陈旧 popup 不再展示，与首建分支同款落回主窗
        if current_port(app).is_none() {
            let _ = win.hide();
            show_main(app);
            return;
        }
        position_and_show(app, &win, rect);
        return;
    }
    // 服务未就绪（无端口可注入）→ 落回主窗（startup 态展示）
    if current_port(app).is_none() {
        show_main(app);
        return;
    }
    // 首载仅 hash 路由（WebviewUrl::App 不带查询串）；端口注入交给 position_and_show 的导航
    let url = WebviewUrl::App("index.html#/popup".into());
    match WebviewWindowBuilder::new(app, POPUP_LABEL, url)
        .title("applift")
        .inner_size(POPUP_SIZE.0, POPUP_SIZE.1)
        .decorations(false)
        .shadow(true)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .build()
    {
        Ok(win) => position_and_show(app, &win, rect),
        Err(e) => {
            eprintln!("[shell] popup 窗口创建失败：{e}");
            show_main(app);
        }
    }
}

/// popup URL 判定（精确 kv）：fragment 为 /popup 且 query 含 `serverPort=<port>` 精确键值
pub(crate) fn popup_url_fresh(fragment: Option<&str>, query: Option<&str>, port: u16) -> bool {
    let want = format!("serverPort={port}");
    fragment == Some("/popup") && query.is_some_and(|q| q.split('&').any(|kv| kv == want))
}

/// popup 定位 + URL 校正（端口变化后重导航）+ 显示聚焦
fn position_and_show(app: &AppHandle, win: &WebviewWindow, rect: Option<tauri::Rect>) {
    if let Some(port) = current_port(app) {
        let fresh = match win.url() {
            Ok(u) => popup_url_fresh(u.fragment(), u.query(), port),
            Err(_) => false,
        };
        if !fresh {
            super::navigate(win, &format!("index.html?serverPort={port}#/popup"));
        }
    }
    let scale = win.scale_factor().unwrap_or(1.0);
    let (pw, ph) = (POPUP_SIZE.0 * scale, POPUP_SIZE.1 * scale);
    let monitor = app.primary_monitor().ok().flatten();
    // 屏幕本地坐标 + 显示器原点（多屏时主屏原点通常即全局原点）
    let screen = monitor.as_ref().map(|m| (m.size().width as f64, m.size().height as f64));
    let origin = monitor.as_ref().map(|m| (m.position().x as f64, m.position().y as f64));
    let (x, y) = match rect.map(|r| rect_to_physical(r, scale)) {
        Some(tray) => {
            let (mut lx, ly) = popup_origin(tray, (pw, ph), screen);
            if let Some((ox, oy)) = origin {
                lx += ox;
                (lx, ly + oy)
            } else {
                (lx, ly)
            }
        }
        // 无 rect（防御路径）：主屏右上角
        None => match (screen, origin) {
            (Some((sw, _)), Some((ox, oy))) => (ox + sw - pw - EDGE_GAP, oy + EDGE_GAP),
            (Some((sw, _)), None) => (sw - pw - EDGE_GAP, EDGE_GAP),
            _ => (0.0, 0.0),
        },
    };
    let _ = win.set_position(Position::Physical(PhysicalPosition::new(x as i32, y as i32)));
    let _ = win.show();
    let _ = win.set_focus();
}



#[cfg(test)]
mod tests {
    use super::*;
    use tauri::{LogicalPosition, PhysicalSize};

    #[test]
    fn badge_title_folds_and_clears() {
        assert_eq!(badge_title(0), None); // 0 = 清角标
        assert_eq!(badge_title(1).as_deref(), Some("1"));
        assert_eq!(badge_title(99).as_deref(), Some("99"));
        assert_eq!(badge_title(100).as_deref(), Some("99+"));
        assert_eq!(badge_title(u32::MAX).as_deref(), Some("99+"));
    }

    #[test]
    fn menu_spec_ids_stable() {
        let spec = menu_spec();
        assert_eq!(spec[0], ("open_main", "打开主窗口"));
        assert_eq!(spec[1], ("refresh_now", "立即刷新"));
        assert_eq!(spec[2], ("quit", "退出 applift"));
        // id 唯一（分发键）
        let ids: Vec<&str> = spec.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids.len(), 3);
    }

    #[test]
    fn tray_icon_is_alpha_prism_a() {
        let size = 128u32;
        let rgba = tray_icon_rgba(size);
        assert_eq!(rgba.len(), (size * size * 4) as usize);
        let px = |nx: f64, ny: f64| -> u8 {
            let x = ((nx * size as f64) as u32).min(size - 1);
            let y = ((ny * size as f64) as u32).min(size - 1);
            rgba[(y * size + x) as usize * 4 + 3]
        };
        // 归一化坐标 → brand 1024 坐标的采样点（n 的逆变换：brand = (n*0.88+0.06)*1024）
        let p = |bx: f64, by: f64| ((bx / 1024.0 - 0.06) / 0.88, (by / 1024.0 - 0.06) / 0.88);
        let (ax, ay) = p(512.0, 300.0);
        assert!(px(ax, ay) > 0, "A 顶点区实心");
        let (lx, ly) = p(340.0, 700.0);
        assert!(px(lx, ly) > 0, "左腿实心");
        let (rx, ry) = p(690.0, 700.0);
        assert!(px(rx, ry) > 0, "右腿实心");
        let (bx, by) = p(512.0, 550.0);
        assert!(px(bx, by) > 0, "横梁实心");
        let (cx, cy) = p(512.0, 470.0);
        assert_eq!(px(cx, cy), 0, "字腔上部掏空");
        let (ex, ey) = p(150.0, 700.0);
        assert_eq!(px(ex, ey), 0, "左下角外部透明");
        let (sx, sy) = p(512.0, 208.0); // 顶部脱离四芒火花中心
        assert!(px(sx, sy) > 0, "四芒火花中心实心");
        // RGB 全 0（macOS template 按 alpha 取形）
        assert!(rgba.chunks_exact(4).all(|c| c[0] == 0 && c[1] == 0 && c[2] == 0));
    }

    #[test]
    fn popup_origin_centers_below_tray() {
        // macOS 菜单栏：托盘在屏幕顶部 → popup 正下方
        let (x, y) = popup_origin((500.0, 0.0, 44.0, 44.0), (360.0, 480.0), Some((1920.0, 1080.0)));
        assert!((x - (500.0 + 22.0 - 180.0)).abs() < 1e-9);
        assert!((y - (44.0 + EDGE_GAP)).abs() < 1e-9);
    }

    #[test]
    fn popup_origin_clamps_left_and_flips_above() {
        // 托盘贴左缘：x 夹取到 EDGE_GAP
        let (x, _) = popup_origin((0.0, 1040.0, 44.0, 44.0), (360.0, 480.0), Some((1920.0, 1080.0)));
        assert!((x - EDGE_GAP).abs() < 1e-9);
        // Windows 底部任务栏托盘：下方放不下 → 翻转到托盘上方
        let (_, y) = popup_origin((1000.0, 1040.0, 44.0, 44.0), (360.0, 480.0), Some((1920.0, 1080.0)));
        assert!((y - (1040.0 - 480.0 - EDGE_GAP)).abs() < 1e-9);
        // 无屏幕信息：不夹取不翻转
        let (x, y) = popup_origin((0.0, 1040.0, 44.0, 44.0), (360.0, 480.0), None);
        assert!(x < 0.0);
        assert!((y - (1040.0 + 44.0 + EDGE_GAP)).abs() < 1e-9);
    }

    #[test]
    fn rect_to_physical_scales_logical() {
        let phys = tauri::Rect {
            position: Position::Physical(PhysicalPosition::new(10, 20)),
            size: Size::Physical(PhysicalSize::new(44, 44)),
        };
        assert_eq!(rect_to_physical(phys, 2.0), (10.0, 20.0, 44.0, 44.0));
        let mixed = tauri::Rect {
            position: Position::Logical(LogicalPosition::new(10.0, 20.0)),
            size: Size::Physical(PhysicalSize::new(44, 44)),
        };
        assert_eq!(rect_to_physical(mixed, 2.0), (20.0, 40.0, 44.0, 44.0));
    }

    #[test]
    fn popup_url_fresh_requires_exact_kv() {
        assert!(popup_url_fresh(Some("/popup"), Some("serverPort=47600"), 47600));
        assert!(popup_url_fresh(Some("/popup"), Some("a=1&serverPort=5&b=2"), 5), "多键精确命中");
        assert!(!popup_url_fresh(Some("/popup"), Some("serverPort=12"), 123), "前缀误判拒绝");
        assert!(!popup_url_fresh(Some("/popup"), Some("xserverPort=123"), 123), "伪键拒绝");
        assert!(!popup_url_fresh(Some("/overview"), Some("serverPort=123"), 123), "fragment 不符");
        assert!(!popup_url_fresh(None, Some("serverPort=123"), 123));
        assert!(!popup_url_fresh(Some("/popup"), None, 123));
    }
}
