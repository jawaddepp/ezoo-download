//! Native Windows tray and macOS menu bar access while the main window is closed.

#[cfg_attr(not(windows), allow(dead_code))]
pub enum TrayAction {
    Show,
    AddUrl,
    ResumeAll,
    StopAll,
    ToggleLimiter,
    Scheduler,
    Options,
    About,
    Exit,
}

/// What was clicked on the small icon of a hidden download window.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DownloadAction {
    Show,
    Pause,
}

/// 32 x 32 RGBA picture for a hidden download: a blue "E" with a green
/// bar under it showing how far it is (`None`: size unknown, no bar).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn download_icon(progress: Option<f32>) -> Vec<u8> {
    const N: usize = 32;
    let mut px = vec![0u8; N * N * 4];
    let mut put = |x: usize, y: usize, c: [u8; 4]| {
        let i = (y * N + x) * 4;
        px[i..i + 4].copy_from_slice(&c);
    };
    let blue = [0x1f, 0x6f, 0xeb, 0xff];
    let white = [0xff, 0xff, 0xff, 0xff];
    for y in 0..N {
        for x in 0..N {
            // a square with round corners (radius 6)
            let (dx, dy) = (x.min(N - 1 - x), y.min(N - 1 - y));
            let corner = dx < 6 && dy < 6 && {
                let (cx, cy) = (6.0 - dx as f32 - 0.5, 6.0 - dy as f32 - 0.5);
                cx * cx + cy * cy > 36.0
            };
            if !corner {
                put(x, y, blue);
            }
        }
    }
    let rect = |put: &mut dyn FnMut(usize, usize, [u8; 4]), x0: usize, y0: usize, x1: usize, y1: usize, c: [u8; 4]| {
        for y in y0..y1 {
            for x in x0..x1 {
                put(x, y, c);
            }
        }
    };
    // the letter
    rect(&mut put, 9, 4, 13, 22, white);
    rect(&mut put, 9, 4, 23, 8, white);
    rect(&mut put, 9, 11, 21, 15, white);
    rect(&mut put, 9, 18, 23, 22, white);
    if let Some(p) = progress {
        let p = p.clamp(0.0, 1.0);
        rect(&mut put, 3, 24, 29, 30, [0x0b, 0x2a, 0x5c, 0xff]);
        let end = 4 + ((24.0 * p).round() as usize);
        rect(&mut put, 4, 25, end, 29, [0x3d, 0xdc, 0x5b, 0xff]);
    }
    px
}

#[cfg(windows)]
mod imp {
    use super::{DownloadAction, TrayAction};
    use std::collections::HashMap;
    use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem};
    use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

    const MAIN_ID: &str = "ezoo-main";
    const DL_PREFIX: &str = "ezoo-dl-";

    /// The icon of one hidden download window.
    struct Mini {
        icon: TrayIcon,
        show: MenuId,
        pause: MenuId,
        /// what it shows now, to change it only when needed
        step: Option<u32>,
        tip: String,
    }

    thread_local! {
        static HIDDEN: std::cell::RefCell<HashMap<u64, Mini>> = std::cell::RefCell::new(HashMap::new());
        static PENDING: std::cell::RefCell<Vec<(u64, DownloadAction)>> = const { std::cell::RefCell::new(Vec::new()) };
    }

    fn icon_for(progress: Option<f32>) -> Option<Icon> {
        Icon::from_rgba(super::download_icon(progress), 32, 32).ok()
    }

    /// A small icon next to the clock for a download whose window was hidden.
    pub fn show_download(id: u64, tip: &str, progress: Option<f32>, labels: (&str, &str)) -> bool {
        if HIDDEN.with(|h| h.borrow().contains_key(&id)) {
            return true;
        }
        let menu = Menu::new();
        let show = MenuItem::new(labels.0, true, None);
        let pause = MenuItem::new(labels.1, true, None);
        if menu.append(&show).is_err() || menu.append(&pause).is_err() {
            return false;
        }
        let Some(icon) = icon_for(progress) else { return false };
        let built = TrayIconBuilder::new()
            .with_id(format!("{DL_PREFIX}{id}"))
            .with_tooltip(super::short_tip(tip))
            .with_icon(icon)
            .with_menu(Box::new(menu))
            .with_menu_on_left_click(false)
            .build();
        let Ok(icon) = built else { return false };
        let mini = Mini {
            icon,
            show: show.id().clone(),
            pause: pause.id().clone(),
            step: progress.map(super::step_of),
            tip: tip.to_string(),
        };
        HIDDEN.with(|h| h.borrow_mut().insert(id, mini));
        true
    }

    /// New numbers for its icon and its hint.
    pub fn update_download(id: u64, tip: &str, progress: Option<f32>) {
        HIDDEN.with(|h| {
            if let Some(m) = h.borrow_mut().get_mut(&id) {
                let step = progress.map(super::step_of);
                if step != m.step {
                    m.step = step;
                    let _ = m.icon.set_icon(icon_for(progress));
                }
                if m.tip != tip {
                    m.tip = tip.to_string();
                    let _ = m.icon.set_tooltip(Some(super::short_tip(tip)));
                }
            }
        });
    }

    /// Its window is back (or it is done): the icon goes.
    pub fn remove_download(id: u64) {
        HIDDEN.with(|h| h.borrow_mut().remove(&id));
    }

    /// Clicks on the icons of hidden downloads since the last call.
    pub fn take_download_actions() -> Vec<(u64, DownloadAction)> {
        PENDING.with(|p| std::mem::take(&mut *p.borrow_mut()))
    }

    pub struct Tray {
        _icon: TrayIcon,
        limiter: CheckMenuItem,
        ids: Vec<(MenuId, fn() -> TrayAction)>,
    }

    impl Tray {
        pub fn new() -> Option<Tray> {
            let menu = Menu::new();
            let show = MenuItem::new("Restore Mac Downloader", true, None);
            let add = MenuItem::new("Add new download…", true, None);
            let resume = MenuItem::new("Resume all downloads", true, None);
            let stop = MenuItem::new("Stop all downloads", true, None);
            let limiter = CheckMenuItem::new("Speed Limiter", true, false, None);
            let sched = MenuItem::new("Scheduler…", true, None);
            let options = MenuItem::new("Options…", true, None);
            let about = MenuItem::new("About", true, None);
            let exit = MenuItem::new("Exit", true, None);
            menu.append(&show).ok()?;
            menu.append(&PredefinedMenuItem::separator()).ok()?;
            menu.append(&add).ok()?;
            menu.append(&resume).ok()?;
            menu.append(&stop).ok()?;
            menu.append(&PredefinedMenuItem::separator()).ok()?;
            menu.append(&limiter).ok()?;
            menu.append(&sched).ok()?;
            menu.append(&options).ok()?;
            menu.append(&PredefinedMenuItem::separator()).ok()?;
            menu.append(&about).ok()?;
            menu.append(&exit).ok()?;
            let icon = Icon::from_rgba(include_bytes!("../ui/tray32.rgba").to_vec(), 32, 32).ok()?;
            let tray = TrayIconBuilder::new()
                .with_id(MAIN_ID)
                .with_tooltip("Mac Downloader")
                .with_icon(icon)
                .with_menu(Box::new(menu))
                // the menu on a right click only; a double click opens the window
                .with_menu_on_left_click(false)
                .build()
                .ok()?;
            let ids: Vec<(MenuId, fn() -> TrayAction)> = vec![
                (show.id().clone(), || TrayAction::Show),
                (add.id().clone(), || TrayAction::AddUrl),
                (resume.id().clone(), || TrayAction::ResumeAll),
                (stop.id().clone(), || TrayAction::StopAll),
                (limiter.id().clone(), || TrayAction::ToggleLimiter),
                (sched.id().clone(), || TrayAction::Scheduler),
                (options.id().clone(), || TrayAction::Options),
                (about.id().clone(), || TrayAction::About),
                (exit.id().clone(), || TrayAction::Exit),
            ];
            Some(Tray { _icon: tray, limiter, ids })
        }

        /// Clicks since the last call (those on hidden downloads go to
        /// [`take_download_actions`]).
        pub fn poll(&self) -> Vec<TrayAction> {
            let mut out = Vec::new();
            while let Ok(ev) = TrayIconEvent::receiver().try_recv() {
                let id = ev.id().0.clone();
                if let Some(dl) = id.strip_prefix(DL_PREFIX).and_then(|n| n.parse::<u64>().ok()) {
                    // one click on a hidden download's icon: its window
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        PENDING.with(|p| p.borrow_mut().push((dl, DownloadAction::Show)));
                    }
                    continue;
                }
                // left double click: the window (the menu is on the right button)
                if let TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } = ev {
                    out.push(TrayAction::Show);
                }
            }
            while let Ok(ev) = MenuEvent::receiver().try_recv() {
                if let Some((_, make)) = self.ids.iter().find(|(id, _)| *id == ev.id) {
                    out.push(make());
                    continue;
                }
                let hit = HIDDEN.with(|h| {
                    h.borrow().iter().find_map(|(dl, m)| {
                        if ev.id == m.show {
                            Some((*dl, DownloadAction::Show))
                        } else if ev.id == m.pause {
                            Some((*dl, DownloadAction::Pause))
                        } else {
                            None
                        }
                    })
                });
                if let Some(hit) = hit {
                    PENDING.with(|p| p.borrow_mut().push(hit));
                }
            }
            out
        }

        /// Keep the check mark of "Speed Limiter" in step with the app.
        pub fn set_limiter(&self, on: bool) {
            if self.limiter.is_checked() != on {
                self.limiter.set_checked(on);
            }
        }

        pub fn is_available(&self) -> bool {
            true
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{DownloadAction, TrayAction};
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;
    use objc2::{define_class, msg_send, rc::Retained, runtime::{AnyObject, Sel}, sel, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSAccessibility, NSImage, NSMenu, NSMenuItem, NSStatusBar, NSStatusItem, NSSquareStatusItemLength};
    use objc2_foundation::{NSObject, NSObjectProtocol, NSSize, NSString};

    type ActionHandler = Rc<dyn Fn(TrayAction)>;
    thread_local! {
        static HANDLER: RefCell<Option<ActionHandler>> = RefCell::new(None);
        static PENDING: RefCell<Vec<TrayAction>> = const { RefCell::new(Vec::new()) };
    }

    fn dispatch(action: TrayAction) {
        // Defer Slint changes until AppKit has finished tracking the menu. No
        // polling or shared native menu event handler is needed for these actions.
        let _ = slint::invoke_from_event_loop(move || {
            let handler = HANDLER.with(|h| h.borrow().clone());
            if let Some(handler) = handler {
                handler(action);
            } else {
                PENDING.with(|p| p.borrow_mut().push(action));
            }
        });
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements. This target has no
        // custom deallocation and is only created/accessed on the main thread.
        #[unsafe(super = NSObject)]
        #[thread_kind = MainThreadOnly]
        #[name = "MacDownloaderStatusTarget"]
        #[ivars = ()]
        struct StatusTarget;

        unsafe impl NSObjectProtocol for StatusTarget {}

        impl StatusTarget {
            #[unsafe(method(showDownloads:))]
            fn show_downloads(&self, _sender: Option<&AnyObject>) { dispatch(TrayAction::Show); }
            #[unsafe(method(newDownload:))]
            fn new_download(&self, _sender: Option<&AnyObject>) { dispatch(TrayAction::AddUrl); }
            #[unsafe(method(showSettings:))]
            fn show_settings(&self, _sender: Option<&AnyObject>) { dispatch(TrayAction::Options); }
            #[unsafe(method(quitDownloader:))]
            fn quit_downloader(&self, _sender: Option<&AnyObject>) { dispatch(TrayAction::Exit); }
        }
    );

    struct NativeTray {
        status: Retained<NSStatusItem>,
        _menu: Retained<NSMenu>,
        // NSMenuItem targets are not retained by AppKit.
        _target: Retained<StatusTarget>,
    }

    impl NativeTray {
        fn new() -> Option<Self> {
            let mtm = MainThreadMarker::new()?;
            let label = NSString::from_str("Mac Downloader");
            let image = NSImage::imageWithSystemSymbolName_accessibilityDescription(
                &NSString::from_str("arrow.down.to.line"), Some(&label),
            )?;
            image.setTemplate(true);
            image.setSize(NSSize::new(18.0, 18.0));
            let target: Retained<StatusTarget> = {
                let allocated = StatusTarget::alloc(mtm).set_ivars(());
                // SAFETY: NSObject's init returns an initialized instance.
                unsafe { msg_send![super(allocated), init] }
            };
            let menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), &label);
            menu.setAutoenablesItems(false);
            let add_item = |title: &str, selector: Sel| {
                // SAFETY: Each selector is implemented on StatusTarget with the
                // standard one-sender action signature; target outlives the menu.
                let item = unsafe {
                    let item = NSMenuItem::initWithTitle_action_keyEquivalent(
                        NSMenuItem::alloc(mtm), &NSString::from_str(&crate::t(title)),
                        Some(selector), &NSString::from_str(""),
                    );
                    item.setTarget(Some(&target));
                    item
                };
                menu.addItem(&item);
            };
            add_item("Show Mac Downloader", sel!(showDownloads:));
            add_item("New Download…", sel!(newDownload:));
            menu.addItem(&NSMenuItem::separatorItem(mtm));
            add_item("Settings…", sel!(showSettings:));
            menu.addItem(&NSMenuItem::separatorItem(mtm));
            add_item("Quit Mac Downloader", sel!(quitDownloader:));

            let status = NSStatusBar::systemStatusBar().statusItemWithLength(NSSquareStatusItemLength);
            let Some(button) = status.button(mtm) else {
                NSStatusBar::systemStatusBar().removeStatusItem(&status);
                return None;
            };
            button.setImage(Some(&image));
            button.setToolTip(Some(&label));
            button.setAccessibilityLabel(Some(&label));
            status.setMenu(Some(&menu));
            Some(Self { status, _menu: menu, _target: target })
        }
    }

    impl Drop for NativeTray {
        fn drop(&mut self) {
            NSStatusBar::systemStatusBar().removeStatusItem(&self.status);
        }
    }

    pub struct Tray {
        native: RefCell<Option<NativeTray>>,
        initialized: Cell<bool>,
    }

    impl Drop for Tray {
        fn drop(&mut self) {
            HANDLER.with(|h| h.borrow_mut().take());
            PENDING.with(|p| p.borrow_mut().clear());
        }
    }

    impl Tray {
        pub fn new() -> Option<Self> {
            // Create AppKit status items only after Slint's main event loop has
            // started. The first existing refresh tick performs initialization.
            MainThreadMarker::new()?;
            Some(Self { native: RefCell::new(None), initialized: Cell::new(false) })
        }

        pub fn set_action_handler(&self, handler: ActionHandler) {
            HANDLER.with(|h| *h.borrow_mut() = Some(handler));
        }

        pub fn is_available(&self) -> bool {
            self.native.borrow().is_some()
        }

        pub fn poll(&self) -> Vec<TrayAction> {
            if !self.initialized.replace(true) {
                *self.native.borrow_mut() = NativeTray::new();
                if !self.is_available() {
                    // Never leave a startup instance inaccessible if the status
                    // item couldn't be created. The close policy can then quit.
                    return vec![TrayAction::Show];
                }
            }
            PENDING.with(|p| std::mem::take(&mut *p.borrow_mut()))
        }

        pub fn set_limiter(&self, _on: bool) {}
    }

    // A single menu bar item keeps background operation discoverable without
    // creating one menu bar icon per download.
    pub fn show_download(_id: u64, _tip: &str, _progress: Option<f32>, _labels: (&str, &str)) -> bool { false }
    pub fn update_download(_id: u64, _tip: &str, _progress: Option<f32>) {}
    pub fn remove_download(_id: u64) {}
    pub fn take_download_actions() -> Vec<(u64, DownloadAction)> { Vec::new() }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use super::{DownloadAction, TrayAction};
    pub fn show_download(_id: u64, _tip: &str, _progress: Option<f32>, _labels: (&str, &str)) -> bool {
        false
    }
    pub fn update_download(_id: u64, _tip: &str, _progress: Option<f32>) {}
    pub fn remove_download(_id: u64) {}
    pub fn take_download_actions() -> Vec<(u64, DownloadAction)> {
        Vec::new()
    }
    pub struct Tray;
    impl Tray {
        pub fn new() -> Option<Tray> {
            None
        }
        pub fn poll(&self) -> Vec<TrayAction> {
            Vec::new()
        }
        pub fn set_limiter(&self, _on: bool) {}
        pub fn is_available(&self) -> bool { false }
    }
}

pub use imp::{remove_download, show_download, take_download_actions, update_download, Tray};

/// Windows shows at most 127 characters in an icon's hint.
#[cfg_attr(not(windows), allow(dead_code))]
fn short_tip(tip: &str) -> String {
    if tip.chars().count() <= 120 {
        tip.to_string()
    } else {
        tip.chars().take(119).chain(Some('…')).collect()
    }
}

/// The bar changes in steps of 1/24 (its width in dots).
#[cfg_attr(not(windows), allow(dead_code))]
fn step_of(p: f32) -> u32 {
    (p.clamp(0.0, 1.0) * 24.0).round() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_icon_shows_the_progress() {
        let empty = download_icon(Some(0.0));
        let half = download_icon(Some(0.5));
        assert_eq!(empty.len(), 32 * 32 * 4);
        let green = |px: &[u8], x: usize| px[(27 * 32 + x) * 4 + 1] == 0xdc;
        assert!(!green(&empty, 10) && green(&half, 10) && !green(&half, 26));
        // corners are see-through, the letter is white
        assert_eq!(half[3], 0);
        assert_eq!(&half[(5 * 32 + 10) * 4..(5 * 32 + 10) * 4 + 4], &[255, 255, 255, 255]);
        assert_eq!(short_tip(&"x".repeat(300)).chars().count(), 120);
        assert_eq!(step_of(0.5), 12);
    }
}
