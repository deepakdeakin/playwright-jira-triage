# Playwright Jira Triage

[![CI](https://github.com/deepakdeakin/playwright-jira-triage/actions/workflows/ci.yml/badge.svg)](https://github.com/deepakdeakin/playwright-jira-triage/actions/workflows/ci.yml)

A GitHub Action that turns Playwright test failures into **one Jira bug per distinct problem**. When the same failure happens again, it adds a comment to the existing ticket instead of opening a duplicate.

```
8 tests failed in CI  →  3 Jira tickets, not 8
next run, same failures  →  3 comments, 0 new tickets
```

## What it does
- **Groups failures.** The same test failing with the same error in Chromium and Firefox is one problem.
- **Sorts them into three kinds:**
  - **Real failure:** fails on every attempt. Filed as `[Playwright] …`
  - **Flaky:** failed, then passed on retry. Filed as `[Flaky test] …`, or ignored if you prefer.
  - **CI environment:** network errors, server start-up failures or a missing browser, or most of the suite failing with one shared error. Filed as **one** `[CI environment] …` ticket, not one per test.
- **Prevents duplicates.** Each problem gets a fingerprint built from the test and its error, with changing numbers, IDs and timings removed. The fingerprint is stored as a `pw-fp-…` label. Before filing, it searches Jira for that label:
  - If the ticket is **open**, it adds a "failed again" comment with links to the run and the commit.
  - If the ticket is **closed**, it opens a new ticket marked as a regression of the old one.
  - If there's **none**, it creates a ticket with the error, stack, run link, commit, browsers, and the screenshot and trace attached.
- **Stays out of your way.** If Jira is unreachable it warns and moves on, so your pipeline isn't blocked. A cap on new tickets per run prevents floods.

## Setup

**1. Add the JSON reporter** in `playwright.config.ts`:
```ts
reporter: [["html"], ["json", { outputFile: "test-results/results.json" }]],
use: { screenshot: "only-on-failure", trace: "retain-on-failure" },
retries: process.env.CI ? 1 : 0, // needed to tell flaky from broken
```

**2. Add three repository secrets:**
- `JIRA_BASE_URL`, e.g. `https://your-team.atlassian.net`
- `JIRA_EMAIL`, the account the bot posts as
- `JIRA_API_TOKEN`, created at id.atlassian.com → Security → API tokens

**3. Add the step after your tests** (see [examples/playwright.yml](examples/playwright.yml)):
```yaml
- name: Triage failures to Jira
  if: ${{ !cancelled() }}
  uses: deepakdeakin/playwright-jira-triage@v0
  with:
    jira-base-url: ${{ secrets.JIRA_BASE_URL }}
    jira-email: ${{ secrets.JIRA_EMAIL }}
    jira-api-token: ${{ secrets.JIRA_API_TOKEN }}
    project-key: QA
```

Try it safely first with `dry-run: "true"`. The job summary then shows exactly what would be filed.

## Options
| Input | Default | What it does |
|---|---|---|
| `report-path` | `test-results/results.json` | Where the JSON reporter writes |
| `project-key` | — | Jira project for new tickets |
| `issue-type` | `Bug` | Issue type for new tickets |
| `labels` | — | Extra labels, comma separated |
| `flaky` | `ticket` | `ticket`, `comment-only` (only update existing tickets) or `ignore` |
| `attach` | `screenshot,trace` | Any of `screenshot`, `trace`, `video`, or `none`. Files over 10 MB are skipped |
| `max-new-issues` | `10` | Cap on new tickets per run |
| `mass-failure-threshold` | `0.5` | Share of tests failing with one error that counts as an environment problem |
| `dry-run` | `false` | Write the plan to the job summary without calling Jira |
| `fail-on-error` | `false` | Fail the step if Jira calls fail |

**Outputs:** `created` (new ticket keys), `commented` (existing keys), `failures` (distinct problems).

## Development
```bash
npm test   # 8 tests against a real Playwright report and a mock Jira server
```
To regenerate the fixture report (the script also strips local paths so it is safe to commit):
```bash
cd test/fixture-project && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install && npx playwright test; cd ../..
node test/make-fixture.mjs
```
It has no runtime dependencies: plain Node 20+ with built-in `fetch`, so there's no build step.

## Permissions and data
- It only calls the Jira URL you give it. Nothing is sent anywhere else.
- The Jira token needs permission to browse, create issues, add comments and add attachments in the target project.
- Attachments come from your own CI run. Turn them off with `attach: none` if screenshots may contain sensitive data.

## Feedback
This is an early release. If it files something wrong, or you need JUnit/Cypress support, [open an issue](https://github.com/deepakdeakin/playwright-jira-triage/issues).

## Known limits (v0)
- Jira Cloud only. It uses REST v3 and the `/search/jql` endpoint.
- It doesn't assign an owner yet. CODEOWNERS-based assignment is next.
- Only Playwright's JSON reporter is supported. JUnit XML, for Cypress and Jest, is next.
