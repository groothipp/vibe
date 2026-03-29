use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    let args: Vec<String> = env::args().collect();

    let target_dir = if args.len() > 1 {
        let p = PathBuf::from(&args[1]);
        if p.is_absolute() {
            p
        } else {
            env::current_dir()
                .expect("Failed to get current directory")
                .join(p)
        }
    } else {
        env::current_dir().expect("Failed to get current directory")
    };

    let target_dir = target_dir
        .canonicalize()
        .unwrap_or_else(|_| {
            eprintln!("Error: directory '{}' does not exist", target_dir.display());
            std::process::exit(1);
        });

    if !target_dir.is_dir() {
        eprintln!("Error: '{}' is not a directory", target_dir.display());
        std::process::exit(1);
    }

    // Find the Tauri app binary. Check in order:
    // 1. VIBE_APP_PATH env var
    // 2. Next to this CLI binary
    // 3. Known build output path relative to this source
    let app_binary = find_app_binary();

    match app_binary {
        Some(bin) => {
            // Clear macOS quarantine/provenance flags that block unsigned binaries
            #[cfg(target_os = "macos")]
            {
                let _ = Command::new("xattr")
                    .args(["-cr", &bin.to_string_lossy()])
                    .output();
            }

            let status = Command::new(&bin)
                .current_dir(&target_dir)
                .spawn();

            match status {
                Ok(_) => {
                    // Spawned successfully, CLI exits immediately
                }
                Err(e) => {
                    eprintln!("Error: failed to launch vibe editor");
                    eprintln!("  binary: {}", bin.display());
                    eprintln!("  dir:    {}", target_dir.display());
                    eprintln!("  cause:  {}", e);
                    if e.raw_os_error() == Some(13) {
                        eprintln!();
                        eprintln!("Hint: macOS may be blocking the unsigned binary.");
                        eprintln!("  Try: xattr -cr {}", bin.display());
                    }
                    std::process::exit(1);
                }
            }
        }
        None => {
            eprintln!("Error: could not find the Vibe Editor app binary.");
            eprintln!();
            eprintln!("Set VIBE_APP_PATH to the path of the built Tauri binary, or");
            eprintln!("place the 'vibe-editor' binary next to this CLI.");
            std::process::exit(1);
        }
    }
}

fn find_app_binary() -> Option<PathBuf> {
    // 1. VIBE_APP_PATH env var
    if let Ok(p) = env::var("VIBE_APP_PATH") {
        let path = PathBuf::from(p);
        if path.exists() {
            return Some(path);
        }
    }

    // 2. Next to this CLI binary
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("vibe-editor");
            if candidate.exists() {
                return Some(candidate);
            }
            // macOS .app bundle
            let candidate = dir.join("Vibe Editor.app/Contents/MacOS/Vibe Editor");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    // 3. Relative to CLI source (dev convenience): cli/ is next to src-tauri/
    //    Prefer release builds — debug builds require a dev server running.
    if let Ok(exe) = env::current_exe() {
        if let Some(cli_target) = exe.parent() {
            for depth in &["../../..", "../.."] {
                let cli_root = cli_target.join(depth);
                // Release first, then debug
                let candidates = [
                    cli_root.join("src-tauri/target/release/vibe-editor"),
                    cli_root.join("src-tauri/target/debug/vibe-editor"),
                ];
                for c in &candidates {
                    if let Ok(p) = c.canonicalize() {
                        if p.exists() {
                            return Some(p);
                        }
                    }
                }
            }
        }
    }

    // 4. Standard install locations
    #[cfg(target_os = "macos")]
    {
        let app_path = PathBuf::from("/Applications/Vibe Editor.app/Contents/MacOS/Vibe Editor");
        if app_path.exists() {
            return Some(app_path);
        }
    }

    #[cfg(target_os = "linux")]
    {
        let candidates = [
            PathBuf::from("/usr/bin/vibe-editor"),
            PathBuf::from("/usr/local/bin/vibe-editor"),
        ];
        for c in &candidates {
            if c.exists() {
                return Some(c.clone());
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let candidates = [
            PathBuf::from(r"C:\Program Files\Vibe\vibe-editor.exe"),
            PathBuf::from(r"C:\Program Files\Vibe Editor\Vibe Editor.exe"),
        ];
        for c in &candidates {
            if c.exists() {
                return Some(c.clone());
            }
        }
    }

    // 5. Check if it's in PATH
    if let Ok(output) = Command::new("which").arg("vibe-editor").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }

    None
}
