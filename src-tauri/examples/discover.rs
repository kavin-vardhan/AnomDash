fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(pid) = args.get(1).and_then(|s| s.parse::<u32>().ok()) {
        let started = std::time::Instant::now();
        let logs = anomaly_dashboard::discovery::open_logs_for(pid);
        println!("open logs for {pid} ({} ms):", started.elapsed().as_millis());
        for l in logs {
            println!("  {}", l.display());
        }
    }
    let started = std::time::Instant::now();
    let d = anomaly_dashboard::discovery::discover(8077);
    println!("discover ({} ms): status={} detail={}", started.elapsed().as_millis(), d.status, d.detail);
    if let Some(e) = d.endpoint {
        println!("  pid={} process={} project={} kind={} log={} token_len={}", e.pid, e.process_name, e.project_name, e.kind, e.log_path, e.token.len());
    }
}
