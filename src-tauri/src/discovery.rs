use std::borrow::Cow;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::mem::size_of;
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use windows::core::PWSTR;
use windows::Wdk::System::Threading::{NtQueryInformationProcess, ProcessCommandLineInformation};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, FILETIME, HANDLE, NO_ERROR, UNICODE_STRING,
};
use windows::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
};
use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

#[derive(Debug, Clone, serde::Serialize)]
pub struct GameEndpoint {
    pub url: String,
    pub token: String,
    pub pid: u32,
    pub process_name: String,
    pub project_name: String,
    pub log_path: String,
    pub kind: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Discovery {
    pub status: String,
    pub endpoint: Option<GameEndpoint>,
    pub editor_running: bool,
    pub detail: String,
}

const TAIL_BYTES: u64 = 16 * 1024 * 1024;
const CHUNK_BYTES: u64 = 4 * 1024 * 1024;
const MAX_LINE_BYTES: u64 = 4 * CHUNK_BYTES;
const FRESH_SLACK: Duration = Duration::from_secs(2);
const MAX_SCANNED_LOGS: usize = 8;
const WALK_UP_LEVELS: usize = 4;
const CATEGORY: &str = "LogAnomalyServer:";
const TOKEN_MARK: &str = "=== Control server token: ";
const LISTEN_MARK: &str = "=== Anomaly Control Server LISTENING on ws://";
const STATUS_MARK: &str = "Control: listening ws://";
const STATUS_TOKEN_MARK: &str = "| token=";
const STOP_MARK: &str = "Control: server stopped.";
const VERBOSITIES: [&str; 7] = [
    "Fatal:",
    "Error:",
    "Warning:",
    "Display:",
    "Log:",
    "Verbose:",
    "VeryVerbose:",
];

pub fn discover(port: u16) -> Discovery {
    let url = format!("ws://127.0.0.1:{port}");
    let processes = process_list();
    let editor_running = processes
        .iter()
        .any(|(_, name)| is_interactive_editor(name));
    let pids = match listening_pids(port) {
        Ok(pids) => pids,
        Err(error) => {
            return Discovery {
                status: "no_server".to_string(),
                endpoint: None,
                editor_running,
                detail: format!("could not read the TCP listener table: {error}"),
            }
        }
    };
    if pids.is_empty() {
        let hint = if editor_running {
            "Unreal Editor is open: press Play, then run IAI.Server.Start"
        } else {
            "start the game with -ExecCmds=\"IAI.Server.Start\" or run IAI.Server.Start in its console"
        };
        return Discovery {
            status: "no_server".to_string(),
            endpoint: None,
            editor_running,
            detail: format!("nothing is listening on 127.0.0.1:{port}; {hint}"),
        };
    }
    let mut first_endpoint: Option<GameEndpoint> = None;
    let mut failures: Vec<String> = Vec::new();
    for pid in &pids {
        let inspection = inspect(*pid, port, &url, &processes);
        if inspection.found {
            return Discovery {
                status: "found".to_string(),
                endpoint: Some(inspection.endpoint),
                editor_running,
                detail: inspection.detail,
            };
        }
        if first_endpoint.is_none() {
            first_endpoint = Some(inspection.endpoint);
        }
        failures.push(inspection.detail);
    }
    Discovery {
        status: "no_token".to_string(),
        endpoint: first_endpoint,
        editor_running,
        detail: failures.join(" | "),
    }
}

pub fn parse_token(log_text: &str) -> Option<String> {
    let mut state = LogState::default();
    state.feed_text(log_text);
    state.last_token
}

struct Inspection {
    endpoint: GameEndpoint,
    found: bool,
    detail: String,
}

impl Inspection {
    fn failed(endpoint: GameEndpoint, detail: String) -> Self {
        Inspection {
            endpoint,
            found: false,
            detail,
        }
    }
}

fn inspect(pid: u32, port: u16, url: &str, processes: &[(u32, String)]) -> Inspection {
    let listed_name = processes
        .iter()
        .find(|(listed, _)| *listed == pid)
        .map(|(_, name)| name.clone())
        .unwrap_or_default();
    let mut endpoint = GameEndpoint {
        url: url.to_string(),
        token: String::new(),
        pid,
        process_name: listed_name.clone(),
        project_name: String::new(),
        log_path: String::new(),
        kind: kind_of(&listed_name).to_string(),
    };
    if pid == 0 || pid == 4 {
        return Inspection::failed(
            endpoint,
            format!("port {port} is owned by the Windows kernel (pid {pid}, for example an HTTP.sys reservation), not by an Unreal process"),
        );
    }
    let info = match query_process(pid) {
        Ok(info) => info,
        Err(error) => {
            let name = if listed_name.is_empty() {
                "unknown process"
            } else {
                listed_name.as_str()
            };
            let detail = format!(
                "pid {pid} ({name}) listens on port {port} but could not be inspected: {error}"
            );
            return Inspection::failed(endpoint, detail);
        }
    };
    if let Some(name) = info.image.as_deref().and_then(Path::file_name) {
        endpoint.process_name = name.to_string_lossy().into_owned();
    }
    endpoint.kind = kind_of(&endpoint.process_name).to_string();
    let editor = endpoint.kind == "editor";
    let plan = plan_logs(editor, info.image.as_deref(), &info.command_line);
    endpoint.project_name = plan.project_name.clone();
    let who = format!("pid {pid} ({}, {})", endpoint.process_name, endpoint.kind);
    if plan.candidates.is_empty() {
        let why = if plan.notes.is_empty() {
            "no Saved\\Logs folder was found".to_string()
        } else {
            plan.notes.join("; ")
        };
        let detail = format!(
            "{who} listens on port {port} but no Unreal log location could be derived: {why}"
        );
        return Inspection::failed(endpoint, detail);
    }
    let evaluation = evaluate(&plan, port, info.start);
    match evaluation.found {
        Some((path, token)) => {
            endpoint.token = token;
            endpoint.log_path = path.to_string_lossy().into_owned();
            let detail = format!("token read from {} ({who})", path.display());
            Inspection {
                endpoint,
                found: true,
                detail,
            }
        }
        None => {
            if let Some(path) = evaluation
                .report_path
                .or_else(|| plan.candidates.first().map(|c| c.path.clone()))
            {
                endpoint.log_path = path.to_string_lossy().into_owned();
            }
            let why = if evaluation.notes.is_empty() {
                "no usable log was found".to_string()
            } else {
                evaluation.notes.join("; ")
            };
            let detail =
                format!("{who} listens on port {port} but its token could not be read: {why}");
            Inspection::failed(endpoint, detail)
        }
    }
}

fn kind_of(process_name: &str) -> &'static str {
    if is_editor_image(process_name) {
        "editor"
    } else {
        "game"
    }
}

fn is_editor_image(process_name: &str) -> bool {
    let lower = process_name.to_ascii_lowercase();
    lower.starts_with("unrealeditor") || lower.starts_with("ue4editor")
}

fn is_interactive_editor(process_name: &str) -> bool {
    let lower = process_name.to_ascii_lowercase();
    is_editor_image(&lower) && lower.ends_with(".exe") && !lower.contains("-cmd")
}

struct Candidate {
    path: PathBuf,
    primary: bool,
}

struct LogPlan {
    project_name: String,
    candidates: Vec<Candidate>,
    notes: Vec<String>,
}

struct Evaluation {
    found: Option<(PathBuf, String)>,
    report_path: Option<PathBuf>,
    notes: Vec<String>,
}

fn evaluate(plan: &LogPlan, port: u16, started: Option<SystemTime>) -> Evaluation {
    let mut notes = plan.notes.clone();
    let mut report_path: Option<PathBuf> = None;
    let mut portless: Option<(PathBuf, String)> = None;
    let mut scanned = 0usize;
    for candidate in &plan.candidates {
        let shown = candidate.path.display();
        let metadata = match fs::metadata(&candidate.path) {
            Ok(metadata) if metadata.is_file() => metadata,
            _ => {
                if candidate.primary {
                    notes.push(format!("{shown} does not exist"));
                }
                continue;
            }
        };
        if report_path.is_none() {
            report_path = Some(candidate.path.clone());
        }
        if let (Ok(modified), Some(started)) = (metadata.modified(), started) {
            if modified
                .checked_add(FRESH_SLACK)
                .is_some_and(|fresh_until| fresh_until < started)
            {
                let age = started
                    .duration_since(modified)
                    .unwrap_or_default()
                    .as_secs();
                notes.push(format!(
                    "{shown} is stale: last written {age} s before the process started, so the running process is not writing it"
                ));
                continue;
            }
        }
        if scanned == MAX_SCANNED_LOGS {
            notes.push(format!("stopped after scanning {MAX_SCANNED_LOGS} logs"));
            break;
        }
        scanned += 1;
        let state = match scan_log_file(&candidate.path) {
            Ok(state) => state,
            Err(error) => {
                notes.push(format!("{shown} could not be read: {error}"));
                continue;
            }
        };
        match state.active {
            Some((token, Some(active_port))) if active_port == port => {
                return Evaluation {
                    found: Some((candidate.path.clone(), token)),
                    report_path,
                    notes,
                };
            }
            Some((token, None)) => {
                if portless.is_none() {
                    portless = Some((candidate.path.clone(), token));
                }
            }
            Some((_, Some(active_port))) => {
                notes.push(format!(
                    "{shown}: its live token belongs to port {active_port}"
                ));
            }
            None if state.stopped => {
                notes.push(format!(
                    "{shown}: the log says the server was stopped after its last token"
                ));
            }
            None if state.awaiting_token => {
                notes.push(format!(
                    "{shown}: the server LISTENING line has no token line after it yet; retry in a moment"
                ));
            }
            None => {
                notes.push(format!("{shown}: no control-server token line"));
            }
        }
    }
    Evaluation {
        found: portless,
        report_path,
        notes,
    }
}

fn plan_logs(editor: bool, image: Option<&Path>, command_line: &str) -> LogPlan {
    let mut notes: Vec<String> = Vec::new();
    let exe_dir = image.and_then(Path::parent);
    let exe_stem = image
        .and_then(Path::file_stem)
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let uproject = find_uproject(command_line, exe_dir);
    let stem = match (&uproject, editor) {
        (Some(path), _) => path
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default(),
        (None, false) => project_stem(&exe_stem),
        (None, true) => String::new(),
    };
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = uproject.as_deref().and_then(Path::parent) {
        push_unique_dir(&mut dirs, dir.join("Saved").join("Logs"));
    }
    if !editor {
        if let Some(dir) = exe_dir {
            for ancestor in dir.ancestors().take(WALK_UP_LEVELS + 1) {
                let mut bases = vec![ancestor.to_path_buf()];
                if !stem.is_empty() {
                    bases.push(ancestor.join(&stem));
                }
                for base in bases {
                    let logs = base.join("Saved").join("Logs");
                    if logs.is_dir() {
                        push_unique_dir(&mut dirs, logs);
                    }
                }
            }
        }
        if !stem.is_empty() {
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                let logs = PathBuf::from(local).join(&stem).join("Saved").join("Logs");
                if logs.is_dir() {
                    push_unique_dir(&mut dirs, logs);
                }
            }
        }
    } else if uproject.is_none() {
        notes.push("the editor command line names no .uproject file".to_string());
    }
    let project_logs = dirs.first().cloned().or_else(|| {
        exe_dir
            .and_then(Path::parent)
            .and_then(Path::parent)
            .map(|root| root.join("Saved").join("Logs"))
    });
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut explicit = false;
    if let Some(argument) = ue_log_argument(command_line) {
        if !has_log_extension(&argument.value) {
            notes.push(format!(
                "ignored {}={} because Unreal only honours .log or .txt names",
                argument.key, argument.value
            ));
        } else {
            let resolved = if argument.absolute {
                Some(resolve_against(exe_dir, &argument.value))
            } else {
                project_logs.map(|logs| logs.join(&argument.value))
            };
            match resolved {
                Some(path) => {
                    push_candidate(&mut candidates, path, true);
                    explicit = true;
                }
                None => notes.push(format!(
                    "{}={} could not be resolved to a folder",
                    argument.key, argument.value
                )),
            }
        }
    }
    for (index, dir) in dirs.iter().enumerate() {
        if !stem.is_empty() {
            push_candidate(
                &mut candidates,
                dir.join(format!("{stem}.log")),
                index == 0 && !explicit,
            );
        }
        for path in listed_logs(dir, &stem) {
            push_candidate(&mut candidates, path, false);
        }
    }
    let project_name = if stem.is_empty() { exe_stem } else { stem };
    LogPlan {
        project_name,
        candidates,
        notes,
    }
}

fn push_unique_dir(dirs: &mut Vec<PathBuf>, dir: PathBuf) {
    let key = dir.to_string_lossy().to_lowercase();
    if !dirs
        .iter()
        .any(|known| known.to_string_lossy().to_lowercase() == key)
    {
        dirs.push(dir);
    }
}

fn push_candidate(candidates: &mut Vec<Candidate>, path: PathBuf, primary: bool) {
    let key = path.to_string_lossy().to_lowercase();
    if !candidates
        .iter()
        .any(|known| known.path.to_string_lossy().to_lowercase() == key)
    {
        candidates.push(Candidate { path, primary });
    }
}

fn listed_logs(dir: &Path, stem: &str) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let stem_lower = stem.to_ascii_lowercase();
    let mut numbered: Vec<(SystemTime, PathBuf)> = Vec::new();
    let mut others: Vec<(SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if !name.ends_with(".log") || name.contains("-backup-") {
            continue;
        }
        let base = &name[..name.len() - 4];
        if !stem_lower.is_empty() && base == stem_lower {
            continue;
        }
        let path = entry.path();
        let modified = fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH);
        let is_numbered = !stem_lower.is_empty()
            && base
                .strip_prefix(stem_lower.as_str())
                .and_then(|rest| rest.strip_prefix('_'))
                .is_some_and(|digits| {
                    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
                });
        if is_numbered {
            numbered.push((modified, path));
        } else {
            others.push((modified, path));
        }
    }
    numbered.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    others.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    numbered
        .into_iter()
        .chain(others)
        .map(|(_, path)| path)
        .collect()
}

fn project_stem(exe_stem: &str) -> String {
    match exe_stem.split_once('-') {
        Some((head, tail)) if !head.is_empty() && tail.to_ascii_lowercase().starts_with("win") => {
            head.to_string()
        }
        _ => exe_stem.to_string(),
    }
}

fn has_log_extension(value: &str) -> bool {
    Path::new(value)
        .extension()
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|extension| extension == "log" || extension == "txt")
}

fn resolve_against(base: Option<&Path>, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    match base {
        Some(base) if path.is_relative() => base.join(path),
        _ => path,
    }
}

struct LogArgument {
    key: &'static str,
    value: String,
    absolute: bool,
}

fn ue_log_argument(command_line: &str) -> Option<LogArgument> {
    let arguments = without_program(command_line);
    if let Some(value) = ue_value(arguments, "LOG=") {
        return Some(LogArgument {
            key: "-log",
            value,
            absolute: false,
        });
    }
    ue_value(arguments, "ABSLOG=").map(|value| LogArgument {
        key: "-abslog",
        value,
        absolute: true,
    })
}

fn ue_value(stream: &str, key: &str) -> Option<String> {
    let chars: Vec<char> = stream.chars().collect();
    let key: Vec<char> = key.chars().collect();
    let mut quoted = false;
    let mut previous_alphanumeric = false;
    for index in 0..chars.len() {
        let current = chars[index];
        if !quoted && !previous_alphanumeric && starts_with_ignore_case(&chars[index..], &key) {
            let mut cursor = index + key.len();
            if cursor < chars.len() && chars[cursor] == '"' {
                cursor += 1;
                let end = chars[cursor..]
                    .iter()
                    .position(|c| *c == '"')
                    .map_or(chars.len(), |offset| cursor + offset);
                return Some(chars[cursor..end].iter().collect());
            }
            while cursor < chars.len() && matches!(chars[cursor], ' ' | '\t' | '\r' | '\n') {
                cursor += 1;
            }
            let end = chars[cursor..]
                .iter()
                .position(|c| matches!(c, ' ' | '\t' | '\r' | '\n'))
                .map_or(chars.len(), |offset| cursor + offset);
            return Some(chars[cursor..end].iter().collect());
        }
        previous_alphanumeric = current.is_ascii_alphanumeric();
        if current == '"' {
            quoted = !quoted;
        }
    }
    None
}

fn starts_with_ignore_case(haystack: &[char], needle: &[char]) -> bool {
    haystack.len() >= needle.len()
        && haystack
            .iter()
            .zip(needle)
            .all(|(a, b)| a.eq_ignore_ascii_case(b))
}

fn without_program(command_line: &str) -> &str {
    let trimmed = command_line.trim_start();
    if let Some(rest) = trimmed.strip_prefix('"') {
        return rest.find('"').map_or("", |end| &rest[end + 1..]);
    }
    trimmed
        .find(char::is_whitespace)
        .map_or("", |end| &trimmed[end..])
}

fn split_arguments(command_line: &str) -> Vec<String> {
    let mut arguments = Vec::new();
    let trimmed = command_line.trim_start();
    let rest = if let Some(after) = trimmed.strip_prefix('"') {
        let end = after.find('"').unwrap_or(after.len());
        arguments.push(after[..end].to_string());
        after.get(end + 1..).unwrap_or("")
    } else {
        let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
        arguments.push(trimmed[..end].to_string());
        &trimmed[end..]
    };
    let chars: Vec<char> = rest.chars().collect();
    let mut index = 0;
    loop {
        while index < chars.len() && (chars[index] == ' ' || chars[index] == '\t') {
            index += 1;
        }
        if index >= chars.len() {
            break;
        }
        let mut current = String::new();
        let mut quoted = false;
        while index < chars.len() {
            let c = chars[index];
            if c == '\\' {
                let mut slashes = 0usize;
                while index < chars.len() && chars[index] == '\\' {
                    slashes += 1;
                    index += 1;
                }
                if index < chars.len() && chars[index] == '"' {
                    current.extend(std::iter::repeat('\\').take(slashes / 2));
                    if slashes % 2 == 1 {
                        current.push('"');
                        index += 1;
                    }
                } else {
                    current.extend(std::iter::repeat('\\').take(slashes));
                }
                continue;
            }
            if c == '"' {
                if quoted && index + 1 < chars.len() && chars[index + 1] == '"' {
                    current.push('"');
                    index += 2;
                } else {
                    quoted = !quoted;
                    index += 1;
                }
                continue;
            }
            if !quoted && (c == ' ' || c == '\t') {
                break;
            }
            current.push(c);
            index += 1;
        }
        arguments.push(current);
    }
    arguments
}

fn find_uproject(command_line: &str, exe_dir: Option<&Path>) -> Option<PathBuf> {
    let mut first_guess: Option<PathBuf> = None;
    for argument in split_arguments(command_line).into_iter().skip(1) {
        let argument = argument.trim();
        if !argument.to_ascii_lowercase().ends_with(".uproject") {
            continue;
        }
        let path = resolve_against(exe_dir, argument);
        if path.is_file() {
            return Some(path);
        }
        if first_guess.is_none() {
            first_guess = Some(path);
        }
    }
    raw_uproject_paths(command_line)
        .into_iter()
        .find(|path| path.is_file())
        .or(first_guess)
}

fn raw_uproject_paths(command_line: &str) -> Vec<PathBuf> {
    const SUFFIX: &str = ".uproject";
    let lower = command_line.to_ascii_lowercase();
    let bytes = command_line.as_bytes();
    let mut paths = Vec::new();
    let mut from = 0;
    while let Some(offset) = lower[from..].find(SUFFIX) {
        let suffix_start = from + offset;
        let end = suffix_start + SUFFIX.len();
        from = end;
        if let Some(next) = command_line[end..].chars().next() {
            if !(next.is_whitespace() || next == '"') {
                continue;
            }
        }
        let start = (0..suffix_start).rev().find(|&position| {
            let at_boundary = position == 0 || matches!(bytes[position - 1], b' ' | b'\t' | b'"');
            if !at_boundary {
                return false;
            }
            let tail = &bytes[position..];
            let drive = tail.len() >= 3
                && tail[0].is_ascii_alphabetic()
                && tail[1] == b':'
                && (tail[2] == b'\\' || tail[2] == b'/');
            let unc = tail.len() >= 2 && tail[0] == b'\\' && tail[1] == b'\\';
            drive || unc
        });
        if let Some(start) = start {
            paths.push(PathBuf::from(&command_line[start..end]));
        }
    }
    paths
}

#[derive(Default)]
struct LogState {
    listen_port: Option<u16>,
    active: Option<(String, Option<u16>)>,
    last_token: Option<String>,
    stopped: bool,
    awaiting_token: bool,
}

enum ServerLine {
    Listening(Option<u16>),
    Announced(String),
    Status(String, Option<u16>),
    Stopped,
}

impl LogState {
    fn feed_text(&mut self, text: &str) {
        let mut from = 0;
        while let Some(offset) = text[from..].find(CATEGORY) {
            let at = from + offset;
            let start = text[..at].rfind('\n').map_or(0, |newline| newline + 1);
            let end = text[at..]
                .find('\n')
                .map_or(text.len(), |newline| at + newline);
            self.feed_line(&text[start..end]);
            from = end;
        }
    }

    fn feed_line(&mut self, line: &str) {
        match classify_line(line) {
            Some(ServerLine::Listening(port)) => {
                self.listen_port = port;
                self.active = None;
                self.stopped = false;
                self.awaiting_token = true;
            }
            Some(ServerLine::Announced(token)) => {
                self.last_token = Some(token.clone());
                self.active = Some((token, self.listen_port));
                self.stopped = false;
                self.awaiting_token = false;
            }
            Some(ServerLine::Status(token, port)) => {
                if port.is_some() {
                    self.listen_port = port;
                }
                self.last_token = Some(token.clone());
                self.active = Some((token, self.listen_port));
                self.stopped = false;
                self.awaiting_token = false;
            }
            Some(ServerLine::Stopped) => {
                self.listen_port = None;
                self.active = None;
                self.stopped = true;
                self.awaiting_token = false;
            }
            None => {}
        }
    }
}

fn classify_line(line: &str) -> Option<ServerLine> {
    let message = server_message(line)?;
    if let Some(rest) = message.strip_prefix(TOKEN_MARK) {
        return announced_token(rest).map(ServerLine::Announced);
    }
    if let Some(rest) = message.strip_prefix(STATUS_MARK) {
        return status_token(rest).map(|(token, port)| ServerLine::Status(token, port));
    }
    if let Some(rest) = message.strip_prefix(LISTEN_MARK) {
        return Some(ServerLine::Listening(endpoint_port(rest)));
    }
    if message.starts_with(STOP_MARK) {
        return Some(ServerLine::Stopped);
    }
    None
}

fn server_message(line: &str) -> Option<&str> {
    let mut rest = line.trim_start_matches('\u{feff}').trim_start();
    while let Some(inner) = rest.strip_prefix('[') {
        let close = inner.find(']')?;
        rest = inner[close + 1..].trim_start();
    }
    let mut message = rest.strip_prefix(CATEGORY)?.trim_start();
    if let Some(stripped) = VERBOSITIES
        .iter()
        .find_map(|verbosity| message.strip_prefix(verbosity))
    {
        message = stripped.trim_start();
    }
    Some(message.trim_end_matches(['\r', '\n']))
}

fn announced_token(rest: &str) -> Option<String> {
    let end = rest.find(" (").or_else(|| rest.find(" ==="))?;
    clean_token(&rest[..end])
}

fn status_token(rest: &str) -> Option<(String, Option<u16>)> {
    let port = endpoint_port(rest);
    let at = rest.find(STATUS_TOKEN_MARK)?;
    let after = &rest[at + STATUS_TOKEN_MARK.len()..];
    let end = after.find(" |")?;
    Some((clean_token(&after[..end])?, port))
}

fn clean_token(raw: &str) -> Option<String> {
    let token = raw.trim();
    if token.is_empty() || token.chars().any(char::is_control) {
        return None;
    }
    Some(token.to_string())
}

fn endpoint_port(rest: &str) -> Option<u16> {
    let authority = rest
        .split(|c: char| c.is_whitespace() || c == '|' || c == '/')
        .next()?;
    let (_, port) = authority.rsplit_once(':')?;
    port.parse().ok()
}

#[derive(Clone, Copy, PartialEq)]
enum Encoding {
    Utf8,
    Utf16Le,
}

fn scan_log_file(path: &Path) -> io::Result<LogState> {
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    let encoding = detect_encoding(&mut file)?;
    let mut tail_start = length.saturating_sub(TAIL_BYTES);
    if encoding == Encoding::Utf16Le && tail_start % 2 == 1 {
        tail_start += 1;
    }
    let skip_partial = tail_start > 0 && !preceded_by_newline(&mut file, tail_start, encoding)?;
    let mut state = LogState::default();
    scan_range(
        &mut file,
        encoding,
        tail_start,
        length,
        skip_partial,
        &mut state,
    )?;
    if tail_start > 0 && state.last_token.is_none() {
        state = LogState::default();
        scan_range(&mut file, encoding, 0, length, false, &mut state)?;
    }
    Ok(state)
}

fn read_fully(file: &mut File, buffer: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        let read = file.read(&mut buffer[filled..])?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    Ok(filled)
}

fn detect_encoding(file: &mut File) -> io::Result<Encoding> {
    let mut head = [0u8; 2];
    file.seek(SeekFrom::Start(0))?;
    let filled = read_fully(file, &mut head)?;
    Ok(if filled == 2 && head == [0xFF, 0xFE] {
        Encoding::Utf16Le
    } else {
        Encoding::Utf8
    })
}

fn preceded_by_newline(file: &mut File, offset: u64, encoding: Encoding) -> io::Result<bool> {
    let width = if encoding == Encoding::Utf16Le { 2 } else { 1 };
    if offset < width {
        return Ok(true);
    }
    let mut unit = [0u8; 2];
    file.seek(SeekFrom::Start(offset - width))?;
    let filled = read_fully(file, &mut unit[..width as usize])?;
    Ok(match encoding {
        Encoding::Utf8 => filled == 1 && unit[0] == b'\n',
        Encoding::Utf16Le => filled == 2 && unit == [b'\n', 0],
    })
}

fn scan_range(
    file: &mut File,
    encoding: Encoding,
    start: u64,
    end: u64,
    skip_partial: bool,
    state: &mut LogState,
) -> io::Result<()> {
    file.seek(SeekFrom::Start(start))?;
    let mut remaining = end.saturating_sub(start);
    let mut skipping = skip_partial;
    let mut pending: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; remaining.min(CHUNK_BYTES) as usize];
    while remaining > 0 {
        let want = remaining.min(chunk.len() as u64) as usize;
        let read = file.read(&mut chunk[..want])?;
        if read == 0 {
            break;
        }
        remaining -= read as u64;
        pending.extend_from_slice(&chunk[..read]);
        let cut = complete_prefix(&pending, encoding);
        if cut > 0 {
            feed_bytes(&pending[..cut], encoding, &mut skipping, state);
            pending.drain(..cut);
        } else if pending.len() as u64 > MAX_LINE_BYTES {
            pending.clear();
            skipping = true;
        }
    }
    if !pending.is_empty() {
        feed_bytes(&pending, encoding, &mut skipping, state);
    }
    Ok(())
}

fn complete_prefix(bytes: &[u8], encoding: Encoding) -> usize {
    match encoding {
        Encoding::Utf8 => bytes
            .iter()
            .rposition(|&b| b == b'\n')
            .map_or(0, |newline| newline + 1),
        Encoding::Utf16Le => {
            let mut index = bytes.len() & !1;
            while index >= 2 {
                index -= 2;
                if bytes[index] == b'\n' && bytes[index + 1] == 0 {
                    return index + 2;
                }
            }
            0
        }
    }
}

fn feed_bytes(bytes: &[u8], encoding: Encoding, skipping: &mut bool, state: &mut LogState) {
    let decoded: Cow<str> = match encoding {
        Encoding::Utf8 => String::from_utf8_lossy(bytes),
        Encoding::Utf16Le => {
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            Cow::Owned(String::from_utf16_lossy(&units))
        }
    };
    let mut text: &str = &decoded;
    if *skipping {
        match text.find('\n') {
            Some(newline) => {
                text = &text[newline + 1..];
                *skipping = false;
            }
            None => return,
        }
    }
    state.feed_text(text);
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

struct ProcessInfo {
    image: Option<PathBuf>,
    command_line: String,
    start: Option<SystemTime>,
}

fn query_process(pid: u32) -> Result<ProcessInfo, String> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
        .map_err(|error| error.to_string())?;
    let handle = OwnedHandle(handle);
    Ok(ProcessInfo {
        image: image_path(handle.0),
        command_line: command_line(handle.0).unwrap_or_default(),
        start: start_time(handle.0),
    })
}

fn image_path(handle: HANDLE) -> Option<PathBuf> {
    let mut buffer = vec![0u16; 32768];
    let mut size = buffer.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
    }
    .ok()?;
    let size = (size as usize).min(buffer.len());
    Some(PathBuf::from(OsString::from_wide(&buffer[..size])))
}

fn command_line(handle: HANDLE) -> Option<String> {
    let mut words = 512usize;
    for _ in 0..4 {
        let mut buffer = vec![0u64; words];
        let capacity = (words * 8) as u32;
        let mut needed = 0u32;
        let status = unsafe {
            NtQueryInformationProcess(
                handle,
                ProcessCommandLineInformation,
                buffer.as_mut_ptr().cast(),
                capacity,
                &mut needed,
            )
        };
        if status.0 >= 0 {
            return unicode_from_buffer(&buffer);
        }
        if needed as usize <= words * 8 {
            return None;
        }
        words = (needed as usize).div_ceil(8) + 1;
    }
    None
}

fn unicode_from_buffer(buffer: &[u64]) -> Option<String> {
    if buffer.len() * 8 < size_of::<UNICODE_STRING>() {
        return None;
    }
    let header = unsafe { std::ptr::read_unaligned(buffer.as_ptr().cast::<UNICODE_STRING>()) };
    let units = header.Length as usize / 2;
    if units == 0 || header.Buffer.0.is_null() {
        return Some(String::new());
    }
    let begin = buffer.as_ptr() as usize;
    let end = begin + buffer.len() * 8;
    let data = header.Buffer.0 as usize;
    if data < begin || data % 2 != 0 || data + units * 2 > end {
        return None;
    }
    let slice = unsafe { std::slice::from_raw_parts(header.Buffer.0 as *const u16, units) };
    Some(String::from_utf16_lossy(slice))
}

fn start_time(handle: HANDLE) -> Option<SystemTime> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) }.ok()?;
    let ticks = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    let unix_ticks = ticks.checked_sub(116_444_736_000_000_000)?;
    UNIX_EPOCH.checked_add(Duration::from_nanos(unix_ticks.saturating_mul(100)))
}

fn process_list() -> Vec<(u32, String)> {
    let mut processes = Vec::new();
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return processes;
    };
    let snapshot = OwnedHandle(snapshot);
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut more = unsafe { Process32FirstW(snapshot.0, &mut entry) }.is_ok();
    while more {
        let length = entry
            .szExeFile
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(entry.szExeFile.len());
        processes.push((
            entry.th32ProcessID,
            String::from_utf16_lossy(&entry.szExeFile[..length]),
        ));
        more = unsafe { Process32NextW(snapshot.0, &mut entry) }.is_ok();
    }
    processes
}

fn listening_pids(port: u16) -> Result<Vec<u32>, String> {
    let mut pids: Vec<u32> = Vec::new();
    let table = tcp_table(u32::from(AF_INET.0))
        .map_err(|code| format!("GetExtendedTcpTable(IPv4) failed with error {code}"))?;
    for row in table_rows::<MIB_TCPROW_OWNER_PID>(&table) {
        let address = row.dwLocalAddr.to_ne_bytes();
        let loopback_or_any = address == [0, 0, 0, 0] || address[0] == 127;
        if loopback_or_any
            && local_port(row.dwLocalPort) == port
            && !pids.contains(&row.dwOwningPid)
        {
            pids.push(row.dwOwningPid);
        }
    }
    if let Ok(table) = tcp_table(u32::from(AF_INET6.0)) {
        for row in table_rows::<MIB_TCP6ROW_OWNER_PID>(&table) {
            if is_loopback_or_any_v6(&row.ucLocalAddr)
                && local_port(row.dwLocalPort) == port
                && !pids.contains(&row.dwOwningPid)
            {
                pids.push(row.dwOwningPid);
            }
        }
    }
    Ok(pids)
}

fn local_port(raw: u32) -> u16 {
    let bytes = raw.to_ne_bytes();
    u16::from_be_bytes([bytes[0], bytes[1]])
}

fn is_loopback_or_any_v6(address: &[u8; 16]) -> bool {
    let any = address.iter().all(|&b| b == 0);
    let loopback = address[..15].iter().all(|&b| b == 0) && address[15] == 1;
    let mapped = address[..10].iter().all(|&b| b == 0)
        && address[10] == 0xFF
        && address[11] == 0xFF
        && (address[12] == 127 || address[12..].iter().all(|&b| b == 0));
    any || loopback || mapped
}

fn tcp_table(family: u32) -> Result<Vec<u32>, u32> {
    let mut size = 0u32;
    let first = unsafe {
        GetExtendedTcpTable(
            None,
            &mut size,
            false,
            family,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if first != NO_ERROR.0 && first != ERROR_INSUFFICIENT_BUFFER.0 {
        return Err(first);
    }
    for _ in 0..8 {
        let mut buffer = vec![0u32; (size as usize).div_ceil(4).max(1)];
        let mut length = (buffer.len() * 4) as u32;
        let result = unsafe {
            GetExtendedTcpTable(
                Some(buffer.as_mut_ptr().cast()),
                &mut length,
                false,
                family,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if result == NO_ERROR.0 {
            return Ok(buffer);
        }
        if result != ERROR_INSUFFICIENT_BUFFER.0 {
            return Err(result);
        }
        size = length.saturating_add(4096);
    }
    Err(ERROR_INSUFFICIENT_BUFFER.0)
}

fn table_rows<T: Copy>(buffer: &[u32]) -> Vec<T> {
    let Some(&count) = buffer.first() else {
        return Vec::new();
    };
    let available = (buffer.len() - 1) * 4 / size_of::<T>().max(1);
    let count = (count as usize).min(available);
    let base = buffer[1..].as_ptr().cast::<T>();
    (0..count)
        .map(|index| unsafe { std::ptr::read_unaligned(base.add(index)) })
        .collect()
}
