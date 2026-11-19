// Orchestrates: read report -> group failures -> find or create Jira tickets -> job summary.
import { appendFile, readFile } from "node:fs/promises";
import { analyse } from "./report.js";
import { Jira, adf } from "./jira.js";

export function readInputs(env = process.env) {
  const get = (name, def = "") => (env[`INPUT_${name.toUpperCase()}`] ?? def).trim() || def;
  return {
    reportPath: get("report-path", "test-results/results.json"),
    baseUrl: get("jira-base-url"),
    email: get("jira-email"),
    token: get("jira-api-token"),
    projectKey: get("project-key"),
    issueType: get("issue-type", "Bug"),
    labels: get("labels").split(",").map((s) => s.trim().replace(/\s+/g, "-")).filter(Boolean),
    flaky: get("flaky", "ticket"),
    attach: get("attach", "screenshot,trace").split(",").map((s) => s.trim()).filter((s) => s && s !== "none"),
    maxNew: Number(get("max-new-issues", "10")) || 10,
    massThreshold: Number(get("mass-failure-threshold", "0.5")) || 0.5,
    dryRun: get("dry-run", "false") === "true",
    failOnError: get("fail-on-error", "false") === "true",
  };
}

export function runContext(env = process.env) {
  const server = env.GITHUB_SERVER_URL || "https://github.com";
  const repo = env.GITHUB_REPOSITORY || "local/repo";
  const runId = env.GITHUB_RUN_ID;
  return {
    repo,
    sha: (env.GITHUB_SHA || "").slice(0, 7),
    shaUrl: env.GITHUB_SHA ? `${server}/${repo}/commit/${env.GITHUB_SHA}` : null,
    branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || "local",
    runUrl: runId ? `${server}/${repo}/actions/runs/${runId}` : null,
    runLabel: runId ? `run ${env.GITHUB_RUN_NUMBER || runId}` : "local run",
    actor: env.GITHUB_ACTOR || "",
    workflow: env.GITHUB_WORKFLOW || "",
  };
}

const KIND = {
  failure: { prefix: "[Playwright]", label: "playwright-failure", word: "Failure" },
  flaky: { prefix: "[Flaky test]", label: "flaky-test", word: "Flaky" },
  environment: { prefix: "[CI environment]", label: "ci-environment", word: "CI environment" },
};

function summaryFor(p) {
  // Human-readable first line of the real error (the normalised form is only for matching).
  const first = (p.error.message.split("\n").map((l) => l.trim()).find(Boolean) || p.normalised)
    .replace(/\s+/g, " ").slice(0, 110);
  const cause = p.error.causes?.[0]?.split("\n")[0];
  const body = p.kind === "environment"
    ? `${first}${cause ? ` (${cause.replace(/^Error:\s*/, "").slice(0, 60)})` : ""}, ${p.occurrences.length} tests`
    : `${p.title}: ${first}`;
  return `${KIND[p.kind].prefix} ${body}`.slice(0, 250);
}

function runLine(ctx) {
  return [
    ctx.runUrl ? adf.link(ctx.runLabel, ctx.runUrl) : ctx.runLabel,
    ` on ${ctx.branch}`,
    ctx.sha ? " at " : "",
    ctx.sha ? (ctx.shaUrl ? adf.link(ctx.sha, ctx.shaUrl) : ctx.sha) : "",
    ctx.actor ? ` (pushed by ${ctx.actor})` : "",
  ];
}

function description(p, ctx, regressionOf) {
  const where = p.file ? `${p.file}${p.line ? ":" + p.line : ""}` : null;
  const what = {
    failure: "This test failed on every attempt.",
    flaky: `This test failed, then passed on retry (${p.occurrences[0]?.attempts ?? 2} attempts). It is unreliable, not necessarily broken.`,
    environment: `${p.occurrences.length} tests failed with the same error, which points at the CI environment (network, server start-up or browser install) rather than one test.`,
  }[p.kind];
  return adf.doc(
    regressionOf ? adf.p(adf.bold("Regression: "), `the same failure was previously tracked in ${regressionOf}, which is closed.`) : null,
    adf.p(what),
    adf.bullets([
      ["First seen: ", ...runLine(ctx)],
      where ? ["Test: ", where] : null,
      ["Browsers/projects: ", p.projects.join(", ") || "default"],
      p.kind === "environment" ? ["Affected tests: ", p.occurrences.slice(0, 15).map((o) => o.title).join("; ") + (p.occurrences.length > 15 ? "; …" : "")] : null,
    ].filter(Boolean)),
    adf.h(3, "Error"),
    adf.code(p.error.message.slice(0, 4000)),
    p.error.stack && p.error.stack !== p.error.message ? [adf.h(3, "Stack"), adf.code(p.error.stack.slice(0, 4000))] : null,
    adf.p(`Fingerprint ${p.fingerprint}. Filed by Playwright Jira Triage. Later failures with the same fingerprint are added as comments on this ticket.`),
  );
}

function repeatComment(p, ctx) {
  return adf.doc(
    adf.p(adf.bold(`${KIND[p.kind].word} again: `), ...runLine(ctx)),
    adf.p(`Projects: ${p.projects.join(", ") || "default"}${p.kind === "environment" ? ` · ${p.occurrences.length} tests affected` : ""}`),
  );
}

function pickAttachments(p, kinds) {
  if (!kinds.length) return [];
  const want = (a) =>
    (kinds.includes("screenshot") && a.contentType?.startsWith("image/")) ||
    (kinds.includes("trace") && a.name === "trace") ||
    (kinds.includes("video") && a.contentType?.startsWith("video/"));
  const seen = new Set();
  return p.attachments.filter(want).filter((a) => !seen.has(a.path) && seen.add(a.path))
    .map((a, i) => ({ ...a, uploadName: `${p.fingerprint}-${i + 1}-${a.path.split(/[\\/]/).pop()}` }))
    .slice(0, 5);
}

export async function run({ env = process.env, log = console.log, fetchImpl } = {}) {
  const inp = readInputs(env);
  const ctx = runContext(env);
  const result = { created: [], commented: [], skipped: [], errors: [], plan: [] };

  let report;
  try {
    report = JSON.parse(await readFile(inp.reportPath, "utf8"));
  } catch (e) {
    log(`::warning::No Playwright JSON report at ${inp.reportPath}. Add the json reporter to playwright.config (see README).`);
    return { ...result, totals: null, problems: [] };
  }

  const { totals, problems } = analyse(report, { massFailureThreshold: inp.massThreshold });
  const todo = problems.filter((p) => !(p.kind === "flaky" && inp.flaky === "ignore"));
  log(`Playwright: ${totals.tests} tests, ${totals.failed} failed, ${totals.flaky} flaky -> ${todo.length} distinct problem(s)`);

  const live = !inp.dryRun && inp.baseUrl && inp.email && inp.token && inp.projectKey;
  if (!inp.dryRun && !live && todo.length) log("::warning::Jira inputs missing (jira-base-url, jira-email, jira-api-token, project-key). Running as a dry run.");
  const jira = live ? new Jira({ baseUrl: inp.baseUrl, email: inp.email, token: inp.token, fetchImpl }) : null;

  for (const p of todo) {
    const fpLabel = `pw-fp-${p.fingerprint}`;
    try {
      if (!jira) {
        result.plan.push({ action: "would check/create", kind: p.kind, summary: summaryFor(p), fingerprint: p.fingerprint });
        continue;
      }
      const existing = await jira.findByFingerprint(inp.projectKey, fpLabel);
      if (existing && !existing.done) {
        await jira.addComment(existing.key, repeatComment(p, ctx));
        result.commented.push({ key: existing.key, kind: p.kind, summary: summaryFor(p) });
        continue;
      }
      if (p.kind === "flaky" && inp.flaky === "comment-only") { result.skipped.push({ kind: p.kind, summary: summaryFor(p), why: "flaky: comment-only, no open ticket" }); continue; }
      if (result.created.length >= inp.maxNew) { result.skipped.push({ kind: p.kind, summary: summaryFor(p), why: `max-new-issues (${inp.maxNew}) reached` }); continue; }
      const created = await jira.createIssue({
        project: { key: inp.projectKey },
        issuetype: { name: inp.issueType },
        summary: summaryFor(p),
        description: description(p, ctx, existing?.done ? existing.key : null),
        labels: [fpLabel, KIND[p.kind].label, ...inp.labels],
      });
      let attached = 0;
      try { attached = await jira.attach(created.key, pickAttachments(p, inp.attach)); }
      catch (e) { log(`::warning::Created ${created.key} but could not upload attachments: ${e.message}`); }
      result.created.push({ key: created.key, kind: p.kind, summary: summaryFor(p), attached, regressionOf: existing?.done ? existing.key : null });
    } catch (e) {
      result.errors.push({ summary: summaryFor(p), error: e.message });
      log(`::warning::${e.message}`);
    }
  }

  await writeOutputs(env, inp, totals, result, log);
  if (result.errors.length && inp.failOnError) throw new Error(`${result.errors.length} Jira call(s) failed`);
  return { ...result, totals, problems };
}

async function writeOutputs(env, inp, totals, r, log) {
  const browse = (k) => (inp.baseUrl ? `[${k}](${inp.baseUrl.replace(/\/+$/, "")}/browse/${k})` : k);
  const rows = [
    ...r.created.map((x) => `| 🆕 Created | ${browse(x.key)} | ${x.kind}${x.regressionOf ? ` (regression of ${x.regressionOf})` : ""} | ${esc(x.summary)} |`),
    ...r.commented.map((x) => `| 🔁 Repeat, commented | ${browse(x.key)} | ${x.kind} | ${esc(x.summary)} |`),
    ...r.plan.map((x) => `| 📝 Dry run | — | ${x.kind} | ${esc(x.summary)} |`),
    ...r.skipped.map((x) => `| ⏭️ Skipped | — | ${x.kind} | ${esc(x.summary)} (${x.why}) |`),
    ...r.errors.map((x) => `| ⚠️ Jira error | — | — | ${esc(x.summary)}: ${esc(x.error)} |`),
  ];
  const md = [
    "### Playwright Jira Triage",
    `${totals.tests} tests · ${totals.failed} failed · ${totals.flaky} flaky · ${totals.passed} passed`,
    "",
    rows.length ? "| Result | Ticket | Kind | Summary |\n|---|---|---|---|\n" + rows.join("\n") : "No failures to triage. ✅",
    "",
  ].join("\n");
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, md);
  else log(md);
  if (env.GITHUB_OUTPUT) {
    await appendFile(env.GITHUB_OUTPUT,
      `created=${r.created.map((x) => x.key).join(",")}\ncommented=${r.commented.map((x) => x.key).join(",")}\nfailures=${r.created.length + r.commented.length + r.plan.length + r.skipped.length + r.errors.length}\n`);
  }
}

const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
