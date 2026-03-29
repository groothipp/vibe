use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::thread;
use tauri::{AppHandle, Emitter};

pub struct PtyState {
    sessions: Mutex<HashMap<String, PtySession>>,
}

struct PtySession {
    writer: Box<dyn Write + Send>,
    // master is kept alive to maintain the PTY
    _master: Box<dyn MasterPty + Send>,
}

impl PtyState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn create_session(
        &self,
        id: &str,
        cwd: &str,
        rows: u16,
        cols: u16,
        app: AppHandle,
    ) -> Result<(), String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        let mut cmd = CommandBuilder::new_default_prog();
        cmd.cwd(cwd);
        // Ensure we get a proper interactive shell
        cmd.env("TERM", "xterm-256color");

        let _child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {}", e))?;

        // Drop slave — we only need the master side
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to get writer: {}", e))?;

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to get reader: {}", e))?;

        let session_id = id.to_string();
        let event_name = format!("pty-output-{}", id);

        // Spawn a thread to read PTY output and emit events.
        // We must handle the case where a multi-byte UTF-8 character is split
        // across read boundaries. Leftover incomplete bytes are carried over to
        // the next read so they are never replaced with U+FFFD (�), which would
        // corrupt terminal escape sequences and freeze xterm.js.
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut carry = Vec::<u8>::new(); // incomplete UTF-8 tail from previous read
            loop {
                // Read into the buffer, leaving room after any carried bytes
                let start = carry.len();
                if start >= buf.len() {
                    // Shouldn't happen, but protect against infinite loops
                    carry.clear();
                    continue;
                }
                match reader.read(&mut buf[start..]) {
                    Ok(0) => break,
                    Ok(n) => {
                        // Prepend carried bytes
                        buf[..start].copy_from_slice(&carry);
                        carry.clear();
                        let total = start + n;

                        // Find the longest valid UTF-8 prefix
                        let slice = &buf[..total];
                        match std::str::from_utf8(slice) {
                            Ok(s) => {
                                let _ = app.emit(&event_name, s.to_string());
                            }
                            Err(e) => {
                                let valid_up_to = e.valid_up_to();
                                // Emit the valid portion
                                if valid_up_to > 0 {
                                    let s = std::str::from_utf8(&slice[..valid_up_to]).unwrap();
                                    let _ = app.emit(&event_name, s.to_string());
                                }
                                // Carry over the incomplete trailing bytes
                                carry.extend_from_slice(&slice[valid_up_to..]);
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            // Emit a close event when the shell exits
            let _ = app.emit(&format!("pty-close-{}", session_id), ());
        });

        let session = PtySession {
            writer,
            _master: pair.master,
        };

        self.sessions.lock().insert(id.to_string(), session);
        Ok(())
    }

    pub fn write_to_session(&self, id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock();
        if let Some(session) = sessions.get_mut(id) {
            session
                .writer
                .write_all(data.as_bytes())
                .map_err(|e| format!("Write failed: {}", e))?;
            session
                .writer
                .flush()
                .map_err(|e| format!("Flush failed: {}", e))?;
            Ok(())
        } else {
            Err(format!("Session {} not found", id))
        }
    }

    pub fn resize_session(&self, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let sessions = self.sessions.lock();
        if let Some(session) = sessions.get(id) {
            session
                ._master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| format!("Resize failed: {}", e))?;
            Ok(())
        } else {
            Err(format!("Session {} not found", id))
        }
    }

    pub fn close_session(&self, id: &str) {
        self.sessions.lock().remove(id);
    }
}
