//! One guarded `git` invocation.
//!
//! The JavaScript planner ran `execFile('git', ['-C', path, ...], { timeout: 60_000, maxBuffer: 4 MiB })`
//! after removing the `GIT_*` variables that would make git inspect the caller's repository instead of
//! the clone. This module preserves those three properties without adding a dependency: a 60 s
//! timeout, a 4 MiB per-stream cap, and the caller-variable scrub.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The cap `execFile` used: 4 MiB per stream.
const MAX_BUFFER: usize = 4 * 1024 * 1024;
/// The timeout `execFile` used.
const TIMEOUT: Duration = Duration::from_secs(60);

/// Git variables that would make `git -C <clone>` operate on the caller's repository instead of the clone.
const GIT_CALLER_ENV: [&str; 8] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
];

/// The result shape the JavaScript `git()` helper returned.
pub struct GitResult {
    pub ok: bool,
    pub out: String,
    pub err: String,
}

/// Run one git command inside `path` with the planner's environment.
pub fn run(path: &str, args: &[&str]) -> GitResult {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for key in GIT_CALLER_ENV {
        command.env_remove(key);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return GitResult {
                ok: false,
                out: String::new(),
                err: error.to_string(),
            };
        }
    };
    let overflow = Arc::new(AtomicBool::new(false));
    let stdout = Arc::new(Mutex::new(Vec::new()));
    let stderr = Arc::new(Mutex::new(Vec::new()));
    let stdout_reader = {
        let sink = Arc::clone(&stdout);
        let overflow = Arc::clone(&overflow);
        let pipe = child.stdout.take();
        std::thread::spawn(move || read_capped(pipe, sink, overflow))
    };
    let stderr_reader = {
        let sink = Arc::clone(&stderr);
        let overflow = Arc::clone(&overflow);
        let pipe = child.stderr.take();
        std::thread::spawn(move || read_capped(pipe, sink, overflow))
    };

    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(exited)) => break Some(exited),
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return GitResult {
                    ok: false,
                    out: String::new(),
                    err: error.to_string(),
                };
            }
        }
        if overflow.load(Ordering::SeqCst) {
            let _ = child.kill();
            break child.wait().ok();
        }
        if started.elapsed() >= TIMEOUT {
            timed_out = true;
            let _ = child.kill();
            break child.wait().ok();
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
    let out = take_string(&stdout);
    let err = take_string(&stderr);
    if timed_out {
        return GitResult {
            ok: false,
            out,
            err: "timed out after 60s".to_string(),
        };
    }
    if overflow.load(Ordering::SeqCst) {
        return GitResult {
            ok: false,
            out,
            err: "git output exceeded 4 MiB".to_string(),
        };
    }
    let ok = status.map(|exited| exited.success()).unwrap_or(false);
    GitResult { ok, out, err }
}

fn take_string(sink: &Arc<Mutex<Vec<u8>>>) -> String {
    match sink.lock() {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => String::new(),
    }
}

fn read_capped<R: Read + Send + 'static>(
    pipe: Option<R>,
    sink: Arc<Mutex<Vec<u8>>>,
    overflow: Arc<AtomicBool>,
) {
    let Some(mut pipe) = pipe else {
        return;
    };
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        match pipe.read(&mut buffer) {
            Ok(0) => return,
            Ok(read) => {
                let Ok(mut bytes) = sink.lock() else {
                    return;
                };
                let room = MAX_BUFFER.saturating_sub(bytes.len());
                if read > room {
                    bytes.extend_from_slice(&buffer[..room]);
                    overflow.store(true, Ordering::SeqCst);
                    return;
                }
                bytes.extend_from_slice(&buffer[..read]);
            }
            Err(_) => return,
        }
    }
}
