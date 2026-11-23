#!/usr/bin/env node
// SEO + performance monitor. Zero dependencies, Node 20+.
//
// Reads .seo/config.json next to this file, decides whether a run is due for
// the configured interval, then measures the live site and writes:
//   .seo/history.json        every run's scores (trend data)
//   .seo/state.json          sitemap URLs seen last time (for IndexNow diffs)
//   .seo/reports/latest.md   the full report of the last run
//
// Sources (each optional except PageSpeed):
//   PageSpeed Insights API   lab scores + real-user CrUX data   env PAGESPEED_API_KEY
//   Crawl checks             robots.txt, sitemap, title/canonical/noindex per URL
//   Google Search Console    clicks, impressions, position      env GSC_SERVICE_ACCOUNT (JSON)
//   Bing Webmaster           clicks, impressions, queries       env BING_WEBMASTER_API_KEY
//   IndexNow                 pings new sitemap URLs (only if config.indexNow.submitOnChange)
//
// Flags:
//   --force               run even if not due
//   --dry                 measure and print, but write nothing
//   --set-interval=X      save a new interval (weekly|10days|15days|monthly) to config.json
//   --status              print interval, last run and next due date, then exit
//   --issue-file=PATH     also write a GitHub-issue-sized copy of the report there
//
// In GitHub Actions it writes due / regressed / summary to $GITHUB_OUTPUT and
// the report to $GITHUB_STEP_SUMMARY.

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSign } from "node:crypto";

const DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(DIR, "config.json");
const HISTORY_PATH = join(DIR, "history.json");
const STATE_PATH = join(DIR, "state.json");
const REPORT_PATH = join(DIR, "reports", "latest.md");

const INTERVALS = {
  weekly: { label: "every Monday", days: 7 },
  "10days": { label: "on the 1st, 11th and 21st", days: 10 },
  "15days": { label: "on the 1st and 16th", days: 15 },
  monthly: { label: "on the 1st of each month", days: 31 },
};
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];
const CAT_SHORT = { performance: "Perf", accessibility: "A11y", "best-practices": "BP", seo: "SEO" };

// ---------- args, config, files ----------

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : true];
  }),
);

const readJson = (path, fallback) => {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
};
const writeJson = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
};

const config = readJson(CONFIG_PATH, null);
if (!config) fail(`Missing ${CONFIG_PATH}. Run /seo-setup first.`);
if (!config.site) fail("config.json needs `site` (the live URL, e.g. https://example.com).");
config.site = config.site.replace(/\/+$/, "");
config.routes ??= ["/"];
config.strategies ??= ["mobile", "desktop"];
config.interval ??= "weekly";
config.timezone ??= "UTC";
config.runs ??= 1;
config.thresholds ??= {};
config.dropTolerance ??= { performance: 8, default: 3 };
config.issueLabel ??= "seo-regression";

if (args["set-interval"]) {
  const next = String(args["set-interval"]);
  if (!INTERVALS[next]) fail(`Unknown interval "${next}". Use: ${Object.keys(INTERVALS).join(", ")}`);
  const raw = readJson(CONFIG_PATH, {});
  raw.interval = next;
  writeJson(CONFIG_PATH, raw);
  config.interval = next;
  log(`Interval set to ${next} (${INTERVALS[next].label}).`);
}
if (!INTERVALS[config.interval]) fail(`Unknown interval "${config.interval}" in config.json.`);

const history = readJson(HISTORY_PATH, { runs: [] });
const state = readJson(STATE_PATH, {});

// ---------- schedule ----------

// Calendar date (YYYY-MM-DD) in the configured timezone.
function localDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}
const dayNumber = (ymd) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 86400000;
const fromDayNumber = (n) => new Date(n * 86400000).toISOString().slice(0, 10);

// Scheduled dates are fixed calendar days, so the monitor and the Claude fix
// routine (a plain cron) always line up.
function isScheduledDay(ymd, interval) {
  const dom = +ymd.slice(8, 10);
  const dow = new Date(dayNumber(ymd) * 86400000).getUTCDay(); // 1 = Monday
  if (interval === "weekly") return dow === 1;
  if (interval === "10days") return [1, 11, 21].includes(dom);
  if (interval === "15days") return [1, 16].includes(dom);
  return dom === 1;
}

function nextDue(fromYmd, interval) {
  let n = dayNumber(fromYmd);
  for (let i = 0; i < 40; i++, n++) if (isScheduledDay(fromDayNumber(n), interval)) return fromDayNumber(n);
  return null;
}

function scheduleDecision() {
  const today = localDate();
  const last = history.runs.at(-1)?.localDate;
  if (last === today) return { due: false, today, last, why: "already ran today" };
  if (isScheduledDay(today, config.interval)) return { due: true, today, last, why: "scheduled day" };
  // Catch up if a scheduled day was missed (runner outage, workflow disabled).
  if (last && dayNumber(today) - dayNumber(last) > INTERVALS[config.interval].days + 1)
    return { due: true, today, last, why: "missed a scheduled day" };
  if (!last) return { due: true, today, last, why: "first run" };
  return { due: false, today, last, why: `next run ${nextDue(today, config.interval)}` };
}

const decision = scheduleDecision();

if (args.status) {
  console.log(`Site:      ${config.site}`);
  console.log(`Interval:  ${config.interval} (${INTERVALS[config.interval].label}, ${config.timezone})`);
  console.log(`Last run:  ${decision.last ?? "never"}`);
  console.log(`Next run:  ${decision.due ? `${decision.today} (due now: ${decision.why})` : nextDue(fromDayNumber(dayNumber(decision.today) + 1), config.interval)}`);
  console.log(`Runs kept: ${history.runs.length}`);
  process.exit(0);
}

if (!decision.due && !args.force) {
  log(`Not due (${decision.why}).`);
  output({ due: "false", regressed: "false" });
  process.exit(0);
}

// ---------- helpers ----------

function log(msg) { console.log(msg); }
function fail(msg) { console.error(`seo-monitor: ${msg}`); process.exit(1); }
function output(map) {
  if (!process.env.GITHUB_OUTPUT) return;
  for (const [k, v] of Object.entries(map)) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const oneLine = (s, max = 160) => String(s).replace(/\s+/g, " ").replace(/\|/g, "/").trim().slice(0, max);
const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};
const pct = (score) => (score == null ? null : Math.round(score * 100));
const fmtMs = (ms) => (ms == null ? "-" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const fmtCls = (v) => (v == null ? "-" : v.toFixed(3));
const absUrl = (route) => (route.startsWith("http") ? route : config.site + (route.startsWith("/") ? route : `/${route}`));

async function fetchRetry(url, opts = {}, { tries = 3, timeout = 120000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeout) });
      if (res.status === 429 || res.status >= 500) {
        const text = await res.text();
        let msg = text;
        try { msg = JSON.parse(text)?.error?.message ?? text; } catch { /* not JSON */ }
        const err = new Error(`HTTP ${res.status}: ${oneLine(msg)}`);
        // A daily quota won't recover in seconds; don't burn time retrying.
        err.final = res.status === 429 && /per day/i.test(msg);
        throw err;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (e.final) break;
      if (i < tries - 1) await sleep(5000 * (i + 1));
    }
  }
  throw lastErr;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ---------- PageSpeed Insights ----------

async function psiOnce(url, strategy) {
  const u = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  u.searchParams.set("url", url);
  u.searchParams.set("strategy", strategy);
  for (const c of CATEGORIES) u.searchParams.append("category", c);
  if (process.env.PAGESPEED_API_KEY) u.searchParams.set("key", process.env.PAGESPEED_API_KEY);
  const res = await fetchRetry(u, {}, { tries: 3, timeout: 150000 });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body;
}

function parsePsi(body) {
  const lh = body.lighthouseResult;
  const a = lh.audits;
  const scores = Object.fromEntries(CATEGORIES.map((c) => [c, pct(lh.categories[c]?.score)]));
  const lab = {
    lcp: a["largest-contentful-paint"]?.numericValue ?? null,
    cls: a["cumulative-layout-shift"]?.numericValue ?? null,
    tbt: a["total-blocking-time"]?.numericValue ?? null,
    fcp: a["first-contentful-paint"]?.numericValue ?? null,
    si: a["speed-index"]?.numericValue ?? null,
  };
  // Real-user data (CrUX, last 28 days). Page-level if Google has enough
  // traffic for this URL, otherwise origin-level, otherwise nothing.
  const le = body.loadingExperience?.metrics ? body.loadingExperience : body.originLoadingExperience;
  let field = null;
  if (le?.metrics) {
    const m = le.metrics;
    field = {
      scope: le === body.loadingExperience && !le.origin_fallback ? "page" : "origin",
      overall: le.overall_category ?? null,
      lcp: m.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null,
      inp: m.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
      cls: m.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile != null ? m.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : null,
    };
  }
  // Failing audits, for the report and the fix agent.
  const failing = [];
  for (const c of CATEGORIES) {
    for (const ref of lh.categories[c]?.auditRefs ?? []) {
      const audit = a[ref.id];
      if (!audit || audit.score == null || audit.score >= 0.9) continue;
      if (!["binary", "numeric", "metricSavings"].includes(audit.scoreDisplayMode)) continue;
      if (c === "performance" && ref.group === "metrics") continue;
      failing.push({ category: c, id: ref.id, title: audit.title, display: audit.displayValue ?? "" });
    }
  }
  return { scores, lab, field, failing };
}

async function measure(route, strategy) {
  const url = absUrl(route);
  const runs = [];
  let error = null;
  for (let i = 0; i < config.runs; i++) {
    try { runs.push(parsePsi(await psiOnce(url, strategy))); } catch (e) { error = String(e.message ?? e); }
  }
  if (!runs.length) return { route, strategy, error };
  const pick = (f) => median(runs.map(f));
  return {
    route, strategy,
    scores: Object.fromEntries(CATEGORIES.map((c) => [c, pick((r) => r.scores[c])])),
    lab: Object.fromEntries(Object.keys(runs[0].lab).map((k) => [k, pick((r) => r.lab[k])])),
    field: runs[0].field,
    failing: runs[0].failing,
  };
}

// ---------- crawl checks ----------

const textOf = (html, re) => html.match(re)?.[1]?.trim() ?? null;
const metaContent = (html, attr, name) => {
  const tag = html.match(new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]*>`, "i"))?.[0];
  return tag ? textOf(tag, /content=["']([^"']*)["']/i) : null;
};
const normalize = (u) => { try { const x = new URL(u); x.hash = ""; return x.href.replace(/\/$/, ""); } catch { return u; } };

async function crawl() {
  const errors = [];
  const warnings = [];
  const pages = [];
  let sitemapUrls = [];

  // robots.txt
  let robots = "";
  try {
    const res = await fetchRetry(`${config.site}/robots.txt`, {}, { tries: 2, timeout: 30000 });
    robots = res.ok ? await res.text() : "";
    if (!res.ok) errors.push(`robots.txt returns HTTP ${res.status}`);
  } catch (e) { errors.push(`robots.txt unreachable: ${e.message}`); }
  if (robots) {
    // Blocks everything for all crawlers?
    const blocks = robots.split(/\n(?=\s*user-agent)/i).some((g) => /user-agent:\s*\*/i.test(g) && /^\s*disallow:\s*\/\s*$/im.test(g));
    if (blocks) errors.push("robots.txt blocks the whole site (`Disallow: /` for `User-agent: *`)");
    if (!/^\s*sitemap:/im.test(robots)) warnings.push("robots.txt has no `Sitemap:` line");
  }

  // sitemap (follows one level of sitemap index)
  const sitemapUrl = robots.match(/^\s*sitemap:\s*(\S+)/im)?.[1] ?? `${config.site}/sitemap.xml`;
  async function readSitemap(url, depth = 0) {
    const res = await fetchRetry(url, {}, { tries: 2, timeout: 30000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
    if (/<sitemapindex/i.test(xml) && depth === 0) return (await Promise.all(locs.map((l) => readSitemap(l, 1)))).flat();
    return locs;
  }
  try {
    sitemapUrls = [...new Set(await readSitemap(sitemapUrl))];
    if (!sitemapUrls.length) errors.push(`sitemap ${sitemapUrl} lists no URLs`);
  } catch (e) { errors.push(`sitemap ${sitemapUrl} unreachable: ${e.message}`); }

  const sitemapSet = new Set(sitemapUrls.map(normalize));
  for (const r of config.routes) if (!sitemapSet.has(normalize(absUrl(r)))) warnings.push(`${r} is in config.routes but not in the sitemap`);

  // per-page checks (sitemap URLs + configured routes, capped)
  const seen = new Set();
  const targets = [...config.routes.map(absUrl), ...sitemapUrls]
    .filter((u) => !seen.has(normalize(u)) && seen.add(normalize(u)))
    .slice(0, config.maxCrawl ?? 60);
  const titles = new Map();
  await pool(targets, 4, async (url) => {
    const page = { url, issues: [] };
    pages.push(page);
    try {
      const res = await fetchRetry(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; seo-monitor)" } }, { tries: 2, timeout: 30000 });
      page.status = res.status;
      if (res.redirected) page.issues.push(`redirects to ${res.url}`);
      if (!res.ok) { page.issues.push(`HTTP ${res.status}`); return; }
      const html = await res.text();
      const robotsMeta = `${metaContent(html, "name", "robots") ?? ""} ${res.headers.get("x-robots-tag") ?? ""}`;
      if (/noindex/i.test(robotsMeta)) page.issues.push("noindex");
      const title = textOf(html, /<title[^>]*>([^<]*)<\/title>/i);
      if (!title) page.issues.push("missing <title>");
      else {
        if (title.length > 65) page.issues.push(`title is ${title.length} chars (keep ≤ 60)`);
        titles.set(title, [...(titles.get(title) ?? []), url]);
      }
      const desc = metaContent(html, "name", "description");
      if (!desc) page.issues.push("missing meta description");
      else if (desc.length > 165) page.issues.push(`meta description is ${desc.length} chars (keep ≤ 155)`);
      const canonicalTag = html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0];
      const canonical = canonicalTag ? textOf(canonicalTag, /href=["']([^"']+)["']/i) : null;
      if (!canonical) page.issues.push("missing canonical");
      else if (normalize(new URL(canonical, url).href) !== normalize(res.url)) page.issues.push(`canonical points elsewhere: ${canonical}`);
      const h1 = (html.match(/<h1[\s>]/gi) ?? []).length;
      if (h1 === 0) page.issues.push("no <h1> in the server HTML");
      if (h1 > 1) page.issues.push(`${h1} <h1> tags`);
      if (!/<html[^>]+lang=/i.test(html)) page.issues.push("<html> has no lang");
      if (normalize(url) === normalize(config.site)) {
        page.verification = {
          google: !!metaContent(html, "name", "google-site-verification"),
          bing: !!metaContent(html, "name", "msvalidate.01"),
        };
      }
    } catch (e) { page.issues.push(`unreachable: ${e.message}`); }
  });
  for (const [title, urls] of titles) if (urls.length > 1) warnings.push(`duplicate title "${title}" on ${urls.length} pages`);

  // Which issues block indexing (errors) vs. hurt it (warnings)
  const blocking = /^(HTTP|noindex|unreachable|missing <title>|missing canonical|canonical points)/;
  for (const p of pages) {
    const inSitemap = sitemapSet.has(normalize(p.url));
    for (const issue of p.issues) {
      const where = new URL(p.url).pathname;
      if (blocking.test(issue) && (inSitemap || config.routes.map(absUrl).includes(p.url))) errors.push(`${where}: ${issue}`);
      else warnings.push(`${where}: ${issue}`);
    }
  }
  pages.sort((a, b) => a.url.localeCompare(b.url));
  return { errors, warnings, pages, sitemapUrls, verification: pages.find((p) => p.verification)?.verification ?? null };
}

// ---------- Google Search Console ----------

async function googleToken(sa, scope) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
  const res = await fetchRetry("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  }, { tries: 2, timeout: 30000 });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description ?? body.error ?? `HTTP ${res.status}`);
  return body.access_token;
}

async function searchConsole() {
  const raw = process.env.GSC_SERVICE_ACCOUNT;
  if (!raw) return { skipped: "GSC_SERVICE_ACCOUNT not set" };
  const property = config.searchConsole?.property ?? `${config.site}/`;
  try {
    const sa = JSON.parse(raw);
    const token = await googleToken(sa, "https://www.googleapis.com/auth/webmasters.readonly");
    const base = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}`;
    const end = fromDayNumber(dayNumber(localDate()) - 3); // GSC data lags ~2-3 days
    const start = fromDayNumber(dayNumber(end) - 27);
    const q = async (body) => {
      const res = await fetchRetry(`${base}/searchAnalytics/query`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ startDate: start, endDate: end, ...body }),
      }, { tries: 2, timeout: 60000 });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      return json.rows ?? [];
    };
    const [totalsRows, queries, pagesRows] = await Promise.all([
      q({}),
      q({ dimensions: ["query"], rowLimit: 15 }),
      q({ dimensions: ["page"], rowLimit: 15 }),
    ]);
    let sitemaps = [];
    try {
      const res = await fetchRetry(`${base}/sitemaps`, { headers: { authorization: `Bearer ${token}` } }, { tries: 2, timeout: 30000 });
      const json = await res.json();
      if (res.ok) sitemaps = (json.sitemap ?? []).map((s) => ({ path: s.path, errors: +(s.errors ?? 0), warnings: +(s.warnings ?? 0), lastDownloaded: s.lastDownloaded ?? null }));
    } catch { /* sitemaps are a bonus */ }
    const t = totalsRows[0] ?? { clicks: 0, impressions: 0, ctr: 0, position: null };
    const row = (r) => ({ key: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: +(r.ctr * 100).toFixed(1), position: +r.position.toFixed(1) });
    return {
      property, range: `${start}..${end}`,
      totals: { clicks: t.clicks, impressions: t.impressions, ctr: +(t.ctr * 100).toFixed(1), position: t.position == null ? null : +t.position.toFixed(1) },
      queries: queries.map(row), pages: pagesRows.map(row), sitemaps,
    };
  } catch (e) {
    return { error: `Search Console: ${e.message}. Check that the service account email is added as a user on the ${property} property.` };
  }
}

// ---------- Bing Webmaster ----------

async function bing() {
  const key = process.env.BING_WEBMASTER_API_KEY;
  if (!key) return { skipped: "BING_WEBMASTER_API_KEY not set" };
  const siteUrl = config.bing?.siteUrl ?? `${config.site}/`;
  const call = async (method) => {
    const u = `https://ssl.bing.com/webmaster/api.svc/json/${method}?siteUrl=${encodeURIComponent(siteUrl)}&apikey=${encodeURIComponent(key)}`;
    const res = await fetchRetry(u, {}, { tries: 2, timeout: 60000 });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text).d ?? [];
  };
  const dateOf = (s) => Number(String(s).match(/\d+/)?.[0] ?? 0);
  try {
    const since = Date.now() - 28 * 86400000;
    const traffic = (await call("GetRankAndTrafficStats")).filter((r) => dateOf(r.Date) >= since);
    const queries = (await call("GetQueryStats")).filter((r) => dateOf(r.Date) >= since);
    const byQuery = new Map();
    for (const r of queries) {
      const q = byQuery.get(r.Query) ?? { key: r.Query, clicks: 0, impressions: 0, posSum: 0, n: 0 };
      q.clicks += r.Clicks; q.impressions += r.Impressions; q.posSum += r.AvgImpressionPosition ?? 0; q.n++;
      byQuery.set(r.Query, q);
    }
    return {
      siteUrl,
      totals: { clicks: traffic.reduce((s, r) => s + r.Clicks, 0), impressions: traffic.reduce((s, r) => s + r.Impressions, 0) },
      queries: [...byQuery.values()].sort((a, b) => b.impressions - a.impressions).slice(0, 15)
        .map(({ key, clicks, impressions, posSum, n }) => ({ key, clicks, impressions, position: n ? +(posSum / n).toFixed(1) : null })),
    };
  } catch (e) {
    return { error: `Bing Webmaster: ${e.message}. Check the API key and that ${siteUrl} is verified in Bing.` };
  }
}

// ---------- IndexNow ----------

async function indexNow(sitemapUrls) {
  const cfg = config.indexNow ?? {};
  if (!cfg.key) return { skipped: "no indexNow.key in config" };
  if (!cfg.submitOnChange) return { skipped: "indexNow.submitOnChange is false" };
  if (args.dry) return { skipped: "dry run" };
  const known = new Set(state.sitemapUrls ?? []);
  const fresh = sitemapUrls.filter((u) => !known.has(u));
  if (!fresh.length) return { submitted: 0 };
  const keyLocation = `${config.site}/${cfg.key}.txt`;
  try {
    const check = await fetchRetry(keyLocation, {}, { tries: 2, timeout: 30000 });
    if (!check.ok || !(await check.text()).includes(cfg.key)) return { error: `IndexNow key file not live at ${keyLocation}; deploy it first.` };
    const res = await fetchRetry("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: new URL(config.site).host, key: cfg.key, keyLocation, urlList: fresh.slice(0, 10000) }),
    }, { tries: 2, timeout: 30000 });
    if (![200, 202].includes(res.status)) return { error: `IndexNow HTTP ${res.status}` };
    return { submitted: fresh.length, urls: fresh };
  } catch (e) { return { error: `IndexNow: ${e.message}` }; }
}

// ---------- compare + report ----------

function compare(results, crawlResult, gsc, bingResult) {
  const regressions = [];
  const warnings = [...crawlResult.warnings];
  const prev = [...history.runs].reverse();
  const prevResult = (route, strategy) => {
    for (const run of prev) {
      const r = run.results?.find((x) => x.route === route && x.strategy === strategy && !x.error);
      if (r) return { r, date: run.localDate };
    }
    return null;
  };
  for (const r of results) {
    if (r.error) { regressions.push(`${r.route} (${r.strategy}): PageSpeed failed: ${r.error}`); continue; }
    const floor = config.thresholds[r.strategy] ?? {};
    const before = prevResult(r.route, r.strategy);
    for (const c of CATEGORIES) {
      const now = r.scores[c];
      if (now == null) continue;
      if (floor[c] != null && now < floor[c]) regressions.push(`${r.route} (${r.strategy}): ${CAT_SHORT[c]} ${now} is below the floor ${floor[c]}`);
      const tol = config.dropTolerance[c] ?? config.dropTolerance.default ?? 3;
      const was = before?.r.scores?.[c];
      if (was != null && was - now > tol) regressions.push(`${r.route} (${r.strategy}): ${CAT_SHORT[c]} dropped ${was} → ${now} since ${before.date}`);
    }
    if (r.field?.overall === "SLOW") warnings.push(`${r.route} (${r.strategy}): real users see poor Core Web Vitals (${r.field.scope}-level CrUX)`);
  }
  regressions.push(...crawlResult.errors);
  for (const src of [gsc, bingResult]) if (src?.error) warnings.push(src.error);

  const lastWith = (key) => prev.find((run) => run[key]?.totals)?.[key]?.totals;
  const gPrev = lastWith("gsc");
  if (gsc?.totals && gPrev) {
    if (gPrev.clicks >= 20 && gsc.totals.clicks < gPrev.clicks * 0.7) regressions.push(`Google clicks fell ${gPrev.clicks} → ${gsc.totals.clicks} (28 days)`);
    if (gPrev.position != null && gsc.totals.position != null && gsc.totals.position - gPrev.position > 3) warnings.push(`Google average position worsened ${gPrev.position} → ${gsc.totals.position}`);
  }
  for (const s of gsc?.sitemaps ?? []) if (s.errors) regressions.push(`Search Console reports ${s.errors} error(s) in ${s.path}`);
  const bPrev = lastWith("bing");
  if (bingResult?.totals && bPrev && bPrev.clicks >= 20 && bingResult.totals.clicks < bPrev.clicks * 0.7)
    regressions.push(`Bing clicks fell ${bPrev.clicks} → ${bingResult.totals.clicks} (28 days)`);
  return { regressions, warnings };
}

function delta(now, was) {
  if (now == null || was == null || now === was) return "";
  return now > was ? ` ▲${now - was}` : ` ▼${was - now}`;
}

function buildReport({ results, crawlResult, gsc, bingResult, indexNowResult, verdict }) {
  const prevRun = history.runs.at(-1);
  const prevScore = (r, c) => prevRun?.results?.find((x) => x.route === r.route && x.strategy === r.strategy)?.scores?.[c];
  const L = [];
  L.push(`# SEO & performance report: ${config.site}`);
  L.push("");
  L.push(`${decision.today} · interval: ${config.interval} (${INTERVALS[config.interval].label}) · previous run: ${prevRun?.localDate ?? "none"}`);
  L.push("");
  L.push(verdict.regressions.length ? `**${verdict.regressions.length} regression(s) need attention.**` : "**No regressions.**");
  L.push("");
  if (verdict.regressions.length) {
    L.push("## Regressions");
    for (const x of verdict.regressions) L.push(`- ${x}`);
    L.push("");
  }
  L.push("## Lighthouse (PageSpeed Insights)");
  L.push("");
  L.push("| Page | Device | Perf | A11y | BP | SEO | LCP | CLS | TBT | Real users (CrUX) |");
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    if (r.error) { L.push(`| ${r.route} | ${r.strategy} | error | | | | | | | ${oneLine(r.error, 100)} |`); continue; }
    const s = (c) => `${r.scores[c] ?? "-"}${delta(r.scores[c], prevScore(r, c))}`;
    const f = r.field ? `${r.field.overall ?? "?"} (${r.field.scope}) LCP ${fmtMs(r.field.lcp)}, INP ${fmtMs(r.field.inp)}, CLS ${fmtCls(r.field.cls)}` : "not enough traffic";
    L.push(`| ${r.route} | ${r.strategy} | ${s("performance")} | ${s("accessibility")} | ${s("best-practices")} | ${s("seo")} | ${fmtMs(r.lab.lcp)} | ${fmtCls(r.lab.cls)} | ${fmtMs(r.lab.tbt)} | ${f} |`);
  }
  L.push("");
  const failing = new Map();
  for (const r of results) for (const a of r.failing ?? []) {
    const k = `${a.category}|${a.id}`;
    const e = failing.get(k) ?? { ...a, where: [] };
    e.where.push(`${r.route} ${r.strategy}${a.display ? ` (${a.display})` : ""}`);
    failing.set(k, e);
  }
  if (failing.size) {
    L.push("### Failing audits");
    for (const c of CATEGORIES) for (const a of [...failing.values()].filter((x) => x.category === c))
      L.push(`- **${CAT_SHORT[c]}** \`${a.id}\`: ${a.title}. ${a.where.join("; ")}`);
    L.push("");
  }
  L.push("## Crawl checks");
  L.push(`Sitemap URLs: ${crawlResult.sitemapUrls.length} · pages checked: ${crawlResult.pages.length}`);
  if (crawlResult.verification) L.push(`Verification tags on home page: Google ${crawlResult.verification.google ? "yes" : "no"}, Bing ${crawlResult.verification.bing ? "yes" : "no"}`);
  if (crawlResult.errors.length || crawlResult.warnings.length) {
    for (const x of crawlResult.errors) L.push(`- ❌ ${x}`);
    for (const x of crawlResult.warnings) L.push(`- ⚠️ ${x}`);
  } else L.push("- All pages: 200, indexable, title, description, canonical and h1 present.");
  L.push("");
  const searchBlock = (name, src) => {
    L.push(`## ${name}`);
    if (src.skipped) { L.push(`Skipped: ${src.skipped}.`); L.push(""); return; }
    if (src.error) { L.push(src.error); L.push(""); return; }
    L.push(`Last 28 days${src.range ? ` (${src.range})` : ""}: **${src.totals.clicks} clicks**, ${src.totals.impressions} impressions${src.totals.ctr != null ? `, CTR ${src.totals.ctr}%` : ""}${src.totals.position != null ? `, avg position ${src.totals.position}` : ""}`);
    if (src.queries?.length) {
      L.push("");
      L.push("| Query | Clicks | Impressions | Position |");
      L.push("|---|---|---|---|");
      for (const q of src.queries) L.push(`| ${q.key.replace(/\|/g, "/")} | ${q.clicks} | ${q.impressions} | ${q.position ?? "-"} |`);
    }
    if (src.pages?.length) {
      L.push("");
      L.push("| Page | Clicks | Impressions | Position |");
      L.push("|---|---|---|---|");
      for (const p of src.pages) L.push(`| ${p.key} | ${p.clicks} | ${p.impressions} | ${p.position} |`);
    }
    L.push("");
  };
  searchBlock("Google Search Console", gsc);
  searchBlock("Bing Webmaster", bingResult);
  L.push("## IndexNow");
  L.push(indexNowResult.skipped ? `Skipped: ${indexNowResult.skipped}.` : indexNowResult.error ?? `Submitted ${indexNowResult.submitted} new URL(s).`);
  L.push("");
  const otherWarnings = verdict.warnings.filter((x) => !crawlResult.warnings.includes(x));
  if (otherWarnings.length) {
    L.push("## Warnings");
    for (const x of otherWarnings) L.push(`- ${x}`);
    L.push("");
  }
  L.push(`Next run: ${nextDue(fromDayNumber(dayNumber(decision.today) + 1), config.interval)}. Lab scores vary by a few points between runs; a single drop inside the tolerance (${JSON.stringify(config.dropTolerance)}) is not flagged.`);
  return L.join("\n") + "\n";
}

// ---------- main ----------

log(`Monitoring ${config.site} (${decision.why}${args.force ? ", forced" : ""})`);
if (!process.env.PAGESPEED_API_KEY) log("PAGESPEED_API_KEY is not set: using the shared keyless quota, which often fails.");

const jobs = config.routes.flatMap((route) => config.strategies.map((strategy) => ({ route, strategy })));
const [results, crawlResult, gsc, bingResult] = await Promise.all([
  pool(jobs, 2, ({ route, strategy }) => { log(`  PageSpeed ${strategy} ${route}`); return measure(route, strategy); }),
  crawl(),
  searchConsole(),
  bing(),
]);
const indexNowResult = await indexNow(crawlResult.sitemapUrls);
const verdict = compare(results, crawlResult, gsc, bingResult);
const report = buildReport({ results, crawlResult, gsc, bingResult, indexNowResult, verdict });
console.log("\n" + report);

const allFailed = results.every((r) => r.error);
if (args.dry) {
  log("Dry run: nothing written.");
} else if (allFailed) {
  log("Every PageSpeed call failed, so this run is not recorded and will be retried next time.");
} else {
  history.runs.push({
    localDate: decision.today,
    at: new Date().toISOString(),
    interval: config.interval,
    forced: !!args.force,
    results: results.map(({ failing, ...r }) => r),
    crawl: { errors: crawlResult.errors.length, warnings: crawlResult.warnings.length, sitemapUrls: crawlResult.sitemapUrls.length },
    gsc: gsc.totals ? { range: gsc.range, totals: gsc.totals } : undefined,
    bing: bingResult.totals ? { totals: bingResult.totals } : undefined,
    regressions: verdict.regressions,
  });
  history.runs = history.runs.slice(-(config.keepRuns ?? 60));
  writeJson(HISTORY_PATH, history);
  if (crawlResult.sitemapUrls.length) writeJson(STATE_PATH, { ...state, sitemapUrls: crawlResult.sitemapUrls });
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, report);
  log(`Wrote ${HISTORY_PATH} and ${REPORT_PATH}`);
}

if (args["issue-file"]) {
  const max = 60000; // GitHub issue body limit is 65,536 characters
  writeFileSync(String(args["issue-file"]), report.length > max ? report.slice(0, max) + "\n\n…report truncated; see .seo/reports/latest.md\n" : report);
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
output({
  due: "true",
  recorded: String(!args.dry && !allFailed),
  regressed: String(verdict.regressions.length > 0),
  summary: verdict.regressions.length ? `${verdict.regressions.length} regression(s)` : "no regressions",
  date: decision.today,
});
