// Regenerate test/fixture-project/results.json from a real Playwright run, with
// machine-specific absolute paths removed so the fixture is safe to commit.
//   cd test/fixture-project && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install && npx playwright test; cd ../..
//   node test/make-fixture.mjs
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "test", "fixture-project");
const reportPath = join(fixture, "results.json");
const attachDir = join(fixture, "attachments");
mkdirSync(attachDir, { recursive: true });

const report = JSON.parse(readFileSync(reportPath, "utf8"));
let n = 0;
const visit = (o) => {
  if (Array.isArray(o)) return o.forEach(visit);
  if (!o || typeof o !== "object") return;
  for (const r of o.results ?? []) {
    for (const a of r.attachments ?? []) {
      if (a.path && a.path.startsWith("/")) {
        const name = `${basename(dirname(a.path))}-${basename(a.path)}`.slice(-90);
        if (existsSync(a.path)) copyFileSync(a.path, join(attachDir, name));
        a.path = relative(root, join(attachDir, name));
        n++;
      }
    }
  }
  Object.values(o).forEach(visit);
};
visit(report);

// Strip the absolute repo prefix everywhere else (stacks, config, locations).
const text = JSON.stringify(report, null, 2).split(root + "/").join("").split(root).join(".");
writeFileSync(reportPath, text + "\n");
console.log(`Fixture written. ${n} attachment path(s) made relative.`);
