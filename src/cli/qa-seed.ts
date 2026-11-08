import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config/config.js";

/**
 * Load the test fixture into a disposable instance:
 *
 *   npm run qa:seed -- <config>
 *
 * POSTs `qa.seed.file` to `qa.seed.path` on `env.baseUrl`, using the app's own restore
 * endpoint (for DVinyl: /backup/import, which accepts a full backup on an instance with no
 * users yet). Seeding replaces the data, so it refuses unless the config marks the instance
 * `qa.disposable: true`. Gives a known user, enabled modules and items, so pages with `:id`
 * routes get live links and a run can be repeated from the same state.
 */
async function main() {
  const configArg = process.argv[2];
  if (!configArg || !existsSync(configArg)) {
    console.error("usage: npm run qa:seed -- <config>");
    process.exit(2);
  }
  const { config, baseDir } = loadConfig(configArg);
  const seed = config.qa.seed;
  if (!config.env.baseUrl) throw new Error("config.env.baseUrl is required");
  if (!seed) throw new Error("config.qa.seed is not set (path + file of the fixture)");
  if (!config.qa.disposable) throw new Error("refusing to seed: qa.disposable is not true for this config (seeding replaces the instance's data)");

  const file = resolve(baseDir, seed.file);
  const url = new URL(seed.path, config.env.baseUrl).href;
  const res = await fetch(url, { method: "POST", headers: { "content-type": seed.contentType }, body: readFileSync(file) });
  const body = (await res.text()).slice(0, 300);
  if (!res.ok) throw new Error(`seed failed: HTTP ${res.status} from ${url}: ${body} (an instance that already has users refuses an anonymous restore: reset it first)`);
  console.log(`[qa] seeded ${url} from ${seed.file}: HTTP ${res.status} ${body}`);
}

main().catch((err) => {
  console.error("[qa] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
