import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionState } from "./evidence.js";
import { dropByExecution } from "./judgments.js";
import { ViewIndex } from "../bootstrap/ejs.js";
import type { FlowNode } from "../mindmap/schema.js";

test("execution rule: only indirect-only candidates below the threshold are dropped", () => {
  assert.equal(dropByExecution(0.1, [{ kind: "middleware" }]), true);
  assert.equal(dropByExecution(0.1, [{ kind: "action" }, { kind: "helper" }]), true);
  assert.equal(dropByExecution(0.1, [{ kind: "middleware" }, { kind: "handler" }]), false, "a direct link is never dropped");
  assert.equal(dropByExecution(0.1, [{ kind: "template" }]), false);
  assert.equal(dropByExecution(0.5, [{ kind: "middleware" }]), false);
  assert.equal(dropByExecution(0.1, []), false, "no link information: keep");
});

test("evidence: call site with posted fields, render keys the templates never read, params described", () => {
  const root = mkdtempSync(join(tmpdir(), "ev-"));
  mkdirSync(join(root, "views"));
  writeFileSync(
    join(root, "views/confirm.ejs"),
    ['<h1>Confirm</h1>', '<form action="<%= baseUrl %>/save-<%= plugin.id %>" method="POST">', '  <input name="title">', '  <input name="year">', "</form>"].join("\n"),
  );
  const node: FlowNode = {
    id: "node:confirm-books-id",
    label: "Confirm",
    route: "/confirm-books/:id",
    view: "confirm",
    views: ["confirm"],
    kind: "page",
    requiresAuth: true,
    guards: [],
    assertions: [],
    provenance: { sourceFiles: ["core/routes/itemRoutes.ts"], origin: "static-crawl", confidence: 0.4 },
  };
  const state = executionState(
    node,
    {
      nodeId: node.id,
      reasons: ["handler of POST /save-books changed (action on this page)"],
      hunks: ["@@ -1,2 +1,3 @@\n if (mongo_id) {\n-  existing = find(q);\n+  hasActiveFilters: true,\n }"],
      links: [{ kind: "action", action: { method: "POST", path: "/save-books" } }],
    },
    { appRoot: root, views: new ViewIndex(root, ["views"]) },
  ) as any;

  assert.match(state.flow.params.id, /ObjectId/);
  const action = state.flow.requests[1];
  assert.equal(action.path, "/save-books");
  assert.deepEqual(action.call_site.fields_sent, ["title", "year"], "the form does not send mongo_id");
  assert.deepEqual(state.change.render_data_keys, [{ key: "hasActiveFilters", used_in_flow_templates: "none found" }]);
});
