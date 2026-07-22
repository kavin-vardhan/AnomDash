#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
fn read_config() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe
        .parent()
        .ok_or_else(|| "could not resolve the executable directory".to_string())?;
    std::fs::read_to_string(dir.join("config.json")).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![read_config])
        .run(tauri::generate_context!())
        .expect("error while running the Anomaly Dashboard");
}
