// Thin native host for the GenesisCA web frontend: loads the built SPA in a
// native window and provides native Save As (the dialog plugin) + a file-write
// command, since WebView2 silently drops the browser blob-download path.
// See docs/IMPACT_MAP_PWA_INSTALL.md §C.

/// Write text to an absolute path chosen by the user via the native Save As
/// dialog. App-defined commands don't need an ACL capability entry.
#[tauri::command]
fn save_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_text_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
