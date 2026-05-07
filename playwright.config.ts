import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Cap workers to avoid resource contention from many parallel app instances.
  // GitHub Actions ubuntu-latest has 2 vCPUs.
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI ? [["github"], ["html"]] : "html",
  timeout: 60000,
  use: {
    trace: "on-first-retry",
  },
  // The 'unit' and 'integration' projects from the Electron era have been
  // archived to tests/legacy-* — they were tightly coupled to src/main and
  // need to be rewritten against the sidecar's RPC surface (sidecar/src/).
  // Until then only e2e + problematic + benchmark are runnable.
  projects: [
    {
      name: "e2e",
      testDir: "./tests/e2e",
      testMatch: /.*\.spec\.ts/,
      // Each worker gets an isolated database via TEST_WORKER_INDEX so
      // tests across files run in parallel; tests within a describe stay
      // serial because they share an app instance.
      fullyParallel: true,
    },
    {
      name: "problematic",
      testDir: "./tests/problematic",
      testMatch: /.*\.spec\.ts/,
      // Flaky/incomplete; not in the main run. Run with --project=problematic.
      fullyParallel: false,
      workers: 1,
    },
    {
      name: "benchmark",
      testDir: "./benchmarks",
      testMatch: /.*\.spec\.ts/,
      // Performance benchmarks — not in CI. Run with --project=benchmark.
      fullyParallel: false,
      workers: 1,
    },
  ],
});
