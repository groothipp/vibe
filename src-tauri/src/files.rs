use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};


#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<FileNode>,
}

/// Get the .vibe directory for the given base path, creating it if needed.
pub fn vibe_dir(base: &Path) -> PathBuf {
    let dir = base.join(".vibe");
    if !dir.exists() {
        fs::create_dir_all(&dir).ok();
    }
    dir
}

/// Build a tree of the .vibe directory.
pub fn get_file_tree(base: &Path) -> FileNode {
    let vibe = vibe_dir(base);
    build_tree(&vibe, &vibe)
}

fn build_tree(path: &Path, root: &Path) -> FileNode {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| ".vibe".to_string());

    let rel_path = path
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    if path.is_dir() {
        let mut children: Vec<FileNode> = fs::read_dir(path)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                !name.starts_with('.')
            })
            .map(|e| build_tree(&e.path(), root))
            .collect();

        // Sort: dirs first, then alphabetical
        children.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        FileNode {
            name,
            path: rel_path,
            is_dir: true,
            children,
        }
    } else {
        FileNode {
            name,
            path: rel_path,
            is_dir: false,
            children: vec![],
        }
    }
}

/// Read a file's content relative to .vibe/
pub fn read_file(base: &Path, rel_path: &str) -> Result<String, String> {
    let full = vibe_dir(base).join(rel_path);
    fs::read_to_string(&full).map_err(|e| format!("Failed to read {}: {}", rel_path, e))
}

/// Write content to a file relative to .vibe/
pub fn write_file(base: &Path, rel_path: &str, content: &str) -> Result<(), String> {
    let full = vibe_dir(base).join(rel_path);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&full, content).map_err(|e| format!("Failed to write {}: {}", rel_path, e))
}

/// Create a new directory relative to .vibe/
pub fn create_dir(base: &Path, rel_path: &str) -> Result<(), String> {
    let vibe = vibe_dir(base);
    if rel_path.is_empty() {
        // Just ensure .vibe/ exists (already done by vibe_dir)
        return Ok(());
    }
    let full = vibe.join(rel_path);
    fs::create_dir_all(&full).map_err(|e| format!("Failed to create dir {}: {}", rel_path, e))
}

/// Delete a file or directory relative to .vibe/
pub fn delete_path(base: &Path, rel_path: &str) -> Result<(), String> {
    let full = vibe_dir(base).join(rel_path);
    if full.is_dir() {
        fs::remove_dir_all(&full).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&full).map_err(|e| e.to_string())
    }
}

/// Rename/move a path relative to .vibe/
pub fn rename_path(base: &Path, old_rel: &str, new_rel: &str) -> Result<(), String> {
    let vibe = vibe_dir(base);
    let old_full = vibe.join(old_rel);
    let new_full = vibe.join(new_rel);
    if let Some(parent) = new_full.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&old_full, &new_full).map_err(|e| e.to_string())
}

/// Read the .state JSON file from .vibe/
pub fn read_state(base: &Path) -> String {
    let state_path = vibe_dir(base).join(".state");
    fs::read_to_string(&state_path).unwrap_or_else(|_| "{}".to_string())
}

/// Write the .state JSON file to .vibe/
pub fn write_state(base: &Path, content: &str) -> Result<(), String> {
    let state_path = vibe_dir(base).join(".state");
    fs::write(&state_path, content).map_err(|e| format!("Failed to write .state: {}", e))
}
