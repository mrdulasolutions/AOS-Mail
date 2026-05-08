// Renderer-side re-export of the renderer's `window.api` type.
//
// Historical note: this file used to alias `ElectronAPI` to `any` because
// the surface was so dynamic and the contract so sparse that nothing
// short-of-runtime caught a typo. With sidecar-contract.ts now feeding
// SidecarMethodResult into `src/shared/window-api.ts`, every namespace is
// type-checked at the call site and `satisfies WindowApi` enforces the
// shim provides every method the renderer expects.
//
// `ElectronAPI` is kept as a name alias so env.d.ts and any third-party
// types referencing it continue to resolve without a churn pass.

import type { WindowApi } from "../../shared/window-api";

export type ElectronAPI = WindowApi;
export type { WindowApi };
export type { IpcResponse } from "../../shared/window-api";
