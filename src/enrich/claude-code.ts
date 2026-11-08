import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import type { EnrichClient, EnrichResponse } from "./client.js";
import { EnrichOutput } from "./schema.js";

/**
 * Enrichment through the local Claude Code CLI (`claude -p`), so a run is covered by the
 * user's Claude subscription instead of an API key. Local use only: CI has no logged-in
 * Claude Code, so CI keeps the API backend.
 *
 * Each node is one headless session: no tools (it only reads the prompt), no MCP servers,
 * no settings or slash commands, no saved session, and an empty working directory so no
 * project CLAUDE.md or memory leaks into the answer. `--json-schema` makes the CLI return
 * the answer as `structured_output` on its final `result` event.
 */
export interface ClaudeCodeOptions {
  /** the CLI binary; tests point this at a fake */
  bin?: string;
  /** per-node wall clock limit */
  timeoutMs?: number;
}

// the CLI's validator does not know the draft 2020-12 meta-schema zod declares; the schema itself is plain
const { $schema: _metaSchema, ...schema } = z.toJSONSchema(EnrichOutput);
const SCHEMA = JSON.stringify(schema);

export function claudeCodeClient(opts: ClaudeCodeOptions = {}): EnrichClient {
  const bin = opts.bin ?? "claude";
  const timeoutMs = opts.timeoutMs ?? 300_000;
  return {
    async enrich(req) {
      const args = [
        "-p",
        "--model", req.model,
        "--effort", req.effort,
        "--system-prompt", req.system,
        "--json-schema", SCHEMA,
        "--output-format", "json",
        "--tools", "",
        "--strict-mcp-config",
        "--setting-sources", "",
        "--disable-slash-commands",
        "--no-session-persistence",
      ];
      const cwd = mkdtempSync(join(tmpdir(), "autotester-enrich-"));
      try {
        const run = await runCli(bin, args, req.user, cwd, timeoutMs);
        if (!run.ok) return { ok: false, reason: run.reason };
        return parseResult(run.stdout);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}

/** Read the CLI's `--output-format json` output: an array of events ending in a `result`. */
export function parseResult(stdout: string): EnrichResponse {
  let events: unknown;
  try {
    events = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: "claude CLI printed something that is not JSON" };
  }
  const list = Array.isArray(events) ? events : [events];
  const result = list.find((e): e is Record<string, any> => !!e && typeof e === "object" && (e as { type?: unknown }).type === "result");
  if (!result) return { ok: false, reason: "claude CLI output has no result event" };
  const u = result.usage ?? {};
  // cached prompt reads are still input the model read: count them, or a run looks free
  const usage = {
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
  };
  if (result.is_error || result.subtype !== "success") {
    const why = result.api_error_status ? `API status ${result.api_error_status}` : String(result.subtype ?? "error");
    return { ok: false, reason: `claude CLI run failed: ${why}`, usage };
  }
  const parsed = EnrichOutput.safeParse(result.structured_output);
  if (!parsed.success) return { ok: false, reason: "claude CLI answer does not match the schema", usage };
  return { ok: true, output: parsed.data, usage };
}

function runCli(
  bin: string,
  args: string[],
  input: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    // an API key in the environment (e.g. loaded from .env) would make the CLI bill the API
    // instead of the subscription login, which is the point of this backend
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `could not start ${bin}: ${err.message} (is Claude Code installed and logged in?)` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) return resolve({ ok: false, reason: `claude CLI stopped by ${signal}${signal === "SIGTERM" ? ` after ${timeoutMs / 1000}s` : ""}` });
      // a failed run may still print a result event with the reason; prefer it over the exit code
      if (code !== 0 && !stdout.trim()) return resolve({ ok: false, reason: `claude CLI exited ${code}: ${stderr.trim().slice(0, 300)}` });
      resolve({ ok: true, stdout });
    });
    child.stdin.end(input);
  });
}
