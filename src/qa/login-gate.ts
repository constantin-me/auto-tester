import type { FlowNode } from "../mindmap/schema.js";
import type { FlowCheck } from "./check.js";
import { LoginFailedError } from "./driver.js";
import type { NotVisited } from "../report/build.js";

/**
 * Login is the gate to every other flow. When a change breaks it, a check must say so loudly
 * instead of crashing: one severity-5 finding on the login flow, and every affected flow
 * listed as not visited because of it.
 *
 * Two attempts at most: the app locks an address out after repeated failures, and two in a
 * row already rules out a one-off hiccup. Any other error (config, browser) still throws.
 */
export const LOGIN_ATTEMPTS = 2;

export async function openWithRetry<S>(open: () => Promise<S>, attempts = LOGIN_ATTEMPTS): Promise<{ session?: S; failures: string[] }> {
  const failures: string[] = [];
  for (let i = 0; i < attempts; i++) {
    try {
      return { session: await open(), failures };
    } catch (err) {
      if (!(err instanceof LoginFailedError)) throw err;
      failures.push(err.message);
    }
  }
  return { failures };
}

export const LOGIN_BLOCKED_REASON = "login failed, so the pages behind it could not be visited";

export function loginBlocked(
  failures: string[],
  affected: FlowNode[],
  loginPath: string,
  nodes: FlowNode[],
): { gate: FlowCheck; gateNode?: FlowNode; notVisited: NotVisited[] } {
  const gateNode = nodes.find((n) => n.route === loginPath && n.kind === "page");
  const flow = gateNode?.id ?? "login";
  const gate: FlowCheck = {
    flow,
    path: loginPath,
    status: "failed",
    attempts: failures.length,
    checksRun: 1,
    settled: true,
    findings: [
      {
        kind: "login",
        expectation: `The test user signs in at ${loginPath} (it could when the baseline was recorded)`,
        actual: failures[failures.length - 1] ?? "login failed",
        // the gate to every other flow: no rating needed, nothing behind it can be used
        severity: 5,
        severityConfidence: 1,
        confidence: failures.length > 1 ? "stable" : "maybe",
      },
    ],
  };
  const notVisited = affected.filter((n) => n.id !== flow).map((n) => ({ flow: n.id, status: "skipped-login", reason: LOGIN_BLOCKED_REASON }));
  return { gate, gateNode, notVisited };
}
