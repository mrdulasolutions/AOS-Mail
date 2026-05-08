import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./styles/index.css";
import { installElectronShim } from "./lib/electron-shim";
import { installMenuBridge } from "./lib/menu-bridge";
import { installDragBridge } from "./lib/drag-bridge";

// Under Tauri there is no Electron preload — install a window.api proxy so
// legacy components don't crash on first call. No-op under Electron (preload
// already populated window.api).
installElectronShim();

// Native menu items (File → New Message, Mailbox → Reply, etc.) emit
// Tauri events; this hooks them up to DOM custom events the rest of the
// app can subscribe to.
installMenuBridge();

// Tauri 2 doesn't honor `-webkit-app-region: drag`, so the .titlebar-drag
// regions need an explicit JS handler that asks Tauri to drag the window
// on mousedown and toggles maximize on double-click. No-op under Electron.
installDragBridge();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 1000 * 60 * 5, // 5 minutes
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
