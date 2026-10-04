use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    #[serde(default)]
    pub captures_root: String,
    #[serde(default)]
    pub first_run_ms: i64,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub manual_url: String,
    #[serde(default)]
    pub manual_token: String,
}

fn default_port() -> u16 {
    8077
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicSettings {
    pub captures_root: String,
    pub port: u16,
    pub manual_url: String,
    pub manual_token: String,
    pub version: String,
}

pub struct SettingsStore {
    file: PathBuf,
    inner: Mutex<Stored>,
}

#[cfg(windows)]
fn fixed_drives() -> Vec<(String, u64)> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives};
    let mut out = Vec::new();
    let mask = unsafe { GetLogicalDrives() };
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let root = format!("{}:\\", (b'A' + i as u8) as char);
        let wide: Vec<u16> = std::ffi::OsStr::new(&root).encode_wide().chain(std::iter::once(0)).collect();
        let kind = unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) };
        if kind != 3 {
            continue;
        }
        let mut free: u64 = 0;
        let ok = unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free as *mut u64), None, None) };
        if ok.is_ok() {
            out.push((root, free));
        }
    }
    out
}

#[cfg(not(windows))]
fn fixed_drives() -> Vec<(String, u64)> {
    Vec::new()
}

fn default_root(_documents: Option<&Path>, config_dir: &Path) -> PathBuf {
    let profile = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(|| config_dir.to_path_buf());
    let system = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into()).to_uppercase();
    let system_root = format!("{}\\", system.trim_end_matches('\\'));
    let drives = fixed_drives();
    let sys_free = drives.iter().find(|(r, _)| r.eq_ignore_ascii_case(&system_root)).map(|(_, f)| *f).unwrap_or(0);
    let best = drives.iter().filter(|(r, _)| !r.eq_ignore_ascii_case(&system_root)).max_by_key(|(_, f)| *f).cloned();
    const GB: u64 = 1024 * 1024 * 1024;
    if let Some((root, free)) = best {
        if free >= 20 * GB && free > sys_free {
            return PathBuf::from(root).join("AnomalyCaptures");
        }
    }
    profile.join("AnomalyCaptures")
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl SettingsStore {
    pub fn load(config_dir: &Path, documents: Option<PathBuf>) -> Self {
        let file = config_dir.join("settings.json");
        let mut stored: Stored = std::fs::read_to_string(&file)
            .ok()
            .and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok())
            .unwrap_or(Stored {
                captures_root: String::new(),
                first_run_ms: 0,
                port: 8077,
                manual_url: String::new(),
                manual_token: String::new(),
            });
        let mut dirty = false;
        if stored.first_run_ms == 0 {
            stored.first_run_ms = now_ms();
            dirty = true;
        }
        if stored.captures_root.trim().is_empty() {
            stored.captures_root = default_root(documents.as_deref(), config_dir).to_string_lossy().to_string();
            dirty = true;
        }
        let _ = std::fs::create_dir_all(&stored.captures_root);
        let s = SettingsStore { file, inner: Mutex::new(stored) };
        if dirty {
            s.save();
        }
        s
    }

    fn save(&self) {
        let st = self.inner.lock().unwrap().clone();
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(&st) {
            let tmp = self.file.with_extension("json.tmp");
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, &self.file);
            }
        }
    }

    pub fn get(&self) -> Stored {
        self.inner.lock().unwrap().clone()
    }

    pub fn public(&self, version: &str) -> PublicSettings {
        let s = self.get();
        PublicSettings {
            captures_root: s.captures_root,
            port: s.port,
            manual_url: s.manual_url,
            manual_token: s.manual_token,
            version: version.to_string(),
        }
    }

    pub fn set_captures_root(&self, root: &str) -> Result<(), String> {
        let p = PathBuf::from(root);
        std::fs::create_dir_all(&p).map_err(|e| format!("Couldn't use that folder: {e}"))?;
        self.inner.lock().unwrap().captures_root = p.to_string_lossy().to_string();
        self.save();
        Ok(())
    }

    pub fn set_manual(&self, url: &str, token: &str) {
        {
            let mut s = self.inner.lock().unwrap();
            s.manual_url = url.trim().to_string();
            s.manual_token = token.trim().to_string();
        }
        self.save();
    }
}
