pub mod discovery;
pub mod generate;
pub mod overlay;
pub mod sessions;
pub mod settings;
pub mod video;

use settings::{PublicSettings, SettingsStore};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

pub struct AppState {
    pub settings: Arc<SettingsStore>,
}

fn version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn allow_root(app: &AppHandle, root: &str) {
    let _ = app.asset_protocol_scope().allow_directory(PathBuf::from(root), true);
}

#[tauri::command]
fn get_settings(app: AppHandle, state: State<'_, AppState>) -> PublicSettings {
    state.settings.public(&version(&app))
}

#[tauri::command]
fn set_captures_root(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<PublicSettings, String> {
    state.settings.set_captures_root(&path)?;
    allow_root(&app, &state.settings.get().captures_root);
    let _ = app.emit("sessions-changed", ());
    Ok(state.settings.public(&version(&app)))
}

#[tauri::command]
fn set_manual_connection(app: AppHandle, state: State<'_, AppState>, url: String, token: String) -> PublicSettings {
    state.settings.set_manual(&url, &token);
    state.settings.public(&version(&app))
}

#[tauri::command]
async fn pick_folder(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let start = state.settings.get().captures_root;
    let mut dialog = app.dialog().file().set_title("Choose where captures are saved");
    if !start.is_empty() {
        dialog = dialog.set_directory(&start);
    }
    let picked = dialog.blocking_pick_folder();
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
async fn discover_game(state: State<'_, AppState>) -> Result<discovery::Discovery, String> {
    let port = state.settings.get().port;
    Ok(tauri::async_runtime::spawn_blocking(move || discovery::discover(port)).await.map_err(|e| e.to_string())?)
}

#[tauri::command]
async fn list_sessions(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<sessions::SessionInfo>, String> {
    let s = state.settings.get();
    allow_root(&app, &s.captures_root);
    let root = PathBuf::from(&s.captures_root);
    let first = s.first_run_ms;
    tauri::async_runtime::spawn_blocking(move || sessions::list(&root, first)).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn generate(app: AppHandle, req: generate::GenerateRequest) -> Result<(), String> {
    let handle = app.clone();
    generate::run(req, move |p| {
        let _ = handle.emit("generate-progress", p);
    });
    Ok(())
}

#[tauri::command]
fn cancel_generate() {
    generate::CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("{path} no longer exists"));
    }
    std::process::Command::new("explorer.exe").arg(&p).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_session(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let root = PathBuf::from(state.settings.get().captures_root);
    let inside = p.parent().map(|par| par == root.as_path()).unwrap_or(false);
    if !inside || !sessions::is_session_dir(&p) {
        return Err("Only captures inside the captures folder can be removed.".into());
    }
    trash::delete(&p).map_err(|e| format!("Couldn't move it to the Recycle Bin: {e}"))?;
    let _ = app.emit("sessions-changed", ());
    Ok(())
}

fn start_finalizer(app: AppHandle, settings: Arc<SettingsStore>) {
    std::thread::spawn(move || loop {
        let s = settings.get();
        let root = PathBuf::from(&s.captures_root);
        if root.is_dir() && !generate::BUSY.load(std::sync::atomic::Ordering::SeqCst) {
            if sessions::finalize_all(&root, s.first_run_ms) {
                let _ = app.emit("sessions-changed", ());
            }
        }
        std::thread::sleep(Duration::from_secs(3));
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir().join("AnomalyDashboard"));
            let docs = app.path().document_dir().ok();
            let store = Arc::new(SettingsStore::load(&config_dir, docs));
            let root = store.get().captures_root;
            let handle = app.handle().clone();
            allow_root(&handle, &root);
            start_finalizer(handle, store.clone());
            app.manage(AppState { settings: store });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_captures_root,
            set_manual_connection,
            pick_folder,
            discover_game,
            list_sessions,
            generate,
            cancel_generate,
            open_path,
            delete_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Anomaly Dashboard");
}
