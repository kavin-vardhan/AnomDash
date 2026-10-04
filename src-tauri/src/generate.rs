use crate::{overlay, sessions, video};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Deserialize)]
pub struct GenerateRequest {
    pub sessions: Vec<String>,
    pub video: bool,
    pub masks: bool,
    pub previews: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub session: String,
    pub step: String,
    pub state: String,
    pub done: u32,
    pub total: u32,
    pub message: String,
}

pub static CANCEL: AtomicBool = AtomicBool::new(false);
pub static BUSY: AtomicBool = AtomicBool::new(false);

fn p(session: &str, step: &str, state: &str, done: u32, total: u32, message: impl Into<String>) -> Progress {
    Progress { session: session.to_string(), step: step.to_string(), state: state.to_string(), done, total, message: message.into() }
}

struct Throttle {
    last: Mutex<Instant>,
}

impl Throttle {
    fn new() -> Self {
        Throttle { last: Mutex::new(Instant::now() - Duration::from_secs(1)) }
    }
    fn ready(&self, force: bool) -> bool {
        let mut l = self.last.lock().unwrap();
        if force || l.elapsed() >= Duration::from_millis(120) {
            *l = Instant::now();
            true
        } else {
            false
        }
    }
}

pub fn run(req: GenerateRequest, emit: impl Fn(Progress) + Send + Sync + 'static) {
    if BUSY.swap(true, Ordering::SeqCst) {
        emit(p("*", "all", "error", 0, 0, "Already generating"));
        return;
    }
    CANCEL.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        for s in &req.sessions {
            emit(p(s, "all", "queued", 0, 0, "Waiting"));
        }
        for s in &req.sessions {
            if CANCEL.load(Ordering::SeqCst) {
                emit(p(s, "all", "cancelled", 0, 0, "Cancelled"));
                continue;
            }
            let session = PathBuf::from(s);
            let mut errors: Vec<String> = Vec::new();
            let mut notes: Vec<String> = Vec::new();

            if req.masks {
                emit(p(s, "masks", "running", 0, 1, "Releasing target masks"));
                match sessions::release_masks(&session) {
                    Ok(n) => notes.push(format!("{n} masks")),
                    Err(e) => errors.push(e),
                }
            }

            if req.video && !CANCEL.load(Ordering::SeqCst) {
                let spec = sessions::video_spec(&session);
                let th = Throttle::new();
                let sref = s.clone();
                let emit_ref = &emit;
                let progress = move |done: u32, total: u32| {
                    if th.ready(done >= total) {
                        emit_ref(p(&sref, "video", "running", done, total, "Encoding video"));
                    }
                };
                emit(p(s, "video", "running", 0, 0, "Encoding video"));
                let job = video::VideoJob { frames_dir: spec.frames_dir, out_path: spec.out_path, fps: spec.fps };
                match video::encode_mp4(&job, &progress, &CANCEL) {
                    Ok(r) => {
                        notes.push(format!("video {} frames", r.frames));
                        let mut st = sessions::read_state(&session);
                        st.video = serde_json::to_value(&r).ok();
                        let _ = sessions::write_state(&session, &st);
                    }
                    Err(e) => {
                        if e != "cancelled" {
                            errors.push(format!("Video: {e}"));
                        }
                    }
                }
            }

            if req.previews && !CANCEL.load(Ordering::SeqCst) {
                let th = Throttle::new();
                let sref = s.clone();
                let emit_ref = &emit;
                let progress = move |done: u32, total: u32| {
                    if th.ready(done >= total) {
                        emit_ref(p(&sref, "previews", "running", done, total, "Drawing labelled previews"));
                    }
                };
                emit(p(s, "previews", "running", 0, 0, "Drawing labelled previews"));
                match overlay::render_previews(&session, &sessions::preview_dir(&session), &progress, &CANCEL) {
                    Ok(r) => {
                        notes.push(format!("{} previews", r.images_written));
                        let mut st = sessions::read_state(&session);
                        st.previews = serde_json::to_value(&r).ok();
                        let _ = sessions::write_state(&session, &st);
                    }
                    Err(e) => {
                        if e != "cancelled" {
                            errors.push(format!("Previews: {e}"));
                        }
                    }
                }
            }

            if CANCEL.load(Ordering::SeqCst) {
                emit(p(s, "all", "cancelled", 0, 0, "Cancelled"));
            } else if errors.is_empty() {
                emit(p(s, "all", "done", 1, 1, notes.join(" · ")));
            } else {
                emit(p(s, "all", "error", 0, 0, errors.join(" · ")));
            }
        }
        BUSY.store(false, Ordering::SeqCst);
        emit(p("*", "all", "done", 0, 0, "Finished"));
    });
}
