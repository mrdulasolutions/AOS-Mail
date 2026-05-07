// Stand-in for the Electron-era `ElectronAPI` type that env.d.ts used to
// import. The renderer's component-local `declare global { interface Window
// { api: SomeShape } }` blocks merge with this — making it `any` here means
// every site-local shape is treated as a refinement, not a conflict.
//
// Replacing this `any` with a real generated contract (one shape derived
// from sidecar/src/methods/* + the shim's installRealNamespaces) is the
// next migration pass. Until then, the loud auto-stub warning in
// electron-shim.ts is the runtime safety net for missing wires.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ElectronAPI = any;
