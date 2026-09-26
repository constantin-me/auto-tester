import { mkdirSync } from "node:fs";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer";
import type { AuthRecipe } from "../config/config.js";
import type { Observation } from "../jev/judgments.js";

/**
 * Browser driver for QA runs (M4, PER-51/52/53).
 *
 * Safety first: it runs against a real instance.
 *   - logs in ONCE through the UI; a failed login stops the run (the app locks out
 *     an address after repeated failures)
 *   - non-GET same-origin requests are blocked at the network level unless writes
 *     are explicitly allowed, so even scripts on a page cannot change data
 *   - credentials come from the environment and are never logged
 */

export interface Structure {
  title: string;
  headings: string[];
  buttons: string[];
  labels: string[];
  hasNav: boolean;
}

export interface PageEvidence {
  observation: Observation;
  structure: Structure;
  httpStatus?: number;
  /** pathname the browser ended on (after redirects) */
  finalPath: string;
  /** whether the page settled before the timeout */
  settled: boolean;
  blockedWrites: string[];
  screenshot?: string;
}

export interface SessionOptions {
  baseUrl: string;
  auth: AuthRecipe;
  allowWrites: boolean;
  headless?: boolean;
}

const SETTLE_QUIET_MS = 500;
const DOM_QUIET_MS = 300;
const SETTLE_CAP_MS = 10_000;
const MAX_TEXT = 20_000;

/** `${VAR}` -> process.env.VAR. Throws naming the variable, never the value. */
export function expandEnv(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    const v = process.env[name];
    if (!v) throw new Error(`environment variable ${name} is not set (needed by the auth recipe)`);
    return v;
  });
}

const sameOrigin = (url: string, base: URL) => {
  try {
    return new URL(url).origin === base.origin;
  } catch {
    return false;
  }
};
const isSocket = (url: string) => url.includes("/socket.io/");

export class QaSession {
  private constructor(
    private readonly browser: Browser,
    private readonly opts: SessionOptions,
    private readonly base: URL,
  ) {}

  static async open(opts: SessionOptions): Promise<QaSession> {
    const browser = await puppeteer.launch({ headless: opts.headless ?? true });
    const session = new QaSession(browser, opts, new URL(opts.baseUrl));
    try {
      await session.login();
    } catch (err) {
      await browser.close();
      throw err;
    }
    return session;
  }

  private async login(): Promise<void> {
    const { auth } = this.opts;
    if (auth.kind === "none") return;
    if (auth.kind === "token") {
      if (!auth.header) throw new Error("auth.kind=token needs auth.header");
      // applied per page in newPage()
      return;
    }
    if (!auth.loginPath || !auth.fields || !auth.submitSelector) throw new Error("auth.kind=form needs loginPath, fields and submitSelector");
    const page = await this.browser.newPage();
    try {
      await page.goto(new URL(auth.loginPath, this.base).href, { waitUntil: "domcontentloaded" });
      for (const [selector, value] of Object.entries(auth.fields)) await page.type(selector, expandEnv(value));
      await page.click(auth.submitSelector);
      const loginPath = new URL(auth.loginPath, this.base).pathname;
      try {
        await page.waitForFunction((p: string) => location.pathname !== p, { timeout: 15_000 }, loginPath);
      } catch {
        const shown = (await page.evaluate(() => document.body.innerText)).slice(0, 200).replace(/\s+/g, " ");
        throw new Error(`login failed: still on ${loginPath} after submitting. Page says: "${shown}"`);
      }
    } finally {
      await page.close();
    }
  }

  private async newPage(): Promise<{ page: Page; evidence: { errors: string[]; failed: string[]; blocked: string[]; inflight: Set<string> } }> {
    const page = await this.browser.newPage();
    // tsx/esbuild wraps named functions in __name(); functions sent to page.evaluate
    // carry that call into the browser, where it does not exist
    await page.evaluateOnNewDocument("window.__name = (f) => f");
    const evidence = { errors: [] as string[], failed: [] as string[], blocked: [] as string[], inflight: new Set<string>() };
    if (this.opts.auth.kind === "token" && this.opts.auth.header) {
      await page.setExtraHTTPHeaders({ [this.opts.auth.header.name]: expandEnv(this.opts.auth.header.value) });
    }
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = req.url();
      if (sameOrigin(url, this.base) && req.method() !== "GET" && req.method() !== "HEAD" && !this.opts.allowWrites && !isSocket(url)) {
        evidence.blocked.push(`${req.method()} ${new URL(url).pathname}`);
        void req.abort("blockedbyclient");
        return;
      }
      if (sameOrigin(url, this.base) && !isSocket(url)) evidence.inflight.add(url + "#" + req.method());
      void req.continue();
    });
    const done = (url: string, method: string) => evidence.inflight.delete(url + "#" + method);
    page.on("requestfinished", (req) => done(req.url(), req.method()));
    page.on("requestfailed", (req) => {
      done(req.url(), req.method());
      if (sameOrigin(req.url(), this.base) && !isSocket(req.url()) && req.failure()?.errorText !== "net::ERR_BLOCKED_BY_CLIENT") {
        evidence.failed.push(`${req.method()} ${new URL(req.url()).pathname} (${req.failure()?.errorText})`);
      }
    });
    page.on("response", (res) => {
      if (sameOrigin(res.url(), this.base) && !isSocket(res.url()) && res.status() >= 400 && res.request().resourceType() !== "document") {
        evidence.failed.push(`${res.request().method()} ${new URL(res.url()).pathname} -> ${res.status()}`);
      }
    });
    page.on("pageerror", (err) => evidence.errors.push(String((err as Error).message ?? err)));
    page.on("console", (msg) => {
      if (msg.type() === "error") evidence.errors.push(msg.text());
    });
    return { page, evidence };
  }

  /** No same-origin request in flight (socket.io excluded) and a quiet DOM, or the cap. */
  private async settle(page: Page, inflight: Set<string>): Promise<boolean> {
    await page.evaluate(() => {
      const w = window as any;
      w.__qaLastMutation = Date.now();
      new MutationObserver(() => (w.__qaLastMutation = Date.now())).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const start = Date.now();
    let idleSince = inflight.size === 0 ? Date.now() : 0;
    while (Date.now() - start < SETTLE_CAP_MS) {
      await new Promise((r) => setTimeout(r, 100));
      if (inflight.size > 0) {
        idleSince = 0;
        continue;
      }
      if (!idleSince) idleSince = Date.now();
      const sinceMutation = await page.evaluate(() => Date.now() - (window as any).__qaLastMutation);
      if (Date.now() - idleSince >= SETTLE_QUIET_MS && sinceMutation >= DOM_QUIET_MS) return true;
    }
    return false;
  }

  /** Visit one path read-only and capture everything a check needs. */
  async visit(path: string, evidenceDir?: string, name?: string): Promise<PageEvidence> {
    const { page, evidence } = await this.newPage();
    try {
      const response = await page.goto(new URL(path, this.base).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const settled = await this.settle(page, evidence.inflight);
      const snapshot = await page.evaluate((max: number) => {
        const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
        const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
        return {
          title: document.title,
          text: document.body ? document.body.innerText.slice(0, max) : "",
          headings: uniq([...document.querySelectorAll("h1, h2, h3")].map((h) => clean(h.textContent))),
          buttons: uniq([
            ...[...document.querySelectorAll("button")].map((b) => clean(b.textContent) || clean(b.getAttribute("aria-label")) || clean(b.getAttribute("title"))),
            ...[...document.querySelectorAll("input[type=submit]")].map((i) => clean((i as HTMLInputElement).value)),
          ]),
          labels: uniq([
            ...[...document.querySelectorAll("label")].map((l) => clean(l.textContent)),
            ...[...document.querySelectorAll("input[placeholder], textarea[placeholder]")].map((i) => clean(i.getAttribute("placeholder"))),
          ]),
          hasNav: !!document.querySelector("nav, header"),
        };
      }, MAX_TEXT);
      let screenshot: string | undefined;
      if (evidenceDir && name) {
        mkdirSync(evidenceDir, { recursive: true });
        screenshot = join(evidenceDir, `${name}.png`);
        await page.screenshot({ path: screenshot as `${string}.png`, fullPage: true });
      }
      const finalPath = new URL(page.url()).pathname;
      return {
        observation: {
          url: finalPath,
          title: snapshot.title,
          status: response?.status(),
          text: snapshot.text,
          consoleErrors: evidence.errors,
          failedRequests: evidence.failed,
        },
        structure: { title: snapshot.title, headings: snapshot.headings, buttons: snapshot.buttons, labels: snapshot.labels, hasNav: snapshot.hasNav },
        httpStatus: response?.status(),
        finalPath,
        settled,
        blockedWrites: evidence.blocked,
        screenshot,
      };
    } finally {
      await page.close();
    }
  }

  /** Same-origin link pathnames found on the given pages (used to resolve :id params). */
  async harvestLinks(paths: string[]): Promise<string[]> {
    const found = new Set<string>();
    for (const p of paths) {
      const { page, evidence } = await this.newPage();
      try {
        await page.goto(new URL(p, this.base).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await this.settle(page, evidence.inflight);
        const hrefs = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => (a as HTMLAnchorElement).href));
        for (const h of hrefs) if (sameOrigin(h, this.base)) found.add(new URL(h).pathname);
      } finally {
        await page.close();
      }
    }
    return [...found];
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
