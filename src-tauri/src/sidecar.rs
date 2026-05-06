// Sidecar lifecycle.
//
// Spawns the bundled `aos-mail-sidecar` Node binary, talks to it over its
// stdin/stdout using newline-delimited JSON-RPC. Each request gets a unique id;
// the response is matched up by id.
//
// This is V0 — the wire format is intentionally simple (NDJSON over stdio)
// because it's cross-platform and easy to debug. We can move to a Unix socket
// later if we need bidirectional event streaming with backpressure.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::sync::{oneshot, Mutex};

#[derive(Debug, thiserror::Error)]
pub enum SidecarError {
    #[error("sidecar spawn failed: {0}")]
    Spawn(String),
    #[error("sidecar channel closed before response")]
    ChannelClosed,
    #[error("sidecar returned error: {0}")]
    Remote(String),
    #[error("sidecar response invalid: {0}")]
    Invalid(String),
}

#[derive(Serialize)]
struct RpcRequest<'a> {
    jsonrpc: &'static str,
    id: u64,
    method: &'a str,
    params: serde_json::Value,
}

#[derive(Deserialize)]
struct RpcResponse {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<u64>,
    result: Option<serde_json::Value>,
    error: Option<RpcError>,
}

#[derive(Deserialize, Debug)]
struct RpcError {
    #[allow(dead_code)]
    code: Option<i64>,
    message: String,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<serde_json::Value, SidecarError>>>>>;

pub struct SidecarHandle {
    next_id: AtomicU64,
    pending: Pending,
    stdin_tx: tokio::sync::mpsc::UnboundedSender<String>,
}

impl SidecarHandle {
    pub fn spawn<R: Runtime>(app: AppHandle<R>) -> Result<Self, SidecarError> {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

        let sidecar = app
            .shell()
            .sidecar("aos-mail-sidecar")
            .map_err(|e| SidecarError::Spawn(e.to_string()))?;

        let (mut rx, mut child) = sidecar
            .spawn()
            .map_err(|e| SidecarError::Spawn(e.to_string()))?;

        // Forward stdin writes to the child process.
        let pending_for_writer = pending.clone();
        tokio::spawn(async move {
            while let Some(line) = stdin_rx.recv().await {
                if let Err(e) = child.write(line.as_bytes()) {
                    log::error!("sidecar stdin write failed: {}", e);
                    let mut pending = pending_for_writer.lock().await;
                    for (_, tx) in pending.drain() {
                        let _ = tx.send(Err(SidecarError::ChannelClosed));
                    }
                    break;
                }
            }
        });

        // Read sidecar stdout/stderr; route NDJSON responses back to callers.
        let pending_for_reader = pending.clone();
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => {
                        let line = String::from_utf8_lossy(&bytes).to_string();
                        for chunk in line.lines() {
                            if chunk.trim().is_empty() {
                                continue;
                            }
                            match serde_json::from_str::<RpcResponse>(chunk) {
                                Ok(resp) => {
                                    if let Some(id) = resp.id {
                                        let mut pending = pending_for_reader.lock().await;
                                        if let Some(tx) = pending.remove(&id) {
                                            let result = match (resp.result, resp.error) {
                                                (Some(v), _) => Ok(v),
                                                (_, Some(e)) => Err(SidecarError::Remote(e.message)),
                                                _ => Err(SidecarError::Invalid(
                                                    "missing result and error".into(),
                                                )),
                                            };
                                            let _ = tx.send(result);
                                        }
                                    } else {
                                        log::debug!("sidecar event: {}", chunk);
                                    }
                                }
                                Err(e) => {
                                    log::warn!("sidecar non-json line: {}: {}", e, chunk);
                                }
                            }
                        }
                    }
                    CommandEvent::Stderr(bytes) => {
                        log::debug!("sidecar stderr: {}", String::from_utf8_lossy(&bytes));
                    }
                    CommandEvent::Error(e) => {
                        log::error!("sidecar error: {}", e);
                    }
                    CommandEvent::Terminated(payload) => {
                        log::warn!("sidecar terminated: {:?}", payload);
                        let mut pending = pending_for_reader.lock().await;
                        for (_, tx) in pending.drain() {
                            let _ = tx.send(Err(SidecarError::ChannelClosed));
                        }
                        break;
                    }
                    _ => {}
                }
            }
        });

        Ok(SidecarHandle {
            next_id: AtomicU64::new(1),
            pending,
            stdin_tx,
        })
    }

    pub async fn request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, SidecarError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let payload = serde_json::to_string(&RpcRequest {
            jsonrpc: "2.0",
            id,
            method,
            params,
        })
        .map_err(|e| SidecarError::Invalid(e.to_string()))?;

        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.insert(id, tx);
        }

        // Append newline so the sidecar can split lines reliably.
        let mut line = payload;
        line.push('\n');
        self.stdin_tx
            .send(line)
            .map_err(|_| SidecarError::ChannelClosed)?;

        rx.await.map_err(|_| SidecarError::ChannelClosed)?
    }
}
