/// <reference types="vite/client" />

import type { ElectronAPI } from "./types/window-api";

declare global {
  interface Window {
    api: ElectronAPI;
  }
}
