use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const STATE_DIR: &str = ".dashboard";
const PENDING_DIR: &str = "pending";
const MASK_DIR: &str = "target_mask";
const MASK_MAP: &str = "mask_map.json";
const PREVIEW_DIR: &str = "annotated";
const SETTLE: Duration = Duration::from_secs(4);
const FORCE_AFTER: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Serialize)]
pub struct EventRun {
    #[serde(rename = "type")]
    pub kind: String,
    pub runs: Vec<(u32, u32)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub path: String,
    pub created_ms: i64,
    pub complete: bool,
    pub finalized: bool,
    pub frames: u32,
    pub fps: f64,
    pub width: u32,
    pub height: u32,
    pub events: Vec<EventRun>,
    pub counts: BTreeMap<String, u32>,
    pub thumb: Option<String>,
    pub masks: String,
    pub mask_frames: u32,
    pub video: Option<String>,
    pub previews: u32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    #[serde(default)]
    pub finalized: bool,
    #[serde(default)]
    pub finalized_ms: i64,
    #[serde(default)]
    pub masks: String,
    #[serde(default)]
    pub video: Option<Value>,
    #[serde(default)]
    pub previews: Option<Value>,
}

pub struct VideoSpec {
    pub frames_dir: PathBuf,
    pub out_path: PathBuf,
    pub fps: f64,
}

fn ms_of(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn state_dir(session: &Path) -> PathBuf {
    session.join(STATE_DIR)
}

pub fn read_state(session: &Path) -> SessionState {
    fs::read_to_string(state_dir(session).join("state.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn write_state(session: &Path, st: &SessionState) -> Result<(), String> {
    let dir = ensure_state_dir(session)?;
    let text = serde_json::to_string_pretty(st).map_err(|e| e.to_string())?;
    fs::write(dir.join("state.json"), text).map_err(|e| format!("Couldn't save the capture's state: {e}"))
}

fn ensure_state_dir(session: &Path) -> Result<PathBuf, String> {
    let dir = state_dir(session);
    if !dir.is_dir() {
        fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create a working folder in the capture: {e}"))?;
        hide(&dir);
    }
    Ok(dir)
}

#[cfg(windows)]
fn hide(p: &Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetFileAttributesW, SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_FLAGS_AND_ATTRIBUTES, INVALID_FILE_ATTRIBUTES};
    let wide: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        let cur = GetFileAttributesW(PCWSTR(wide.as_ptr()));
        if cur == INVALID_FILE_ATTRIBUTES {
            return;
        }
        let _ = SetFileAttributesW(PCWSTR(wide.as_ptr()), FILE_FLAGS_AND_ATTRIBUTES(cur | FILE_ATTRIBUTE_HIDDEN.0));
    }
}

#[cfg(not(windows))]
fn hide(_p: &Path) {}

fn read_json(p: &Path) -> Option<Value> {
    let t = fs::read_to_string(p).ok()?;
    serde_json::from_str(t.trim_start_matches('\u{feff}')).ok()
}

fn frame_indices(v: &Value) -> Vec<u32> {
    let arr = if let Some(a) = v.get("frame_indices").and_then(|x| x.as_array()) {
        a.clone()
    } else if let Some(a) = v.as_array() {
        a.clone()
    } else {
        Vec::new()
    };
    let mut out: Vec<u32> = arr.iter().filter_map(|x| x.as_u64()).map(|x| x as u32).collect();
    out.sort_unstable();
    out.dedup();
    out
}

fn runs_of(idx: &[u32]) -> Vec<(u32, u32)> {
    let mut runs = Vec::new();
    let mut it = idx.iter().copied();
    if let Some(first) = it.next() {
        let (mut a, mut b) = (first, first);
        for x in it {
            if x == b + 1 {
                b = x;
            } else {
                runs.push((a, b));
                a = x;
                b = x;
            }
        }
        runs.push((a, b));
    }
    runs
}

fn count_files(dir: &Path, ext: &[&str]) -> u32 {
    fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| {
                    let p = e.path();
                    p.extension()
                        .and_then(|x| x.to_str())
                        .map(|x| ext.iter().any(|w| x.eq_ignore_ascii_case(w)))
                        .unwrap_or(false)
                })
                .count() as u32
        })
        .unwrap_or(0)
}

fn frame_path(frames_dir: &Path, idx: u32) -> Option<PathBuf> {
    for ext in ["png", "jpg", "jpeg"] {
        let p = frames_dir.join(format!("frame_{idx:05}.{ext}"));
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

pub fn video_spec(session: &Path) -> VideoSpec {
    let id = session.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ann = read_json(&session.join("annotation.json"));
    let video = ann.as_ref().and_then(|a| a.get("video"));
    let fps = video
        .and_then(|v| v.get("fps"))
        .and_then(|f| f.as_f64())
        .filter(|f| *f > 0.0 && f.is_finite())
        .map(|f| (f * 1000.0).round() / 1000.0)
        .unwrap_or(30.0);
    let frames_rel = video.and_then(|v| v.get("frames_dir")).and_then(|x| x.as_str()).unwrap_or("Actual_Frames").to_string();
    let video_rel = video
        .and_then(|v| v.get("path"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("Video_Clip/{id}.mp4"));
    VideoSpec {
        frames_dir: session.join(frames_rel.replace('/', "\\")),
        out_path: session.join(video_rel.replace('/', "\\")),
        fps,
    }
}

fn mask_status(session: &Path, eligible_unfinalized: bool, complete: bool) -> (String, u32) {
    let pending = state_dir(session).join(PENDING_DIR).join(MASK_DIR);
    let visible = session.join(MASK_DIR);
    if pending.is_dir() {
        return ("pending".into(), count_files(&pending, &["png"]));
    }
    if visible.is_dir() {
        let n = count_files(&visible, &["png"]);
        if eligible_unfinalized {
            return ("waiting".into(), n);
        }
        return ("released".into(), n);
    }
    if eligible_unfinalized && !complete {
        return ("waiting".into(), 0);
    }
    ("none".into(), 0)
}

pub fn is_session_dir(p: &Path) -> bool {
    let name = match p.file_name().and_then(|n| n.to_str()) {
        Some(n) => n,
        None => return false,
    };
    if name.starts_with('.') || !p.is_dir() {
        return false;
    }
    name.starts_with("session_") || p.join("annotation.json").is_file() || p.join("run_summary.json").is_file()
}

fn created_ms(p: &Path) -> i64 {
    fs::metadata(p)
        .ok()
        .and_then(|m| m.created().ok().or_else(|| m.modified().ok()))
        .map(ms_of)
        .unwrap_or(0)
}

pub fn eligible(p: &Path, first_run_ms: i64) -> bool {
    created_ms(p) + 60_000 >= first_run_ms
}

pub fn describe(session: &Path, first_run_ms: i64) -> SessionInfo {
    let id = session.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let complete = session.join("run_summary.json").is_file();
    let st = read_state(session);
    let ann = read_json(&session.join("annotation.json"));
    let spec = video_spec(session);
    let mut frames = 0u32;
    let mut width = 0u32;
    let mut height = 0u32;
    let mut events: Vec<EventRun> = Vec::new();
    let mut counts: BTreeMap<String, u32> = BTreeMap::new();
    let mut first_hit: Option<u32> = None;
    let mut error = None;
    if let Some(a) = ann.as_ref() {
        if let Some(v) = a.get("video") {
            frames = v.get("total_frames").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
            if let Some(r) = v.get("resolution").and_then(|x| x.as_array()) {
                width = r.first().and_then(|x| x.as_u64()).unwrap_or(0) as u32;
                height = r.get(1).and_then(|x| x.as_u64()).unwrap_or(0) as u32;
            }
        }
        if let Some(list) = a.get("anomalies").and_then(|x| x.as_array()) {
            for e in list {
                let kind = e.get("anomaly_type").and_then(|x| x.as_str()).unwrap_or("unknown").to_string();
                let idx = e
                    .get("injected_frames")
                    .map(frame_indices)
                    .filter(|v| !v.is_empty())
                    .or_else(|| e.get("affected_frames").map(frame_indices))
                    .unwrap_or_default();
                if first_hit.is_none() {
                    if let Some(mid) = idx.get(idx.len() / 2) {
                        first_hit = Some(*mid);
                    }
                }
                *counts.entry(kind.clone()).or_insert(0) += 1;
                events.push(EventRun { kind, runs: runs_of(&idx) });
            }
        }
    } else if complete {
        error = Some("This capture has no annotation.json".into());
    }
    if frames == 0 {
        frames = count_files(&spec.frames_dir, &["png", "jpg", "jpeg"]);
    }
    let elig_unfinal = !st.finalized && eligible(session, first_run_ms);
    let (masks, mask_frames) = mask_status(session, elig_unfinal, complete);
    let thumb_file = state_dir(session).join("thumb.jpg");
    let thumb = if thumb_file.is_file() {
        Some(thumb_file)
    } else {
        first_hit.and_then(|i| frame_path(&spec.frames_dir, i)).or_else(|| frame_path(&spec.frames_dir, 0))
    };
    let video = if spec.out_path.is_file() { Some(spec.out_path.to_string_lossy().to_string()) } else { None };
    let previews = count_files(&session.join(PREVIEW_DIR), &["png"]);
    SessionInfo {
        id,
        path: session.to_string_lossy().to_string(),
        created_ms: created_ms(session),
        complete,
        finalized: st.finalized,
        frames,
        fps: spec.fps,
        width,
        height,
        events,
        counts,
        thumb: thumb.map(|p| p.to_string_lossy().to_string()),
        masks,
        mask_frames,
        video,
        previews,
        error,
    }
}

pub fn list(root: &Path, first_run_ms: i64) -> Vec<SessionInfo> {
    let mut out: Vec<SessionInfo> = match fs::read_dir(root) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| is_session_dir(p))
            .map(|p| describe(&p, first_run_ms))
            .collect(),
        Err(_) => Vec::new(),
    };
    out.sort_by(|a, b| b.created_ms.cmp(&a.created_ms).then(b.id.cmp(&a.id)));
    out
}

fn newest_mtime(dir: &Path) -> Option<SystemTime> {
    let mut newest: Option<SystemTime> = None;
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.filter_map(|e| e.ok()) {
            if let Ok(m) = e.metadata() {
                if let Ok(t) = m.modified() {
                    if newest.map(|n| t > n).unwrap_or(true) {
                        newest = Some(t);
                    }
                }
            }
        }
    }
    newest
}

fn settled(session: &Path) -> bool {
    let summary = session.join("run_summary.json");
    let sm = match fs::metadata(&summary).and_then(|m| m.modified()) {
        Ok(t) => t,
        Err(_) => return false,
    };
    let now = SystemTime::now();
    if now.duration_since(sm).unwrap_or_default() > FORCE_AFTER {
        return true;
    }
    let spec = video_spec(session);
    let mut newest = sm;
    for d in [session.to_path_buf(), spec.frames_dir.clone(), session.join(MASK_DIR)] {
        if let Some(t) = newest_mtime(&d) {
            if t > newest {
                newest = t;
            }
        }
    }
    if now.duration_since(newest).unwrap_or_default() < SETTLE {
        return false;
    }
    let rs = read_json(&summary);
    let want = rs.as_ref().and_then(|r| r.get("total_frames")).and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let have = count_files(&spec.frames_dir, &["png", "jpg", "jpeg"]);
    if want > 0 && have < want {
        return false;
    }
    let want_masks = rs.as_ref().and_then(|r| r.get("target_mask_frames_measured")).and_then(|x| x.as_u64());
    if let Some(w) = want_masks {
        let have_masks = count_files(&session.join(MASK_DIR), &["png"]);
        if (have_masks as u64) < w && session.join(MASK_DIR).is_dir() {
            return false;
        }
    }
    true
}

fn make_thumb(session: &Path) {
    let info_ann = read_json(&session.join("annotation.json"));
    let spec = video_spec(session);
    let mut pick: Option<u32> = None;
    if let Some(list) = info_ann.as_ref().and_then(|a| a.get("anomalies")).and_then(|x| x.as_array()) {
        for e in list {
            let idx = e.get("injected_frames").map(frame_indices).unwrap_or_default();
            if let Some(mid) = idx.get(idx.len() / 2) {
                pick = Some(*mid);
                break;
            }
        }
    }
    let src = pick.and_then(|i| frame_path(&spec.frames_dir, i)).or_else(|| frame_path(&spec.frames_dir, 0));
    let Some(src) = src else { return };
    let Ok(img) = image::open(&src) else { return };
    let thumb = img.resize(480, 270, image::imageops::FilterType::Triangle).to_rgb8();
    let Ok(dir) = ensure_state_dir(session) else { return };
    let out = dir.join("thumb.jpg");
    if let Ok(f) = fs::File::create(&out) {
        let mut w = std::io::BufWriter::new(f);
        let _ = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut w, 84).encode_image(&thumb);
    }
}

pub fn finalize(session: &Path) -> Result<bool, String> {
    let mut st = read_state(session);
    if st.finalized {
        return Ok(false);
    }
    if !settled(session) {
        return Ok(false);
    }
    let dir = ensure_state_dir(session)?;
    let pending = dir.join(PENDING_DIR);
    let mask_dir = session.join(MASK_DIR);
    let map = session.join(MASK_MAP);
    if mask_dir.is_dir() || map.is_file() {
        fs::create_dir_all(&pending).map_err(|e| e.to_string())?;
        if mask_dir.is_dir() {
            fs::rename(&mask_dir, pending.join(MASK_DIR)).map_err(|e| format!("Masks are still in use: {e}"))?;
        }
        if map.is_file() {
            fs::rename(&map, pending.join(MASK_MAP)).map_err(|e| format!("Mask map is still in use: {e}"))?;
        }
        st.masks = "pending".into();
    } else {
        st.masks = "none".into();
    }
    make_thumb(session);
    st.finalized = true;
    st.finalized_ms = crate::settings::now_ms();
    write_state(session, &st)?;
    Ok(true)
}

pub fn finalize_all(root: &Path, first_run_ms: i64) -> bool {
    let mut changed = false;
    if let Ok(rd) = fs::read_dir(root) {
        for p in rd.filter_map(|e| e.ok()).map(|e| e.path()) {
            if !is_session_dir(&p) || !eligible(&p, first_run_ms) {
                continue;
            }
            if read_state(&p).finalized {
                continue;
            }
            if let Ok(true) = finalize(&p) {
                changed = true;
            }
        }
    }
    changed
}

pub fn release_masks(session: &Path) -> Result<u32, String> {
    let pending = state_dir(session).join(PENDING_DIR);
    let src_dir = pending.join(MASK_DIR);
    let src_map = pending.join(MASK_MAP);
    let dst_dir = session.join(MASK_DIR);
    let dst_map = session.join(MASK_MAP);
    if !src_dir.is_dir() && !src_map.is_file() {
        if dst_dir.is_dir() {
            return Ok(count_files(&dst_dir, &["png"]));
        }
        return Err("This capture has no target masks. Masks are recorded only while the game measures them.".into());
    }
    if src_dir.is_dir() {
        if dst_dir.exists() {
            return Err("A target_mask folder already exists in this capture.".into());
        }
        fs::rename(&src_dir, &dst_dir).map_err(|e| format!("Couldn't release the masks: {e}"))?;
    }
    if src_map.is_file() {
        let _ = fs::rename(&src_map, &dst_map);
    }
    let _ = fs::remove_dir(&pending);
    let mut st = read_state(session);
    st.masks = "released".into();
    let _ = write_state(session, &st);
    Ok(count_files(&dst_dir, &["png"]))
}

pub fn preview_dir(session: &Path) -> PathBuf {
    session.join(PREVIEW_DIR)
}
