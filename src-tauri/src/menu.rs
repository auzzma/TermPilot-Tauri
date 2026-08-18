use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let about = MenuItemBuilder::with_id("about", "About TermPilot").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "Settings...")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let application = SubmenuBuilder::new(app, "TermPilot")
        .item(&about)
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .separator()
        .quit()
        .build()?;

    let new_window = MenuItemBuilder::with_id("new-window", "New Window")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let new_local = MenuItemBuilder::with_id("new-local", "New Local Shell")
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    let quick_connect = MenuItemBuilder::with_id("quick-connect", "Quick Connect...")
        .accelerator("CmdOrCtrl+K")
        .build(app)?;
    let file = SubmenuBuilder::new(app, "File")
        .items(&[&new_window, &new_local, &quick_connect])
        .build()?;

    let split_vertical = MenuItemBuilder::with_id("split-vertical", "Split Vertically")
        .accelerator("CmdOrCtrl+Shift+D")
        .build(app)?;
    let split_horizontal = MenuItemBuilder::with_id("split-horizontal", "Split Horizontally")
        .accelerator("CmdOrCtrl+D")
        .build(app)?;
    let close_workspace = MenuItemBuilder::with_id("close-workspace", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let session = SubmenuBuilder::new(app, "Session")
        .items(&[&split_vertical, &split_horizontal])
        .separator()
        .item(&close_workspace)
        .build()?;

    MenuBuilder::new(app)
        .items(&[&application, &file, &session])
        .build()
}

pub fn handle(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let Some(window) = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
    else {
        return;
    };
    let _ = window.emit("app-menu", event.id().as_ref());
}
