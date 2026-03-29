use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

/// A snapshot of the .vibe directory: maps relative paths to their last-modified time.
type Snapshot = HashMap<PathBuf, Option<SystemTime>>;

/// Takes a snapshot of all files and directories under `dir`, recording their
/// modification times. Skips the `.state` file.
fn take_snapshot(dir: &Path) -> Snapshot {
    let mut snap = HashMap::new();

    for entry in WalkDir::new(dir).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();

        // Skip .state file
        if let Some(name) = path.file_name() {
            if name == ".state" {
                continue;
            }
        }

        let rel = path.strip_prefix(dir).unwrap_or(path).to_path_buf();
        let mtime = fs::metadata(path).ok().and_then(|m| m.modified().ok());
        snap.insert(rel, mtime);
    }

    snap
}

/// Watches the .vibe directory by polling for changes every `interval`.
/// Emits "vibe-fs-changed" to the frontend only when the directory snapshot changes.
pub fn start_watcher(base: &Path, app: AppHandle) {
    let vibe_dir = base.join(".vibe");

    // Ensure the directory exists before watching
    if !vibe_dir.exists() {
        fs::create_dir_all(&vibe_dir).ok();
    }

    let watch_path = vibe_dir.clone();
    let interval = Duration::from_secs(1);

    thread::spawn(move || {
        let mut prev_snapshot = take_snapshot(&watch_path);

        loop {
            thread::sleep(interval);

            let current_snapshot = take_snapshot(&watch_path);

            if current_snapshot != prev_snapshot {
                let _ = app.emit("vibe-fs-changed", ());
                prev_snapshot = current_snapshot;
            }
        }
    });
}
