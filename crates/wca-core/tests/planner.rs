//! Branch coverage for the migrated planner.
//!
//! These are the Rust counterpart of the planning cases in `tests/test-work.mjs`: they create real
//! local git repositories in a throwaway directory (no network, no credentials) and assert the same
//! gate decisions and user-visible reasons. The parity gate itself stays `tests/test-work.mjs`; these
//! tests make `cargo test` meaningful on its own, which is what CI runs.

use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use wca_core::plan::{plan, Action, Entry, PlanOptions};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct Sandbox {
    base: PathBuf,
    config: PathBuf,
}

impl Sandbox {
    fn new() -> Self {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "wca-core-test-{}-{}-{}",
            std::process::id(),
            unique,
            stamp
        ));
        fs::create_dir_all(&base).unwrap();
        let config = base.join("gitconfig");
        fs::write(
            &config,
            "[user]\n\tname = Test Runner\n\temail = test@example.invalid\n\
             [init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
        )
        .unwrap();
        Self { base, config }
    }

    fn root(&self) -> PathBuf {
        let root = self.base.join("work");
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn git(&self, cwd: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_GLOBAL", &self.config)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    /// A local bare remote with one commit on `main`, reachable as an absolute path.
    fn remote(&self, name: &str) -> PathBuf {
        let seed = self.base.join("seed").join(name);
        fs::create_dir_all(&seed).unwrap();
        self.git(
            &self.base,
            &["init", "-q", "-b", "main", seed.to_str().unwrap()],
        );
        fs::write(seed.join("README.md"), format!("{}\n", name)).unwrap();
        self.git(&seed, &["add", "-A"]);
        self.git(&seed, &["commit", "-qm", "init"]);
        let bare = self.base.join("remotes").join(format!("{}.git", name));
        fs::create_dir_all(bare.parent().unwrap()).unwrap();
        self.git(
            &self.base,
            &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()],
        );
        self.git(&seed, &["remote", "add", "origin", bare.to_str().unwrap()]);
        self.git(&seed, &["push", "-q", "origin", "main"]);
        bare
    }

    /// A clean clone of `name` at `<root>/<name>-<hex>`, tracking `origin/main`.
    fn clone_ticket(&self, root: &Path, name: &str, hex: &str) -> PathBuf {
        let bare = self.remote(name);
        let directory = root.join(format!("{}-{}", name, hex));
        self.git(
            &self.base,
            &[
                "clone",
                "-q",
                bare.to_str().unwrap(),
                directory.to_str().unwrap(),
            ],
        );
        directory
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn options(root: &Path) -> PlanOptions {
    PlanOptions::new(root.to_string_lossy().into_owned())
}

fn entry<'a>(entries: &'a [Entry], name: &str) -> &'a Entry {
    entries
        .iter()
        .find(|entry| entry.name == name)
        .unwrap_or_else(|| panic!("the plan has an entry for {}", name))
}

fn set_days_ago(path: &Path, days: f64) {
    let target = SystemTime::now() - Duration::from_secs_f64(days * 86_400.0);
    let file = File::open(path).unwrap();
    file.set_modified(target).unwrap();
}

#[test]
fn no_remote_is_kept_as_the_only_copy() {
    let boxed = Sandbox::new();
    let root = boxed.root();
    let directory = root.join("only-copy-00000000");
    fs::create_dir_all(&directory).unwrap();
    boxed.git(&directory, &["init", "-q", "-b", "main"]);
    fs::write(directory.join("file.txt"), "only copy\n").unwrap();
    boxed.git(&directory, &["add", "-A"]);
    boxed.git(&directory, &["commit", "-qm", "init"]);

    let result = plan(&options(&root)).unwrap();
    let kept = entry(&result.entries, "only-copy-00000000");
    assert_eq!(kept.action, Action::Keep);
    assert_eq!(
        kept.reason.as_deref(),
        Some("no remote (the clone is the only copy)")
    );
    assert_eq!(result.reclaimable, 0);
}

#[test]
fn dirty_tree_is_kept_with_the_dirty_reason() {
    let boxed = Sandbox::new();
    let root = boxed.root();
    let directory = boxed.clone_ticket(&root, "dirty", "0123456789ab");
    fs::write(directory.join("untracked.txt"), "dirty\n").unwrap();

    let result = plan(&options(&root)).unwrap();
    let kept = entry(&result.entries, "dirty-0123456789ab");
    assert_eq!(kept.action, Action::Keep);
    assert_eq!(kept.reason.as_deref(), Some("1 untracked path"));
}

#[test]
fn unpushed_commit_is_kept() {
    let boxed = Sandbox::new();
    let root = boxed.root();
    let directory = boxed.clone_ticket(&root, "unpushed", "0123456789ab");
    fs::write(directory.join("local.txt"), "local only\n").unwrap();
    boxed.git(&directory, &["add", "-A"]);
    boxed.git(&directory, &["commit", "-qm", "local only"]);

    let result = plan(&options(&root)).unwrap();
    let kept = entry(&result.entries, "unpushed-0123456789ab");
    assert_eq!(kept.action, Action::Keep);
    assert_eq!(kept.reason.as_deref(), Some("1 commit not pushed"));
}

#[test]
fn clean_pushed_clone_is_reclaimed_with_its_recorded_facts() {
    let boxed = Sandbox::new();
    let root = boxed.root();
    let directory = boxed.clone_ticket(&root, "clean", "0123456789ab");
    let head = boxed
        .git(&directory, &["rev-parse", "HEAD"])
        .trim()
        .to_string();
    let origin_main = boxed
        .git(&directory, &["rev-parse", "origin/main"])
        .trim()
        .to_string();
    let remote = boxed
        .git(&directory, &["config", "--get", "remote.origin.url"])
        .trim()
        .to_string();

    let result = plan(&options(&root)).unwrap();
    assert_eq!(result.reclaimable, 1);
    assert_eq!(result.kept, 0);
    assert_eq!(result.unknown, 0);
    let reclaimed = entry(&result.entries, "clean-0123456789ab");
    assert_eq!(reclaimed.action, Action::Reclaim);
    assert!(
        reclaimed.reason.is_none(),
        "a reclaim entry carries no reason"
    );
    assert!(reclaimed.bytes > 0.0);
    let record = reclaimed
        .record
        .as_ref()
        .expect("a reclaim entry carries its record");
    assert_eq!(record.head, head);
    assert_eq!(record.origin_main.as_deref(), Some(origin_main.as_str()));
    assert_eq!(record.branch.as_deref(), Some("main"));
    assert_eq!(record.remote, remote);
    assert_eq!(record.remote_name, "origin");
    assert_eq!(record.bytes, reclaimed.bytes);
    assert_eq!(record.when.len(), 24);
    assert!(record.when.ends_with('Z'));
    assert!(result.reclaimable_bytes > 0.0);
}

#[test]
fn keep_floor_defaults_to_zero_and_protects_the_newest_when_asked() {
    let boxed = Sandbox::new();
    let root = boxed.root();
    let oldest = boxed.clone_ticket(&root, "oldest", "000000000001");
    let middle = boxed.clone_ticket(&root, "middle", "000000000002");
    let newest = boxed.clone_ticket(&root, "newest", "000000000003");
    set_days_ago(&oldest, 30.0);
    set_days_ago(&middle, 20.0);
    set_days_ago(&newest, 10.0);

    let mut zero = options(&root);
    zero.keep = 0.0;
    let all = plan(&zero).unwrap();
    assert_eq!(all.reclaimable, 3, "the default floor is zero");

    let mut floor = options(&root);
    floor.keep = 2.0;
    let result = plan(&floor).unwrap();
    assert_eq!(result.reclaimable, 1);
    assert_eq!(
        entry(&result.entries, "oldest-000000000001").action,
        Action::Reclaim
    );
    for name in ["middle-000000000002", "newest-000000000003"] {
        let kept = entry(&result.entries, name);
        assert_eq!(kept.action, Action::Keep);
        assert_eq!(
            kept.reason.as_deref(),
            Some("among the newest 2 directories (--keep)")
        );
    }
}

#[test]
fn keep_days_only_delays_passing_entries_inside_the_window() {
    let boxed = Sandbox::new();
    let root = boxed.root();
    let fresh = boxed.clone_ticket(&root, "fresh", "0123456789ab");
    let old = boxed.clone_ticket(&root, "old", "0123456789ab");
    set_days_ago(&fresh, 0.0);
    set_days_ago(&old, 30.0);

    let mut options = options(&root);
    options.keep_days = 7.0;
    let result = plan(&options).unwrap();
    assert_eq!(result.reclaimable, 1);
    assert_eq!(
        entry(&result.entries, "old-0123456789ab").action,
        Action::Reclaim
    );
    let kept = entry(&result.entries, "fresh-0123456789ab");
    assert_eq!(kept.action, Action::Keep);
    assert_eq!(
        kept.reason.as_deref(),
        Some("modified less than 7 days ago (--keep-days)")
    );
}

#[test]
fn non_ticket_directories_are_unknown_and_never_reclaimed() {
    let boxed = Sandbox::new();
    let root = boxed.root();
    let residue = root.join("state");
    fs::create_dir_all(&residue).unwrap();
    fs::write(residue.join("residue.txt"), "not a ticket\n").unwrap();
    let plain_file = root.join("plain-file.txt");
    fs::write(&plain_file, "not a directory\n").unwrap();
    let wrong_name = root.join("notaticket");
    fs::create_dir_all(&wrong_name).unwrap();
    boxed.git(&wrong_name, &["init", "-q", "-b", "main"]);

    let result = plan(&options(&root)).unwrap();
    assert_eq!(result.unknown, 3);
    assert_eq!(result.reclaimable, 0);
    assert_eq!(
        entry(&result.entries, "state").reason.as_deref(),
        Some("not a ticket clone: no .git")
    );
    assert_eq!(
        entry(&result.entries, "plain-file.txt").reason.as_deref(),
        Some("not a directory")
    );
    assert_eq!(
        entry(&result.entries, "notaticket").reason.as_deref(),
        Some("not a ticket clone: name is not <name>-<hex>")
    );
    assert!(result
        .entries
        .iter()
        .all(|entry| entry.action != Action::Reclaim));
    assert!(
        residue.join("residue.txt").exists(),
        "the plan never deletes"
    );
}

#[test]
fn a_failing_gate_never_becomes_a_reclaim_through_the_cushions() {
    let boxed = Sandbox::new();
    let root = boxed.root();
    // Fresh directory with no remote: only a gate failure keeps it.
    let directory = root.join("only-copy-01234567");
    fs::create_dir_all(&directory).unwrap();
    boxed.git(&directory, &["init", "-q", "-b", "main"]);
    fs::write(directory.join("file.txt"), "only copy\n").unwrap();
    boxed.git(&directory, &["add", "-A"]);
    boxed.git(&directory, &["commit", "-qm", "init"]);

    let mut options = options(&root);
    options.keep = 5.0;
    options.keep_days = 365.0;
    let result = plan(&options).unwrap();
    let kept = entry(&result.entries, "only-copy-01234567");
    assert_eq!(kept.action, Action::Keep);
    assert_eq!(
        kept.reason.as_deref(),
        Some("no remote (the clone is the only copy)"),
        "the gate reason, not a cushion reason"
    );
    assert_eq!(result.reclaimable, 0);
}

#[test]
fn blocked_open_ticket_answer_keeps_every_passing_entry() {
    let boxed = Sandbox::new();
    let root = boxed.root();
    boxed.clone_ticket(&root, "clean", "0123456789ab");

    let mut options = options(&root);
    options.blocked_reason = Some("cannot read open tickets: test; keeping everything".to_string());
    let result = plan(&options).unwrap();
    let kept = entry(&result.entries, "clean-0123456789ab");
    assert_eq!(kept.action, Action::Keep);
    assert_eq!(
        kept.reason.as_deref(),
        Some("cannot read open tickets: test; keeping everything")
    );
    assert_eq!(result.reclaimable, 0);
}
