import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;

/** Browser smoke tests against a production build in demo mode: no service, no secrets. */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "off" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npm run start -- -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/login`,
    env: { HOMEPILOT_MODE: "demo" },
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
