import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:47810",
  },
  webServer: {
    command: "node e2e/server.mjs",
    url: "http://127.0.0.1:47810/",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
