// Parse a Playwright JSON report and group its failures into distinct problems.
import { createHash } from "node:crypto";

const ANSI = /\u001b\[[0-9;]*m/g;

// Errors that point at the CI environment rather than the app under test.
const ENV_PATTERNS = [
  /ECONNREFUSED/, /ENOTFOUND/, /ECONNRESET/, /EAI_AGAIN/, /ETIMEDOUT/, /socket hang up/i,
  /net::ERR_[A-Z_]+/, /\b50[234]\b.*(Bad Gateway|Service Unavailable|Gateway Timeout)/i,
  /browserType\.launch/, /Executable doesn't exist/i, /Target page, context or browser has been closed/i,
  /webServer.*(timed out|exited)/i,
];

export function stripAnsi(s) {
  return String(s ?? "").replace(ANSI, "");
}

/** Reduce an error to the stable part, so the same failure fingerprints the same way each run. */
export function normaliseError(message) {
  let s = stripAnsi(message);
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean)
    // drop Playwright's call log and code frame
    .filter((l) => !/^(Call log:|- |at |\d+ \||>\s*\d+ \|)/.test(l))
    .slice(0, 3);
  s = lines.join(" ");
  return s
    .replace(/https?:\/\/[^\s'")]+/g, (u) => { try { const x = new URL(u); return `${x.host}${x.pathname}`; } catch { return "URL"; } })
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "UUID")
    .replace(/\b[0-9a-f]{12,}\b/gi, "HEX")
    .replace(/\d+(\.\d+)?\s?ms\b/g, "Nms")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export function fingerprint(...parts) {
  return createHash("sha1").update(parts.join("::")).digest("hex").slice(0, 10);
}

export function isEnvironmentError(message) {
  const s = stripAnsi(message);
  return ENV_PATTERNS.some((re) => re.test(s));
}

/** Walk nested suites and yield every test with its title path. */
function* walk(suites, parents = []) {
  for (const suite of suites ?? []) {
    const path = suite.title && !suite.title.endsWith(".ts") && !suite.title.endsWith(".js") ? [...parents, suite.title] : parents;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        yield { spec, test, titlePath: [...path, spec.title], file: spec.file ?? suite.file };
      }
    }
    yield* walk(suite.suites, path);
  }
}

function firstError(results) {
  for (const r of results ?? []) {
    const e = r.error ?? r.errors?.[0];
    if (e?.message || e?.value) {
      // Follow the cause chain (e.g. "fetch failed" caused by ECONNREFUSED) for classification.
      const causes = [];
      for (let c = e.cause, i = 0; c && i < 5; c = c.cause, i++) causes.push(stripAnsi(c.message ?? c.value ?? ""));
      return { message: stripAnsi(e.message ?? e.value), stack: stripAnsi(e.stack ?? ""), location: e.location, causes };
    }
  }
  return { message: "Test failed without an error message", stack: "" };
}

function attachmentsOf(results) {
  const out = [];
  for (const r of results ?? []) {
    if (r.status === "passed" || r.status === "skipped") continue;
    for (const a of r.attachments ?? []) if (a.path) out.push({ name: a.name, contentType: a.contentType, path: a.path, retry: r.retry });
  }
  return out;
}

/**
 * Returns { totals, problems } where each problem is one ticket-worthy issue:
 *   kind: "failure" | "flaky" | "environment"
 */
export function analyse(report, { massFailureThreshold = 0.5 } = {}) {
  const totals = { tests: 0, failed: 0, flaky: 0, passed: 0, skipped: 0 };
  const bad = [];
  for (const { test, titlePath, file, spec } of walk(report.suites)) {
    totals.tests++;
    if (test.status === "skipped") { totals.skipped++; continue; }
    if (test.status === "expected") { totals.passed++; continue; }
    const kind = test.status === "flaky" ? "flaky" : "failure";
    if (kind === "flaky") totals.flaky++; else totals.failed++;
    const err = firstError(test.results);
    bad.push({
      kind, file, line: spec.line, titlePath, title: titlePath.join(" › "),
      project: test.projectName || "default",
      error: err, normalised: normaliseError([err.message, ...(err.causes ?? [])].join("\n")),
      attempts: test.results?.length ?? 1,
      attachments: attachmentsOf(test.results),
    });
  }

  // Global errors (setup, webServer, config) are environment problems by definition.
  const globalErrors = (report.errors ?? []).map((e) => stripAnsi(e.message ?? e.value ?? ""));

  // Mass failure: most tests failing with the same normalised error is one environment problem.
  const failing = bad.filter((b) => b.kind === "failure");
  const byErr = new Map();
  for (const b of failing) byErr.set(b.normalised, (byErr.get(b.normalised) ?? 0) + 1);
  const ran = totals.tests - totals.skipped;
  const massErr = [...byErr.entries()].find(([, n]) => n >= 3 && ran > 0 && n / ran >= massFailureThreshold)?.[0];

  const problems = new Map();
  const add = (key, make, item) => {
    if (!problems.has(key)) problems.set(key, make());
    const p = problems.get(key);
    if (item) {
      p.occurrences.push(item);
      if (!p.projects.includes(item.project)) p.projects.push(item.project);
    }
  };

  for (const b of bad) {
    const env = b.kind === "failure" &&
      (b.normalised === massErr || isEnvironmentError([b.error.message, ...(b.error.causes ?? [])].join("\n")));
    if (env) {
      const fp = fingerprint("env", b.normalised);
      add(fp, () => ({ fingerprint: fp, kind: "environment", title: b.normalised.slice(0, 120), error: b.error, normalised: b.normalised, occurrences: [], projects: [], attachments: [] }), b);
    } else {
      // Same test + same error in several browsers is one problem.
      const fp = fingerprint(b.kind, b.file, b.title, b.normalised);
      add(fp, () => ({ fingerprint: fp, kind: b.kind, title: b.title, file: b.file, line: b.line, error: b.error, normalised: b.normalised, occurrences: [], projects: [], attachments: b.attachments }), b);
    }
  }
  for (const msg of globalErrors) {
    const norm = normaliseError(msg);
    const fp = fingerprint("env", norm);
    add(fp, () => ({ fingerprint: fp, kind: "environment", title: norm.slice(0, 120), error: { message: msg, stack: "" }, normalised: norm, occurrences: [], projects: [], attachments: [] }));
  }

  return { totals, problems: [...problems.values()] };
}
