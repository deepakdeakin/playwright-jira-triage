// Minimal Jira Cloud REST v3 client (Node 20+ fetch, no dependencies).
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

export class JiraError extends Error {
  constructor(status, body, what) {
    super(`Jira ${what} failed (${status}): ${String(body).slice(0, 300)}`);
    this.status = status;
  }
}

export class Jira {
  constructor({ baseUrl, email, token, fetchImpl = fetch }) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
    this.fetch = fetchImpl;
  }

  async req(method, path, body, what, extraHeaders = {}) {
    const isForm = body instanceof FormData;
    const res = await this.fetch(this.base + path, {
      method,
      headers: { Authorization: this.auth, Accept: "application/json", ...(isForm || !body ? {} : { "Content-Type": "application/json" }), ...extraHeaders },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new JiraError(res.status, text, what);
    return text ? JSON.parse(text) : {};
  }

  /** Most recent issue carrying this fingerprint label, open or closed. */
  async findByFingerprint(projectKey, label) {
    const jql = `project = "${projectKey}" AND labels = "${label}" ORDER BY created DESC`;
    const r = await this.req("POST", "/rest/api/3/search/jql", { jql, maxResults: 1, fields: ["summary", "status"] }, "search");
    const issue = r.issues?.[0];
    if (!issue) return null;
    return { key: issue.key, done: issue.fields?.status?.statusCategory?.key === "done", status: issue.fields?.status?.name };
  }

  createIssue(fields) {
    return this.req("POST", "/rest/api/3/issue", { fields }, "create issue");
  }

  addComment(key, adf) {
    return this.req("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: adf }, "comment");
  }

  async attach(key, files, maxBytes = 10 * 1024 * 1024) {
    const form = new FormData();
    let n = 0;
    for (const f of files) {
      try {
        const s = await stat(f.path);
        if (s.size > maxBytes) continue;
        form.append("file", new Blob([await readFile(f.path)], { type: f.contentType || "application/octet-stream" }), f.uploadName || basename(f.path));
        n++;
      } catch { /* file missing on this runner: skip */ }
    }
    if (!n) return 0;
    await this.req("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, form, "attach", { "X-Atlassian-Token": "no-check" });
    return n;
  }
}

// ---- Atlassian Document Format helpers ---------------------------------
const text = (t, marks) => ({ type: "text", text: String(t), ...(marks ? { marks } : {}) });
const link = (t, href) => text(t, [{ type: "link", attrs: { href } }]);
export const adf = {
  doc: (...content) => ({ type: "doc", version: 1, content: content.flat().filter(Boolean) }),
  p: (...parts) => ({ type: "paragraph", content: parts.flat().filter(Boolean).map((x) => (typeof x === "string" ? text(x) : x)) }),
  h: (level, t) => ({ type: "heading", attrs: { level }, content: [text(t)] }),
  code: (t, language = "text") => ({ type: "codeBlock", attrs: { language }, content: [text(t || " ")] }),
  bullets: (items) => ({ type: "bulletList", content: items.map((i) => ({ type: "listItem", content: [adf.p(...[].concat(i))] })) }),
  bold: (t) => text(t, [{ type: "strong" }]),
  link,
};
