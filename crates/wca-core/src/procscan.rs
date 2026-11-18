//! The `/proc` cwd scan that proves no live process uses a clone.
//!
//! This is a clause-by-clause port of `cwdHolders()` in `src/shared/work.js`. The subtle part is the
//! failure policy: an unreadable pid of another user is skipped (it cannot own one of our private
//! ticket directories), but an unreadable pid of *our* user under a `hidepid` proc mount makes the
//! whole scan unavailable, and an unavailable scan must keep everything.

use std::os::unix::fs::MetadataExt;
use std::path::Path;

/// Outcome of the scan. `unavailable` means "cannot prove unused", which callers treat as held.
pub struct Holders {
    pub unavailable: bool,
    pub pids: Vec<i64>,
}

/// Processes whose cwd is `path` (or below it).
pub fn cwd_holders(path: &str) -> std::io::Result<Holders> {
    let target = std::fs::canonicalize(path)
        .map(|resolved| resolved.to_string_lossy().into_owned())
        .unwrap_or_else(|_| crate::util::resolve(path));
    let entries = match std::fs::read_dir("/proc") {
        Ok(entries) => entries,
        Err(error) => {
            if matches!(error.raw_os_error(), Some(1 | 2 | 13 | 20)) {
                return Ok(Holders {
                    unavailable: true,
                    pids: Vec::new(),
                });
            }
            return Err(error);
        }
    };
    let uid = std::fs::metadata("/proc/self").ok().map(|meta| meta.uid());
    let hiding = hidepid_active(Path::new("/proc/mounts"));
    let prefix = format!("{}/", target);
    let mut pids = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let pid = match name.parse::<i64>() {
            Ok(pid) => pid,
            Err(_) => continue,
        };
        match std::fs::read_link(format!("/proc/{}/cwd", name)) {
            Ok(cwd) => {
                let text = cwd.to_string_lossy();
                let current = text.strip_suffix(" (deleted)").unwrap_or(&text);
                if current == target || current.starts_with(&prefix) {
                    pids.push(pid);
                }
            }
            Err(error) => match error.raw_os_error() {
                // The process disappeared between readdir and readlink.
                Some(2 | 3) => continue,
                // Permission denied: the dangerous case is our own user under hidepid.
                Some(1 | 13) => {
                    let owner = std::fs::metadata(format!("/proc/{}", name))
                        .ok()
                        .map(|meta| meta.uid());
                    match owner {
                        None => {
                            if hiding || uid.is_none() {
                                return Ok(Holders {
                                    unavailable: true,
                                    pids: Vec::new(),
                                });
                            }
                            continue;
                        }
                        Some(owner) => {
                            if uid.is_some_and(|uid| owner != uid) {
                                continue;
                            }
                            if hiding {
                                return Ok(Holders {
                                    unavailable: true,
                                    pids: Vec::new(),
                                });
                            }
                            continue;
                        }
                    }
                }
                _ => {
                    return Ok(Holders {
                        unavailable: true,
                        pids: Vec::new(),
                    });
                }
            },
        }
    }
    pids.sort_unstable();
    Ok(Holders {
        unavailable: false,
        pids,
    })
}

/// True when the `/proc` mount hides process details (`hidepid=`).
fn hidepid_active(mounts: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(mounts) else {
        return false;
    };
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.get(1) != Some(&"/proc") {
            continue;
        }
        let options = fields.get(3).copied().unwrap_or("");
        if options
            .split(',')
            .any(|option| option == "hidepid" || option.starts_with("hidepid="))
        {
            return true;
        }
    }
    false
}
