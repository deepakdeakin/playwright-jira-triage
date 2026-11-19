import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyse, normaliseError } from "../src/report.js";
import { run } from "../src/main.js";
import { startMockJira } from "./mock-jira.js";

const REPORT = fileURLToPath(new URL("./fixture-project/results.json", import.meta.url));
const report = JSON.parse(await readFile(REPORT, "utf8"));

async function envFor(jiraUrl, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pjt-"));
  const env = {
    "INPUT_REPORT-PATH": REPORT,
    "INPUT_JIRA-BASE-URL": jiraUrl,
    "INPUT_JIRA-EMAIL": "bot@example.com",
    "INPUT_JIRA-API-TOKEN": "token123",
    "INPUT_PROJECT-KEY": "QA",
    GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "acme/shop", GITHUB_RUN_ID: "42", GITHUB_RUN_NUMBER: "7",
    GITHUB_SHA: "abcdef1234567890", GITHUB_REF_NAME: "main", GITHUB_ACTOR: "dev1",
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"), GITHUB_OUTPUT: join(dir, "output.txt"),
    ...extra,
  };
  return { env, dir };
}
const quiet = () => {};

test("groups a real report into 3 problems: real bug, flaky, CI environment", () => {
  const { totals, problems } = analyse(report);
  assert.deepEqual({ tests: totals.tests, failed: totals.failed, flaky: totals.flaky }, { tests: 8, failed: 4, flaky: 2 });
  assert.deepEqual(problems.map((p) => p.kind).sort(), ["environment", "failure", "flaky"]);
  const bug = problems.find((p) => p.kind === "failure");
  assert.deepEqual(bug.projects.sort(), ["chromium", "firefox"], "same failure in two browsers is one problem");
  assert.ok(bug.attachments.some((a) => a.contentType === "image/png"));
});

test("fingerprints ignore changing numbers, ids and timings", () => {
  assert.equal(normaliseError("Expected: 85\nReceived: 90\n  at foo.spec.ts:12:3"), normaliseError("Expected: 85\nReceived: 91\n  at foo.spec.ts:40:9"));
  assert.equal(normaliseError("Timeout 5000ms exceeded for id 3f2a9c1e-1111-2222-3333-444455556666"), normaliseError("Timeout 7000ms exceeded for id 9d9d9d9d-aaaa-bbbb-cccc-ddddeeeeffff"));
  assert.notEqual(normaliseError("Element not found: #buy"), normaliseError("Element not found: #cart"));
});

test("first run creates tickets; second run comments instead of duplicating", async () => {
  const jira = await startMockJira();
  try {
    const { env, dir } = await envFor(jira.url);
    const r1 = await run({ env, log: quiet });
    assert.equal(r1.created.length, 3);
    assert.equal(r1.commented.length, 0);
    assert.ok(jira.state.issues.every((i) => i.fields.labels.some((l) => l.startsWith("pw-fp-"))));
    assert.ok(jira.state.attachments.some((a) => a.filename.endsWith(".png")), "screenshot uploaded");
    const bug = jira.state.issues.find((i) => i.fields.labels.includes("playwright-failure"));
    assert.match(bug.fields.summary, /^\[Playwright\] Checkout › applies discount code/);
    assert.match(JSON.stringify(bug.fields.description), /actions\/runs\/42/);

    const r2 = await run({ env: { ...env, GITHUB_RUN_ID: "43", GITHUB_RUN_NUMBER: "8" }, log: quiet });
    assert.equal(r2.created.length, 0, "no duplicates");
    assert.equal(r2.commented.length, 3);
    assert.equal(jira.state.issues.length, 3);
    assert.match(JSON.stringify(jira.state.comments[0].body), /runs\/43/);

    const summary = await readFile(join(dir, "summary.md"), "utf8");
    assert.match(summary, /Repeat, commented/);
    assert.match(await readFile(join(dir, "output.txt"), "utf8"), /created=QA-1,QA-2,QA-3/);
  } finally { await jira.close(); }
});

test("a failure whose ticket was closed reopens as a linked regression", async () => {
  const jira = await startMockJira();
  try {
    const { env } = await envFor(jira.url);
    await run({ env, log: quiet });
    const bug = jira.state.issues.find((i) => i.fields.labels.includes("playwright-failure"));
    bug.done = true;
    const r = await run({ env, log: quiet });
    assert.equal(r.created.length, 1);
    assert.equal(r.created[0].regressionOf, bug.key);
    assert.match(JSON.stringify(jira.state.issues.at(-1).fields.description), new RegExp(`previously tracked in ${bug.key}`));
  } finally { await jira.close(); }
});

test("respects max-new-issues and flaky=ignore", async () => {
  const jira = await startMockJira();
  try {
    const { env } = await envFor(jira.url, { "INPUT_MAX-NEW-ISSUES": "1" });
    const r = await run({ env, log: quiet });
    assert.equal(r.created.length, 1);
    assert.equal(r.skipped.length, 2);

    const jira2 = await startMockJira();
    const { env: env2 } = await envFor(jira2.url, { INPUT_FLAKY: "ignore" });
    const r2 = await run({ env: env2, log: quiet });
    assert.equal(r2.created.length, 2);
    assert.ok(!jira2.state.issues.some((i) => i.fields.labels.includes("flaky-test")));
    await jira2.close();
  } finally { await jira.close(); }
});

test("a mass failure with one shared error becomes a single CI environment ticket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjt-"));
  const mk = (title) => ({ title, file: "a.spec.ts", line: 1, tests: [{ projectName: "chromium", status: "unexpected",
    results: [{ status: "failed", retry: 0, error: { message: "Error: page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to \"https://staging.example.com/\"" } }] }] });
  const synthetic = { suites: [{ title: "a.spec.ts", file: "a.spec.ts", specs: ["login", "search", "cart", "checkout", "profile"].map(mk), suites: [] }], errors: [] };
  const path = join(dir, "results.json");
  await writeFile(path, JSON.stringify(synthetic));
  const { problems } = analyse(synthetic);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, "environment");
  assert.equal(problems[0].occurrences.length, 5);
});

test("Jira outage never breaks the pipeline unless fail-on-error is set", async () => {
  const jira = await startMockJira({ failWith: 503 });
  try {
    const { env } = await envFor(jira.url);
    const r = await run({ env, log: quiet });
    assert.equal(r.errors.length, 3);
    await assert.rejects(run({ env: { ...env, "INPUT_FAIL-ON-ERROR": "true" }, log: quiet }), /Jira call\(s\) failed/);
  } finally { await jira.close(); }
});

test("missing report warns and exits cleanly", async () => {
  const lines = [];
  const r = await run({ env: { "INPUT_REPORT-PATH": "/nope/results.json" }, log: (l) => lines.push(l) });
  assert.equal(r.created.length, 0);
  assert.match(lines.join("\n"), /No Playwright JSON report/);
});
