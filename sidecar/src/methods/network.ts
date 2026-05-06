// Network status methods.
//
// Lifted from src/main/ipc/outbox.ipc.ts (`network:*` handlers) and
// src/main/services/network-monitor.ts. The Electron version used
// `net.isOnline()` and `powerMonitor.resume` events; here we keep a simple
// in-memory flag updated by the renderer's `navigator.onLine`. Wake-from-
// sleep recovery will be reintroduced via a Tauri OS event listener
// (tauri-plugin-os) in a follow-up.
//
// Server-sent events: when status flips, we push `network:online` /
// `network:offline` notifications up to the Rust shell, which re-emits them
// as Tauri events for the renderer to consume.

import { emit, registerMethod } from "../rpc.js";

let isOnline = true;

export function getStatus(): boolean {
  return isOnline;
}

function setStatus(next: boolean): void {
  if (isOnline === next) return;
  isOnline = next;
  emit(next ? "network:online" : "network:offline");
}

export function registerNetworkMethods(): void {
  registerMethod("network.getStatus", () => ({ online: isOnline }));

  registerMethod("network.updateStatus", (params) => {
    const next = !!(params as { online?: boolean })?.online;
    setStatus(next);
    return { online: isOnline };
  });

  // Force-offline path used by send failures elsewhere — exposed so future
  // sidecar code can flip the state when a transport-level error occurs.
  registerMethod("network.setOffline", () => {
    setStatus(false);
    return { online: isOnline };
  });
}
