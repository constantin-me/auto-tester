import { test } from "node:test";
import assert from "node:assert/strict";
import { LoginFailedError } from "./driver.js";
import { LOGIN_BLOCKED_REASON, loginBlocked, openWithRetry } from "./login-gate.js";
import { buildReport } from "../report/build.js";
import { renderMarkdown } from "../report/markdown.js";
import type { FlowNode } from "../mindmap/schema.js";

const page = (id: string, route: string): FlowNode => ({
  id,
  label: id,
  route,
  views: [],
  kind: "page",
  requiresAuth: false,
  guards: [],
  assertions: [],
  provenance: { sourceFiles: [], origin: "static-crawl", confidence: 0.5 },
});

test("openWithRetry: a one-off login failure is retried; two in a row are reported; other errors still throw", async () => {
  let n = 0;
  const flaky = await openWithRetry(async () => {
    if (n++ === 0) throw new LoginFailedError("login failed: once");
    return "session";
  });
  assert.deepEqual(flaky, { session: "session", failures: ["login failed: once"] });

  let calls = 0;
  const broken = await openWithRetry(async () => {
    calls++;
    throw new LoginFailedError("login failed: still on /login");
  });
  assert.equal(broken.session, undefined);
  assert.equal(calls, 2, "never more than two attempts: the app locks out repeated failures");

  await assert.rejects(openWithRetry(async () => { throw new Error("environment variable X is not set"); }), /environment variable/);
});

test("a broken login is a stable severity-5 finding on the login flow; everything else is listed as blocked", () => {
  const login = page("node:login", "/login");
  const settings = page("node:settings", "/settings");
  const { gate, gateNode, notVisited } = loginBlocked(["login failed: a", "login failed: b"], [settings], "/login", [login, settings]);
  assert.equal(gateNode, login);
  assert.deepEqual([gate.flow, gate.status, gate.findings[0]!.severity, gate.findings[0]!.confidence], ["node:login", "failed", 5, "stable"]);
  assert.deepEqual(notVisited, [{ flow: "node:settings", status: "skipped-login", reason: LOGIN_BLOCKED_REASON }]);

  // the report shows it even though triage never picked the login page
  const triage = { pRuns: 0.9, pAlters: 0.9, impact: 2, value: 1 } as never;
  const report = buildReport({
    repo: "r",
    target: "head",
    generatedAt: "t",
    changedFiles: ["views/login.ejs"],
    judged: [{ node: settings, reasons: ["renders x"], files: ["x"], triage, affected: true }],
    untriaged: [],
    gate: { node: gateNode, check: gate },
    budget: { cap: 1000, spent: 10, reserveForChecks: 0.3 },
    results: [...notVisited, gate],
    executionCheck: true,
    dropBelow: 0.45,
    usage: [],
    evidenceDir: "/tmp/x",
  });
  assert.equal(report.verdict, "likely-regression");
  const flow = report.flows.find((f) => f.flow === "node:login")!;
  assert.deepEqual([flow.outcome, flow.findings[0]!.kind, flow.findings[0]!.severity], ["failed", "login", 5]);
  assert.equal(report.flows.find((f) => f.flow === "node:settings")!.notTestedReason, LOGIN_BLOCKED_REASON);
  assert.equal(report.summary.notTestedBy["login failed: blocked"], 1);
  assert.match(renderMarkdown(report), /signs in at \/login/);
});
