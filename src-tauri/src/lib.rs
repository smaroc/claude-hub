use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read as IoRead, Write as IoWrite};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub mode: String,
}

struct PtySession {
    writer: Box<dyn IoWrite + Send>,
    _pair: portable_pty::PtyPair,
}

pub struct AppData {
    sessions: Mutex<HashMap<String, PtySession>>,
}

#[tauri::command]
fn spawn_claude(
    app: AppHandle,
    data: State<AppData>,
    path: String,
    mode: String,
) -> Result<SessionInfo, String> {
    let session_id = Uuid::new_v4().to_string();
    let name = path.split('/').filter(|s| !s.is_empty()).last().unwrap_or("session").to_string();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new("claude");
    cmd.cwd(&path);
    cmd.env("TERM", "xterm-256color");
    cmd.env_remove("CLAUDECODE");

    if mode == "dangerously-skip-permissions" {
        cmd.arg("--dangerously-skip-permissions");
    }

    let _child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn claude: {}. Is claude CLI installed?", e))?;

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let sid = session_id.clone();
    let app_clone = app.clone();

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    app_clone.emit(&format!("pty-exit-{}", sid), ()).ok();
                    break;
                }
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    app_clone.emit(&format!("pty-data-{}", sid), text).ok();
                }
            }
        }
    });

    let session = PtySession { writer, _pair: pair };
    data.sessions.lock().unwrap().insert(session_id.clone(), session);

    Ok(SessionInfo {
        id: session_id,
        name,
        path,
        mode,
    })
}

#[tauri::command]
fn write_pty(data: State<AppData>, session_id: String, input: String) -> Result<(), String> {
    let mut sessions = data.sessions.lock().unwrap();
    let session = sessions.get_mut(&session_id).ok_or("Session not found")?;
    session.writer.write_all(input.as_bytes()).map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn resize_pty(data: State<AppData>, session_id: String, rows: u16, cols: u16) -> Result<(), String> {
    let sessions = data.sessions.lock().unwrap();
    let session = sessions.get(&session_id).ok_or("Session not found")?;
    session._pair.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn kill_session(data: State<AppData>, session_id: String) {
    data.sessions.lock().unwrap().remove(&session_id);
}

#[tauri::command]
fn pick_folder() -> Option<String> {
    let output = std::process::Command::new("osascript")
        .args(["-e", "set theFolder to POSIX path of (choose folder with prompt \"Select project folder\")"])
        .output()
        .ok()?;
    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() { None } else { Some(path) }
    } else {
        None
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_data = AppData {
        sessions: Mutex::new(HashMap::new()),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(app_data)
        .invoke_handler(tauri::generate_handler![
            spawn_claude,
            write_pty,
            resize_pty,
            kill_session,
            pick_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
