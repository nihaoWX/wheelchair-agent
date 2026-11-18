//! The ticket-clone reclaim planner — the Rust-only implementation of `planWork()`.
//!
//! Scope of the port: every decision `planWork()` made. The gate order is part of the contract and
//! matches the JavaScript clause by clause:
//!
//!   1. a failed/unknown entry is `unknown` and never reclaimed (no `.git`, bad name, plain file);
//!   2. an open-ticket directory is kept for that reason;
//!   3. the reconstructibility gate: cwd holders → clean tree → a remote exists → every commit
//!      published → HEAD/remote readable;
//!   4. only then do `--keep` / `--keep-days` delay an otherwise passing entry;
//!   5. a `blockedReason` (unreadable open-ticket answer) converts every remaining reclaim to keep.
//!
//! Every user-visible reason string is byte-identical to the JavaScript one: the CLI prints them and
//! `tests/test-work.mjs` asserts them.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use schemars::JsonSchema;
use serde::Serialize;

use crate::git;
use crate::procscan;
use crate::time;
use crate::util;

/// No age retention by default.
pub const KEEP_DAYS_DEFAULT: f64 = 0.0;
/// No count floor by default.
pub const KEEP_DEFAULT: f64 = 0.0;

/// Input of one plan.
pub struct PlanOptions {
    pub root: String,
    pub keep: f64,
    pub keep_days: f64,
    pub now: f64,
    /// Normalised directory path → open ticket id (or title). The JavaScript wrapper performs the
    /// `Map`/iterable adaptation and the `resolve()` normalisation; the planner only looks up.
    pub skip_directories: HashMap<String, String>,
    pub blocked_reason: Option<String>,
}

impl PlanOptions {
    pub fn new(root: impl Into<String>) -> Self {
        Self {
            root: root.into(),
            keep: KEEP_DEFAULT,
            keep_days: KEEP_DAYS_DEFAULT,
            now: time::now_ms(),
            skip_directories: HashMap::new(),
            blocked_reason: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Reclaim,
    Keep,
    Unknown,
}

/// What a reclaiming delete needs to rebuild the clone later.
#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub version: u32,
    pub name: String,
    pub path: String,
    pub head: String,
    pub origin_main: Option<String>,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub remote: String,
    pub remote_name: String,
    pub bytes: f64,
    pub when: String,
}

/// One direct child of the work root.
#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub bytes: f64,
    pub action: Action,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record: Option<Record>,
}

/// The plan summary the CLI and mount hook consume.
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub root: String,
    pub entries: Vec<Entry>,
    pub reclaimable: usize,
    pub reclaimable_bytes: f64,
    pub kept: usize,
    pub unknown: usize,
}

/// Result of inspecting one ticket-shaped clone.
enum Gate {
    Pass(CloneFacts),
    Keep(String),
}

struct CloneFacts {
    name: String,
    path: String,
    head: String,
    origin_main: Option<String>,
    branch: Option<String>,
    upstream: Option<String>,
    remote: String,
    remote_name: String,
}

struct Unpublished {
    reason: Option<String>,
    upstream: Option<String>,
}

/// Build the plan. `Err` is reserved for I/O that the JavaScript version re-threw (an unreadable work
/// root, for example); per-entry failures are `keep` entries, exactly like the `try/catch` around each
/// child in the original loop.
pub fn plan(options: &PlanOptions) -> Result<Plan, String> {
    let mut children: Vec<(String, bool)> = Vec::new();
    match fs::read_dir(&options.root) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.map_err(|error| {
                    format!(
                        "cannot read the work root {}: {}",
                        options.root,
                        util::error_code(&error)
                    )
                })?;
                let name = entry.file_name().to_string_lossy().into_owned();
                let is_directory = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
                children.push((name, is_directory));
            }
        }
        // A missing root is an empty plan, not an error.
        Err(error) if error.raw_os_error() == Some(2) => {}
        Err(error) => {
            return Err(format!(
                "cannot read the work root {}: {}",
                options.root,
                util::error_code(&error)
            ));
        }
    }
    children.sort_by(|left, right| left.0.cmp(&right.0));

    let mut entries = Vec::with_capacity(children.len());
    for (name, is_directory) in children {
        let path = util::join(&options.root, &name);
        match inspect_entry(options, &name, is_directory, &path) {
            Ok(entry) => entries.push(entry),
            // The original wrapped each child in try/catch and kept it with a diagnostics reason.
            Err(message) => entries.push(Entry {
                name,
                path,
                bytes: 0.0,
                action: Action::Keep,
                reason: Some(format!("cannot inspect: {}", message)),
                mtime_ms: None,
                record: None,
            }),
        }
    }

    // The recency cushions only decide *when* a passing entry is eligible. Sort the passing entries
    // newest first so `--keep N` is stable regardless of readdir order.
    let mut passing: Vec<usize> = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| entry.action == Action::Reclaim)
        .map(|(index, _)| index)
        .collect();
    // Newest first, then name ascending. Byte order is the deterministic tie-break; the JavaScript
    // wrapper restores the runtime's `localeCompare` order for returned entries. An exact mtime tie
    // in the `--keep` ranking is therefore ordered by byte order rather than the host locale.
    passing.sort_by(|&left, &right| {
        let left_entry = &entries[left];
        let right_entry = &entries[right];
        let left_mtime = left_entry.mtime_ms.unwrap_or(0.0);
        let right_mtime = right_entry.mtime_ms.unwrap_or(0.0);
        right_mtime
            .partial_cmp(&left_mtime)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left_entry.name.cmp(&right_entry.name))
    });
    for (rank, &index) in passing.iter().enumerate() {
        let entry = &mut entries[index];
        if (rank as f64) < options.keep {
            entry.action = Action::Keep;
            entry.reason = Some(format!(
                "among the newest {} directories (--keep)",
                util::number(options.keep)
            ));
        } else if options.keep_days > 0.0
            && options.now - entry.mtime_ms.unwrap_or(0.0) < time::keep_days_ms(options.keep_days)
        {
            entry.action = Action::Keep;
            entry.reason = Some(format!(
                "modified less than {} days ago (--keep-days)",
                util::number(options.keep_days)
            ));
        }
    }
    if let Some(reason) = &options.blocked_reason {
        for entry in &mut entries {
            if entry.action == Action::Reclaim {
                entry.action = Action::Keep;
                entry.reason = Some(reason.clone());
            }
        }
    }

    let reclaimable = entries
        .iter()
        .filter(|entry| entry.action == Action::Reclaim)
        .count();
    let reclaimable_bytes = entries
        .iter()
        .filter(|entry| entry.action == Action::Reclaim)
        .fold(0.0, |total, entry| total + entry.bytes);
    let unknown = entries
        .iter()
        .filter(|entry| entry.action == Action::Unknown)
        .count();
    let kept = entries.len() - reclaimable;
    Ok(Plan {
        root: options.root.clone(),
        entries,
        reclaimable,
        reclaimable_bytes,
        kept,
        unknown,
    })
}

fn inspect_entry(
    options: &PlanOptions,
    name: &str,
    is_directory: bool,
    path: &str,
) -> Result<Entry, String> {
    let bytes = size_of(Path::new(path));
    let base = |action: Action, reason: Option<String>| Entry {
        name: name.to_string(),
        path: path.to_string(),
        bytes,
        action,
        reason,
        mtime_ms: None,
        record: None,
    };
    if !is_directory {
        return Ok(base(Action::Unknown, Some("not a directory".to_string())));
    }
    let has_git = fs::symlink_metadata(Path::new(path).join(".git")).is_ok();
    if !has_git {
        return Ok(base(
            Action::Unknown,
            Some("not a ticket clone: no .git".to_string()),
        ));
    }
    if !util::is_ticket_name(name) {
        return Ok(base(
            Action::Unknown,
            Some("not a ticket clone: name is not <name>-<hex>".to_string()),
        ));
    }
    if let Some(ticket) = options.skip_directories.get(&util::resolve(path)) {
        return Ok(base(
            Action::Keep,
            Some(format!("open ticket {} is using this directory", ticket)),
        ));
    }
    match inspect_clone(path)? {
        Gate::Keep(reason) => Ok(base(Action::Keep, Some(reason))),
        Gate::Pass(facts) => {
            let mtime_ms = mtime_ms(path)?;
            Ok(Entry {
                name: name.to_string(),
                path: path.to_string(),
                bytes,
                action: Action::Reclaim,
                reason: None,
                mtime_ms: Some(mtime_ms),
                record: Some(Record {
                    version: 1,
                    name: facts.name,
                    path: facts.path,
                    head: facts.head,
                    origin_main: facts.origin_main,
                    branch: facts.branch,
                    upstream: facts.upstream,
                    remote: facts.remote,
                    remote_name: facts.remote_name,
                    bytes,
                    when: time::iso(options.now),
                }),
            })
        }
    }
}

/// Inspect one ticket-shaped directory. `Pass` means the reconstructibility gate holds and the record
/// facts were captured; `Keep` is a failed gate with the operator-facing reason.
fn inspect_clone(path: &str) -> Result<Gate, String> {
    let holders = procscan::cwd_holders(path).map_err(|error| error.to_string())?;
    if holders.unavailable {
        return Ok(Gate::Keep(
            "cannot scan /proc to prove nothing is using it".to_string(),
        ));
    }
    if let Some(pid) = holders.pids.first() {
        return Ok(Gate::Keep(format!("cwd in use by pid {}", pid)));
    }

    let status = git::run(path, &["status", "--porcelain"]);
    if !status.ok {
        return Ok(Gate::Keep(format!(
            "git status failed: {}",
            fallback(&status.err)
        )));
    }
    if !status.out.trim().is_empty() {
        return Ok(Gate::Keep(dirty_reason(&status.out)));
    }

    let remotes = git::run(path, &["remote"]);
    if !remotes.ok {
        return Ok(Gate::Keep(format!(
            "git remote failed: {}",
            fallback(&remotes.err)
        )));
    }
    let names: Vec<String> = remotes
        .out
        .split('\n')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect();
    if names.is_empty() {
        return Ok(Gate::Keep(
            "no remote (the clone is the only copy)".to_string(),
        ));
    }

    let pushed = unpublished_reason(path);
    if let Some(reason) = pushed.reason {
        return Ok(Gate::Keep(reason));
    }

    let head = git::run(path, &["rev-parse", "HEAD"]);
    let branch = git::run(path, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let origin_main = git::run(path, &["rev-parse", "origin/main"]);
    let branch_name = if branch.ok {
        branch.out.trim().to_string()
    } else {
        String::new()
    };
    let name = if branch_name.is_empty() || branch_name == "HEAD" {
        None
    } else {
        Some(branch_name)
    };
    let remote_name = tracked_remote(path, name.as_deref(), &names);
    let remote_url = git::run(path, &["remote", "get-url", &remote_name]);
    if !head.ok || !remote_url.ok {
        return Ok(Gate::Keep(format!(
            "cannot read HEAD or the {} remote URL",
            remote_name
        )));
    }
    Ok(Gate::Pass(CloneFacts {
        name: util::basename(path),
        path: path.to_string(),
        head: head.out.trim().to_string(),
        origin_main: if origin_main.ok {
            Some(origin_main.out.trim().to_string())
        } else {
            None
        },
        branch: name,
        upstream: pushed.upstream,
        remote: remote_url.out.trim().to_string(),
        remote_name,
    }))
}

/// The remote a branch actually tracks, falling back to `origin`, then to the first configured remote.
fn tracked_remote(path: &str, branch: Option<&str>, names: &[String]) -> String {
    if let Some(branch) = branch {
        let configured = git::run(
            path,
            &["config", "--get", &format!("branch.{}.remote", branch)],
        );
        let name = if configured.ok {
            configured.out.trim().to_string()
        } else {
            String::new()
        };
        if !name.is_empty() && name != "." {
            return name;
        }
    }
    if names.iter().any(|name| name == "origin") {
        return "origin".to_string();
    }
    names
        .first()
        .cloned()
        .unwrap_or_else(|| "origin".to_string())
}

/// The unpushed commit count, or an error reason when the comparison itself cannot run.
fn unpublished_reason(path: &str) -> Unpublished {
    let upstream = git::run(
        path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    );
    if upstream.ok && !upstream.out.trim().is_empty() {
        let upstream_name = upstream.out.trim().to_string();
        let count = git::run(
            path,
            &["rev-list", "--count", &format!("{}..HEAD", upstream_name)],
        );
        if !count.ok {
            return Unpublished {
                reason: Some(format!("cannot compare HEAD with {}", upstream_name)),
                upstream: None,
            };
        }
        let commits = parse_count(&count.out);
        if commits > 0.0 {
            return Unpublished {
                reason: Some(unpushed_reason(commits)),
                upstream: None,
            };
        }
        return Unpublished {
            reason: None,
            upstream: Some(upstream_name),
        };
    }
    let origin_main = git::run(path, &["rev-parse", "origin/main"]);
    if !origin_main.ok {
        return Unpublished {
            reason: Some("no upstream and no origin/main to compare".to_string()),
            upstream: None,
        };
    }
    let count = git::run(path, &["rev-list", "--count", "origin/main..HEAD"]);
    if !count.ok {
        return Unpublished {
            reason: Some("cannot compare HEAD with origin/main".to_string()),
            upstream: None,
        };
    }
    let commits = parse_count(&count.out);
    if commits > 0.0 {
        return Unpublished {
            reason: Some(unpushed_reason(commits)),
            upstream: None,
        };
    }
    Unpublished {
        reason: None,
        upstream: None,
    }
}

/// Mirror `Number(text)`: a value that does not parse is `NaN`, and `NaN > 0` is false.
fn parse_count(text: &str) -> f64 {
    text.trim().parse::<f64>().unwrap_or(f64::NAN)
}

fn unpushed_reason(commits: f64) -> String {
    format!(
        "{} commit{} not pushed",
        util::number(commits),
        if commits == 1.0 { "" } else { "s" }
    )
}

fn fallback(err: &str) -> String {
    let line = util::first_line(err);
    if line.is_empty() {
        "unknown error".to_string()
    } else {
        line
    }
}

/// One porcelain line count, split into untracked and tracked changes for a readable reason.
fn dirty_reason(porcelain: &str) -> String {
    let mut untracked = 0_usize;
    let mut modified = 0_usize;
    for line in porcelain.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        if line.starts_with("?? ") {
            untracked += 1;
        } else {
            modified += 1;
        }
    }
    let mut parts = Vec::new();
    if untracked > 0 {
        parts.push(format!(
            "{} untracked path{}",
            untracked,
            if untracked == 1 { "" } else { "s" }
        ));
    }
    if modified > 0 {
        parts.push(format!(
            "{} modified path{}",
            modified,
            if modified == 1 { "" } else { "s" }
        ));
    }
    if parts.is_empty() {
        "working tree not clean".to_string()
    } else {
        parts.join(", ")
    }
}

/// Total size of one entry without following symlinks; an unreadable subtree counts as zero.
///
/// Iterative rather than recursive: the planner runs inside the service process, and a
/// pathologically deep tree must not overflow the stack.
fn size_of(path: &Path) -> f64 {
    let mut total = 0.0;
    let mut pending = vec![path.to_path_buf()];
    while let Some(current) = pending.pop() {
        let info = match fs::symlink_metadata(&current) {
            Ok(info) => info,
            Err(_) => continue,
        };
        if !info.is_dir() {
            total += info.len() as f64;
            continue;
        }
        match fs::read_dir(&current) {
            Ok(entries) => {
                for entry in entries.filter_map(Result::ok) {
                    pending.push(entry.path());
                }
            }
            // An unreadable directory contributes nothing; the JavaScript version returned 0 for it.
            Err(_) => continue,
        }
    }
    total
}

/// `stat(path).mtimeMs`.
fn mtime_ms(path: &str) -> Result<f64, String> {
    let modified = fs::metadata(path)
        .and_then(|meta| meta.modified())
        .map_err(|error| error.to_string())?;
    Ok(system_time_ms(modified))
}

fn system_time_ms(value: SystemTime) -> f64 {
    match value.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs_f64() * 1000.0,
        Err(error) => -(error.duration().as_secs_f64() * 1000.0),
    }
}
