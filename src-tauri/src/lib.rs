mod files;
mod pty;
mod watcher;

use files::FileNode;
use pty::PtyState;
use std::path::PathBuf;
use tauri::{AppHandle, State};

struct AppState {
    base_dir: PathBuf,
    pty: PtyState,
}

// ─── File Commands ───────────────────────────────────────────────

#[tauri::command]
fn get_file_tree(state: State<'_, AppState>) -> FileNode {
    files::get_file_tree(&state.base_dir)
}

#[tauri::command]
fn read_file(state: State<'_, AppState>, path: String) -> Result<String, String> {
    files::read_file(&state.base_dir, &path)
}

#[tauri::command]
fn write_file(state: State<'_, AppState>, path: String, content: String) -> Result<(), String> {
    files::write_file(&state.base_dir, &path, &content)
}

#[tauri::command]
fn create_dir(state: State<'_, AppState>, path: String) -> Result<(), String> {
    files::create_dir(&state.base_dir, &path)
}

#[tauri::command]
fn create_file(state: State<'_, AppState>, path: String) -> Result<(), String> {
    // Create an empty markdown file
    files::write_file(&state.base_dir, &path, "")
}

#[tauri::command]
fn delete_path(state: State<'_, AppState>, path: String) -> Result<(), String> {
    files::delete_path(&state.base_dir, &path)
}

#[tauri::command]
fn rename_path(
    state: State<'_, AppState>,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    files::rename_path(&state.base_dir, &old_path, &new_path)
}

#[tauri::command]
fn write_bytes_absolute(path: String, data: String) -> Result<(), String> {
    use base64::Engine;
    let full = std::path::PathBuf::from(&path);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    std::fs::write(&full, &bytes).map_err(|e| format!("Failed to write {}: {}", path, e))
}

#[tauri::command]
fn get_base_dir(state: State<'_, AppState>) -> String {
    state.base_dir.to_string_lossy().to_string()
}

#[tauri::command]
fn read_state(state: State<'_, AppState>) -> String {
    files::read_state(&state.base_dir)
}

#[tauri::command]
fn read_global_theme() -> String {
    let path = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join("vibe")
        .join("theme.json");
    std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string())
}

#[tauri::command]
fn write_global_theme(content: String) -> Result<(), String> {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join("vibe");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("theme.json"), content).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_state(state: State<'_, AppState>, content: String) -> Result<(), String> {
    files::write_state(&state.base_dir, &content)
}

// ─── PTY Commands ────────────────────────────────────────────────

#[tauri::command]
fn pty_create(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let cwd = state.base_dir.to_string_lossy().to_string();
    state.pty.create_session(&id, &cwd, rows, cols, app)
}

#[tauri::command]
fn pty_write(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    state.pty.write_to_session(&id, &data)
}

#[tauri::command]
fn pty_resize(
    state: State<'_, AppState>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    state.pty.resize_session(&id, rows, cols)
}

#[tauri::command]
fn pty_close(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.pty.close_session(&id);
    Ok(())
}

// ─── CLI Installation ────────────────────────────────────────────
// On first launch, install a `vibe` CLI command so users can run
// `vibe [dir]` from any terminal without a separate install step.

fn install_cli() {
    std::thread::spawn(|| {
        if let Err(e) = install_cli_impl() {
            eprintln!("CLI install skipped: {}", e);
        }
    });
}

fn install_cli_impl() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_str = exe.to_string_lossy().to_string();

    // Skip dev builds (running from cargo target directories)
    if exe_str.contains("target/debug") || exe_str.contains("target/release") {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        // Only install if the app is in /Applications
        if !exe_str.starts_with("/Applications/") {
            return Ok(());
        }
        install_cli_unix(&exe_str, "/usr/local/bin/vibe")
    }

    #[cfg(target_os = "linux")]
    {
        // Use APPIMAGE path if running as AppImage, otherwise the binary path
        let binary_path = std::env::var("APPIMAGE").unwrap_or_else(|_| exe_str.clone());
        let is_installed = binary_path.starts_with("/usr/")
            || binary_path.starts_with("/opt/")
            || std::env::var("APPIMAGE").is_ok();
        if !is_installed {
            return Ok(());
        }
        install_cli_unix(&binary_path, "/usr/local/bin/vibe")
    }

    #[cfg(target_os = "windows")]
    {
        install_cli_windows(&exe)
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn install_cli_unix(binary_path: &str, cli_dest: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let cli_path = PathBuf::from(cli_dest);
    let marker = "# vibe-cli-wrapper";

    // If a file already exists at the destination, only overwrite if it's ours
    if cli_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&cli_path) {
            if !content.contains(marker) {
                // Not our file — don't clobber it
                return Ok(());
            }
            if content.contains(binary_path) {
                // Already installed and pointing to the right binary
                return Ok(());
            }
        }
    }

    let script = format!(
        "#!/bin/sh\n\
         {marker}\n\
         TARGET=\"${{1:-.}}\"\n\
         if [ ! -d \"$TARGET\" ]; then echo \"vibe: '$TARGET' is not a directory\" >&2; exit 1; fi\n\
         TARGET=\"$(cd \"$TARGET\" && pwd)\"\n\
         cd \"$TARGET\" || exit 1\n\
         nohup \"{binary_path}\" >/dev/null 2>&1 &\n"
    );

    std::fs::write(&cli_path, &script).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&cli_path, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn install_cli_windows(exe: &PathBuf) -> Result<(), String> {
    // Write vibe.cmd next to the app binary
    let dir = exe.parent().ok_or("No parent dir")?;
    let cmd_path = dir.join("vibe.cmd");

    if cmd_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&cmd_path) {
            if content.contains(&exe.to_string_lossy().to_string()) {
                return Ok(()); // Already correct
            }
        }
    }

    let script = format!(
        "@echo off\r\n\
         rem vibe-cli-wrapper\r\n\
         if \"%~1\"==\"\" (set \"TARGET=.\") else (set \"TARGET=%~1\")\r\n\
         if not exist \"%TARGET%\\\" (echo vibe: '%TARGET%' is not a directory >&2 & exit /b 1)\r\n\
         pushd \"%TARGET%\"\r\n\
         start \"\" \"{}\"\r\n\
         popd\r\n",
        exe.display()
    );

    std::fs::write(&cmd_path, &script).map_err(|e| e.to_string())?;

    // Add the app directory to the user's PATH if not already there
    #[cfg(target_os = "windows")]
    {
        let dir_str = dir.to_string_lossy().to_string();
        if let Ok(path) = std::env::var("PATH") {
            if !path.contains(&dir_str) {
                let _ = std::process::Command::new("setx")
                    .args(["PATH", &format!("{};{}", path, dir_str)])
                    .output();
            }
        }
    }

    Ok(())
}

// ─── App Setup ───────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Use current working directory as the base
    let base_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

    let base_for_watcher = base_dir.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            base_dir,
            pty: PtyState::new(),
        })
        .invoke_handler(tauri::generate_handler![
            get_file_tree,
            read_file,
            write_file,
            create_dir,
            create_file,
            delete_path,
            rename_path,
            get_base_dir,
            read_state,
            write_state,
            pty_create,
            pty_write,
            pty_resize,
            pty_close,
            write_bytes_absolute,
            read_global_theme,
            write_global_theme,
        ])
        .setup(move |app| {
            install_cli();
            watcher::start_watcher(&base_for_watcher, app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
