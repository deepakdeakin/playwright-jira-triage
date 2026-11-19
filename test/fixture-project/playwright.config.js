import { defineConfig } from "@playwright/test";
// Browser-free fixture: projects are named like real browsers so the report has the same shape.
export default defineConfig({
  testDir: "tests",
  retries: 1,
  reporter: [["json", { outputFile: "results.json" }]],
  projects: [{ name: "chromium" }, { name: "firefox" }],
});
