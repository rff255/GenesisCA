// Thin native host for the GenesisCA web frontend: loads the built SPA in a
// native window and provides native Save As (the dialog plugin) + file-write
// commands, since WebView2 silently drops the browser blob-download path.
// See docs/IMPACT_MAP_PWA_INSTALL.md §C.

use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

/// Header the frontend puts the save-session token in on `save_binary_chunk`.
/// The chunk itself travels as the invoke RAW BODY (an `ArrayBuffer` on the JS
/// side), so a token can't ride along in a JSON argument map — hence a header.
/// A numeric token also keeps the header pure ASCII: putting the destination
/// PATH here instead would break on any non-ASCII character in it.
const SAVE_TOKEN_HEADER: &str = "x-genesis-save-token";

/// Open binary-save sessions, keyed by token. A session is created by
/// `save_binary_begin`, fed by any number of `save_binary_chunk` calls, and
/// closed by `save_binary_end` (keep the file) or `save_binary_abort` (delete
/// the partial file). Chunking keeps peak memory bounded by the chunk size on
/// BOTH sides of the IPC boundary, so a multi-hundred-MB recording never has to
/// exist as one contiguous buffer in the Rust process.
#[derive(Default)]
struct BinarySaves {
    next: AtomicU32,
    open: Mutex<HashMap<u32, (PathBuf, File)>>,
}

fn lock_err<T>(_: T) -> String {
    "binary-save session lock is poisoned".to_string()
}

// ── Session logic, split out from the #[tauri::command] wrappers so it can be
// unit-tested without constructing a Tauri app / IPC request (see #[cfg(test)]
// at the bottom). The commands below are thin adapters. ──────────────────────

impl BinarySaves {
    fn begin(&self, path: &str) -> Result<u32, String> {
        let buf = PathBuf::from(path);
        let file = File::create(&buf).map_err(|e| e.to_string())?;
        // fetch_add returns the PREVIOUS value, so the first token is 1 — 0 is
        // never handed out, which makes a missing/zero token trivially invalid.
        let token = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.open.lock().map_err(lock_err)?.insert(token, (buf, file));
        Ok(token)
    }

    fn write(&self, token: u32, bytes: &[u8]) -> Result<(), String> {
        let mut open = self.open.lock().map_err(lock_err)?;
        let (_, file) = open
            .get_mut(&token)
            .ok_or_else(|| format!("unknown binary-save token {}", token))?;
        file.write_all(bytes).map_err(|e| e.to_string())
    }

    fn end(&self, token: u32) -> Result<(), String> {
        let entry = self.open.lock().map_err(lock_err)?.remove(&token);
        let (_, mut file) = entry.ok_or_else(|| format!("unknown binary-save token {}", token))?;
        file.flush().map_err(|e| e.to_string())
    }

    fn abort(&self, token: u32) {
        let entry = match self.open.lock() {
            Ok(mut open) => open.remove(&token),
            Err(_) => None,
        };
        if let Some((path, file)) = entry {
            drop(file); // release the handle before unlinking (Windows)
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Write text to an absolute path chosen by the user via the native Save As
/// dialog. App-defined commands don't need an ACL capability entry.
#[tauri::command]
fn save_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Create/truncate `path` and return a token identifying the open session.
#[tauri::command]
fn save_binary_begin(state: tauri::State<'_, BinarySaves>, path: String) -> Result<u32, String> {
    state.begin(&path)
}

/// Append the invoke request's raw body to the session named by the
/// `x-genesis-save-token` header.
#[tauri::command]
fn save_binary_chunk(
    state: tauri::State<'_, BinarySaves>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let token: u32 = request
        .headers()
        .get(SAVE_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("missing or invalid {} header", SAVE_TOKEN_HEADER))?;
    let bytes: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => data,
        _ => return Err("save_binary_chunk expects a raw byte body".to_string()),
    };
    state.write(token, bytes)
}

/// Flush + close the session, KEEPING the written file.
#[tauri::command]
fn save_binary_end(state: tauri::State<'_, BinarySaves>, token: u32) -> Result<(), String> {
    state.end(token)
}

/// Close the session and DELETE the partial file. Never fails on an unknown
/// token: this is the error/cancel path and must not mask the original error.
#[tauri::command]
fn save_binary_abort(state: tauri::State<'_, BinarySaves>, token: u32) -> Result<(), String> {
    state.abort(token);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(BinarySaves::default())
        .invoke_handler(tauri::generate_handler![
            save_text_file,
            save_binary_begin,
            save_binary_chunk,
            save_binary_end,
            save_binary_abort
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("genesisca_test_{}_{}", std::process::id(), name));
        p
    }

    /// The recording case: many chunks land in order and the file is exactly
    /// the concatenation — this is what makes a 500 MB WebM survive an 8 MiB
    /// chunked stream without a single byte out of place.
    #[test]
    fn chunks_concatenate_in_order() {
        let state = BinarySaves::default();
        let path = tmp("concat.bin");
        let token = state.begin(path.to_str().unwrap()).unwrap();
        let mut expected: Vec<u8> = Vec::new();
        for i in 0u16..64 {
            let chunk: Vec<u8> = (0..1000).map(|j| ((i as usize + j) % 251) as u8).collect();
            state.write(token, &chunk).unwrap();
            expected.extend_from_slice(&chunk);
        }
        state.end(token).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), expected);
        let _ = std::fs::remove_file(&path);
    }

    /// A zero-byte payload still produces a (empty) file rather than erroring.
    #[test]
    fn empty_payload_writes_an_empty_file() {
        let state = BinarySaves::default();
        let path = tmp("empty.bin");
        let token = state.begin(path.to_str().unwrap()).unwrap();
        state.end(token).unwrap();
        assert_eq!(std::fs::read(&path).unwrap().len(), 0);
        let _ = std::fs::remove_file(&path);
    }

    /// Abort must UNLINK the partial file — a truncated .webm masquerading as a
    /// recording is worse than no file. (On Windows this only works because
    /// abort drops the File handle before remove_file.)
    #[test]
    fn abort_deletes_the_partial_file() {
        let state = BinarySaves::default();
        let path = tmp("aborted.bin");
        let token = state.begin(path.to_str().unwrap()).unwrap();
        state.write(token, b"partial").unwrap();
        assert!(path.exists());
        state.abort(token);
        assert!(!path.exists(), "abort left a partial file behind");
    }

    /// Writing/ending an unknown or already-closed token is a loud error, not a
    /// silent no-op — so a bug can never look like a successful save.
    #[test]
    fn unknown_token_is_an_error() {
        let state = BinarySaves::default();
        assert!(state.write(999, b"x").is_err());
        assert!(state.end(999).is_err());
        let path = tmp("closed.bin");
        let token = state.begin(path.to_str().unwrap()).unwrap();
        state.end(token).unwrap();
        assert!(state.write(token, b"late").is_err(), "wrote after end");
        let _ = std::fs::remove_file(&path);
    }

    /// Tokens are unique and never 0, and two sessions stay independent — a
    /// screenshot saved while a recording is being written must not interleave.
    #[test]
    fn concurrent_sessions_stay_independent() {
        let state = BinarySaves::default();
        let (pa, pb) = (tmp("a.bin"), tmp("b.bin"));
        let a = state.begin(pa.to_str().unwrap()).unwrap();
        let b = state.begin(pb.to_str().unwrap()).unwrap();
        assert_ne!(a, b);
        assert!(a > 0 && b > 0);
        state.write(a, b"aaa").unwrap();
        state.write(b, b"bbbb").unwrap();
        state.write(a, b"AAA").unwrap();
        state.end(a).unwrap();
        state.end(b).unwrap();
        assert_eq!(std::fs::read(&pa).unwrap(), b"aaaAAA");
        assert_eq!(std::fs::read(&pb).unwrap(), b"bbbb");
        let _ = std::fs::remove_file(&pa);
        let _ = std::fs::remove_file(&pb);
    }

    /// begin() truncates: saving twice to the same path must not append to the
    /// previous file.
    #[test]
    fn begin_truncates_an_existing_file() {
        let state = BinarySaves::default();
        let path = tmp("truncate.bin");
        std::fs::write(&path, b"leftover-from-a-previous-save").unwrap();
        let token = state.begin(path.to_str().unwrap()).unwrap();
        state.write(token, b"new").unwrap();
        state.end(token).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        let _ = std::fs::remove_file(&path);
    }
}
