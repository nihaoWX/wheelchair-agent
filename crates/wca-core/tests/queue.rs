//! Queue branch coverage: layout, directory creation, pending ordering, read/consume/quarantine,
//! and the atomic outbox write.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};
use wca_core::queue::{self, QueueDirs, QueueRequest};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct Sandbox {
    base: PathBuf,
}

impl Sandbox {
    fn new() -> Self {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "wca-queue-test-{}-{}-{}",
            std::process::id(),
            unique,
            stamp
        ));
        fs::create_dir_all(&base).unwrap();
        Self { base }
    }

    fn root(&self) -> PathBuf {
        self.base.join("queue")
    }

    fn dirs(&self) -> QueueDirs {
        queue::layout(self.root().to_str().unwrap())
    }

    fn dirs_value(&self) -> Value {
        serde_json::to_value(self.dirs()).unwrap()
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn request(value: Value) -> QueueRequest {
    serde_json::from_value(value).expect("a valid queue request")
}

fn set_age(path: &Path, seconds_ago: f64) {
    let target = SystemTime::now() - Duration::from_secs_f64(seconds_ago);
    fs::File::open(path).unwrap().set_modified(target).unwrap();
}

#[test]
fn layout_is_normalised_like_node_path_join() {
    let dirs = queue::layout("/tmp//wca/./queue");
    assert_eq!(dirs.root, "/tmp//wca/./queue");
    assert_eq!(dirs.pending, "/tmp/wca/queue/pending");
    assert_eq!(dirs.done, "/tmp/wca/queue/done");
    assert_eq!(dirs.outbox, "/tmp/wca/queue/outbox");
    assert_eq!(dirs.read, "/tmp/wca/queue/outbox/read");
    // The response keeps the caller's root verbatim, exactly like `dirsOf`.
    let value = serde_json::to_value(dirs).unwrap();
    assert_eq!(value["pending"], "/tmp/wca/queue/pending");
}

#[test]
fn ensure_creates_the_four_owned_directories_but_not_read() {
    let boxed = Sandbox::new();
    let dirs = boxed.dirs();
    let result = queue::run(&request(json!({
        "op": "ensure-dirs",
        "dirs": boxed.dirs_value(),
    })))
    .unwrap();
    assert_eq!(result, Value::Null);
    for directory in [&dirs.root, &dirs.pending, &dirs.done, &dirs.outbox] {
        assert!(Path::new(directory).is_dir(), "{} exists", directory);
    }
    assert!(
        !Path::new(&dirs.read).exists(),
        "outbox/read belongs to the reader"
    );
}

#[test]
fn pending_names_is_oldest_first_and_skips_non_tasks_and_dotfiles() {
    let boxed = Sandbox::new();
    let dirs = boxed.dirs();
    fs::create_dir_all(&dirs.pending).unwrap();
    for (name, age) in [
        ("newer.json", 1.0),
        ("older.json", 10.0),
        (".hidden.json", 20.0),
    ] {
        let path = Path::new(&dirs.pending).join(name);
        fs::write(&path, "{}").unwrap();
        set_age(&path, age);
    }
    fs::write(Path::new(&dirs.pending).join("notes.txt"), "x").unwrap();

    let names = queue::pending_names(&dirs).unwrap();
    assert_eq!(names, vec!["older.json", "newer.json"]);
    // A missing directory reads as empty.
    let missing = queue::layout(boxed.base.join("missing").to_str().unwrap());
    assert_eq!(
        queue::pending_names(&missing).unwrap(),
        Vec::<String>::new()
    );
}

#[test]
fn read_consume_and_quarantine_use_the_same_destination_names() {
    let boxed = Sandbox::new();
    let dirs = boxed.dirs();
    fs::create_dir_all(&dirs.done).unwrap();
    fs::create_dir_all(&dirs.pending).unwrap();
    let task = Path::new(&dirs.pending).join("task.json");
    fs::write(&task, "{\"id\":\"t\",\"text\":\"do it\"}").unwrap();

    let parsed = queue::read_task(task.to_str().unwrap()).unwrap();
    assert_eq!(parsed["id"], "t");

    queue::consume_task(task.to_str().unwrap(), &dirs).unwrap();
    assert!(!task.exists());
    assert!(Path::new(&dirs.done).join("task.json").exists());

    let bad = Path::new(&dirs.pending).join("bad.json");
    fs::write(&bad, "not json").unwrap();
    let error = queue::read_task(bad.to_str().unwrap()).unwrap_err();
    assert_eq!(error.code, "invalid_json");
    assert!(error.message.contains("bad.json"), "{}", error.message);
    queue::quarantine_task(bad.to_str().unwrap(), &dirs).unwrap();
    assert!(!bad.exists());
    assert!(Path::new(&dirs.done).join("bad.json.bad").exists());
}

#[test]
fn read_task_reports_a_node_shaped_enoent() {
    let boxed = Sandbox::new();
    let missing = boxed.base.join("no-such-task.json");
    let error = queue::read_task(missing.to_str().unwrap()).unwrap_err();
    assert_eq!(error.code, "ENOENT");
    assert_eq!(
        error.message,
        format!(
            "ENOENT: no such file or directory, open '{}'",
            missing.to_str().unwrap()
        )
    );
}

#[test]
fn write_message_is_keyed_by_id_and_uses_the_safe_name() {
    let boxed = Sandbox::new();
    let dirs = boxed.dirs();
    let message = json!({ "id": "a b/c", "text": "hi", "n": 2 });
    queue::write_message(&dirs, &message).unwrap();
    let file = Path::new(&dirs.outbox).join("a_b_c.json");
    assert!(file.is_file(), "the safe id names the file");
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.ends_with('\n'));
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap(),
        message,
        "the payload round-trips"
    );
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o644
    );

    queue::write_message(&dirs, &json!({ "id": "a b/c", "text": "again" })).unwrap();
    let files: Vec<_> = fs::read_dir(&dirs.outbox)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".json"))
        .collect();
    assert_eq!(files, vec!["a_b_c.json"], "a repeated id overwrites");
}
