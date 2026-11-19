// A tiny in-memory Jira Cloud stand-in covering the endpoints the action uses.
import { createServer } from "node:http";

export async function startMockJira({ failWith } = {}) {
  const state = { issues: [], comments: [], attachments: [], requests: [], authOk: true };
  let seq = 0;

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    state.requests.push({ method: req.method, url: req.url });
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

    if (failWith) return send(failWith, { errorMessages: ["mock failure"] });
    if (req.headers.authorization !== "Basic " + Buffer.from("bot@example.com:token123").toString("base64")) {
      state.authOk = false;
      return send(401, { errorMessages: ["unauthorised"] });
    }

    if (req.method === "POST" && req.url === "/rest/api/3/search/jql") {
      const { jql } = JSON.parse(raw);
      const label = /labels = "([^"]+)"/.exec(jql)?.[1];
      const project = /project = "([^"]+)"/.exec(jql)?.[1];
      const found = state.issues.filter((i) => i.fields.labels.includes(label) && i.fields.project.key === project).reverse();
      return send(200, {
        issues: found.slice(0, 1).map((i) => ({ key: i.key, fields: { summary: i.fields.summary, status: { name: i.done ? "Done" : "To Do", statusCategory: { key: i.done ? "done" : "new" } } } })),
      });
    }
    if (req.method === "POST" && req.url === "/rest/api/3/issue") {
      const { fields } = JSON.parse(raw);
      if (fields.description?.type !== "doc") return send(400, { errors: { description: "must be ADF" } });
      const key = `${fields.project.key}-${++seq}`;
      state.issues.push({ key, fields, done: false });
      return send(201, { id: String(seq), key });
    }
    let m;
    if (req.method === "POST" && (m = /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/.exec(req.url))) {
      state.comments.push({ key: decodeURIComponent(m[1]), body: JSON.parse(raw).body });
      return send(201, { id: String(state.comments.length) });
    }
    if (req.method === "POST" && (m = /^\/rest\/api\/3\/issue\/([^/]+)\/attachments$/.exec(req.url))) {
      if (req.headers["x-atlassian-token"] !== "no-check") return send(403, { errorMessages: ["XSRF check failed"] });
      const names = [...raw.toString("latin1").matchAll(/filename="([^"]+)"/g)].map((x) => x[1]);
      for (const n of names) state.attachments.push({ key: decodeURIComponent(m[1]), filename: n });
      return send(200, names.map((filename) => ({ filename })));
    }
    send(404, { errorMessages: [`no route ${req.method} ${req.url}`] });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, state, close: () => new Promise((r) => server.close(r)) };
}
