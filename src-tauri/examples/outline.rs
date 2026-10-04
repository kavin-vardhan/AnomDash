use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

fn main() {
    let session = PathBuf::from(std::env::args().nth(1).expect("session dir"));
    let out = std::env::args().nth(2).map(PathBuf::from).unwrap_or_else(|| session.join("annotated"));
    let cancel = AtomicBool::new(false);
    let started = std::time::Instant::now();
    let r = anomaly_dashboard::overlay::render_outlines(&session, &out, &|_, _| {}, &cancel);
    println!("{:?} in {} ms", r, started.elapsed().as_millis());
}
