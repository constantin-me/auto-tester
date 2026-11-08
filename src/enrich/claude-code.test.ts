import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeClient, parseResult } from "./claude-code.js";

const answer = { label: "Login", confidence: 0.8, assertions: [{ slug: "shows-form", expectation: "Shows a sign-in form", check: null, severityIfBroken: 4 }] };
const result = (over: Record<string, unknown> = {}) => [
  { type: "system", subtype: "init" },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    usage: { input_tokens: 2, cache_creation_input_tokens: 600, cache_read_input_tokens: 400, output_tokens: 50 },
    structured_output: answer,
    ...over,
  },
];

test("parseResult: reads structured_output and counts cached input as input", () => {
  const r = parseResult(JSON.stringify(result()));
  assert.deepEqual(r, { ok: true, output: answer, usage: { inputTokens: 1002, outputTokens: 50 } });
});

test("parseResult: an error result, a schema mismatch or junk output is a failure, not an answer", () => {
  const err = parseResult(JSON.stringify(result({ is_error: true, subtype: "error_during_execution", api_error_status: 429 })));
  assert.equal(err.ok, false);
  assert.match(!err.ok ? err.reason : "", /429/);
  assert.equal(parseResult(JSON.stringify(result({ structured_output: { label: 1 } }))).ok, false);
  assert.equal(parseResult("not json").ok, false);
  assert.equal(parseResult(JSON.stringify([{ type: "system" }])).ok, false);
});

test("claudeCodeClient: runs the CLI headless with no tools, prompt on stdin, in an empty dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const log = join(dir, "call.json");
  const bin = join(dir, "claude");
  // a fake `claude` that records how it was called and prints a canned result
  writeFileSync(
    bin,
    `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  require("fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd(), files: require("fs").readdirSync(process.cwd()), apiKey: process.env.ANTHROPIC_API_KEY ?? null }));
  process.stdout.write(${JSON.stringify(JSON.stringify(result()))});
});
`,
  );
  chmodSync(bin, 0o755);
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-from-dotenv";
  let r;
  try {
    r = await claudeCodeClient({ bin }).enrich({ model: "claude-opus-5-5", effort: "low", system: "SYS", user: "USER PROMPT" });
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
  assert.equal(r.ok, true);
  const call = JSON.parse(readFileSync(log, "utf8"));
  // the subscription login must be used, never an API key inherited from .env
  assert.equal(call.apiKey, null);
  assert.equal(call.input, "USER PROMPT");
  assert.deepEqual(call.files, []);
  const flag = (name: string) => call.args[call.args.indexOf(name) + 1];
  assert.ok(call.args.includes("-p"));
  assert.equal(flag("--model"), "claude-opus-5-5");
  assert.equal(flag("--effort"), "low");
  assert.equal(flag("--system-prompt"), "SYS");
  assert.equal(flag("--tools"), "");
  assert.equal(flag("--output-format"), "json");
  assert.ok(call.args.includes("--no-session-persistence"));
  const schema = JSON.parse(flag("--json-schema"));
  assert.ok(schema.properties.assertions);
  // the real CLI rejects zod's draft 2020-12 `$schema` header
  assert.equal(schema.$schema, undefined);
});

test("claudeCodeClient: a missing binary is a failure with a hint, not a crash", async () => {
  const r = await claudeCodeClient({ bin: "/nonexistent/claude" }).enrich({ model: "m", effort: "low", system: "s", user: "u" });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /installed and logged in/);
});
