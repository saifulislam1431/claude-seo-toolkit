#!/usr/bin/env node
// Turns a Lighthouse CI run on the default branch into something the SEO
// agent can act on. Zero dependencies, Node 20+.
//
// Reads the LHCI output folder (manifest.json and assertion-results.json) and
// keeps .seo/reports/ci-latest.md up to date:
//   - a failing run writes the failed assertions and the score table there,
//     and an issue body for the "seo-regression" GitHub issue
//   - the first passing run after a failure rewrites it as passing
//   - a passing run when it was already passing changes nothing (no commit)
//
// The Claude fix routine reads ci-latest.md next to the monitor's report, so
// a regression caught in CI gets fixed before it is deployed.
//
// Flags:
//   --outcome=success|failure   the LHCI step's outcome (required)
//   --lhci-dir=PATH             LHCI output folder (default .lighthouseci)
//   --issue-file=PATH           where to write the issue body on failure
//
// Writes changed / failing / summary to $GITHUB_OUTPUT and the report to
// $GITHUB_STEP_SUMMARY.

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const REPORT = join(DIR, "reports", "ci-latest.md");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : true];
  }),
);
const outcome = String(args.outcome ?? "");
if (!["success", "failure"].includes(outcome)) {
  console.log(`ci-report: outcome "${outcome}" is neither success nor failure (cancelled or skipped); nothing to do.`);
  process.exit(0);
}
const lhciDir = String(args["lhci-dir"] ?? ".lighthouseci");
const failing = outcome === "failure";

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const output = (map) => {
  if (!process.env.GITHUB_OUTPUT) return;
  for (const [k, v] of Object.entries(map)) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
};

const wasFailing = existsSync(REPORT) && /^Status: failing/m.test(readFileSync(REPORT, "utf8"));
if (!failing && !wasFailing) {
  console.log("Lighthouse CI passed and was already passing: nothing to update.");
  output({ changed: "false", failing: "false", summary: "passing" });
  process.exit(0);
}

const sha = (process.env.GITHUB_SHA ?? "").slice(0, 7) || "local";
const runUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null;
const date = new Date().toISOString().slice(0, 10);
const path = (u) => { try { return new URL(u).pathname; } catch { return u; } };
const pct = (v) => (v == null ? "-" : Math.round(v * 100));

// Scores of the representative (median) run per URL.
const manifest = readJson(join(lhciDir, "manifest.json")) ?? [];
const rows = manifest.filter((r) => r.isRepresentativeRun);

// Failed assertions; warnings are listed separately and don't fail the run.
const assertions = (readJson(join(lhciDir, "assertion-results.json")) ?? []).filter((a) => !a.passed);
const fmt = (a, v) => {
  if (v == null) return "-";
  if (/categories/.test(a.auditId ?? a.name ?? "") || a.auditProperty === "score" || a.name === "minScore") return pct(v);
  return Math.round(v * 1000) / 1000;
};
const line = (a) => {
  const what = a.auditProperty ? `${a.auditId}.${a.auditProperty}` : a.auditId ?? a.name;
  return `${path(a.url)}: \`${what}\` ${a.name ?? ""} expected ${a.operator ?? ""}${fmt(a, a.expected)}, found ${fmt(a, a.actual)}`;
};
const errors = assertions.filter((a) => a.level === "error");
const warnings = assertions.filter((a) => a.level !== "error");

const L = [];
L.push(`# Lighthouse CI on the default branch`);
L.push("");
L.push(`Status: ${failing ? "failing" : "passing"}`);
L.push("");
L.push(`${date} · commit ${sha}${runUrl ? ` · [run](${runUrl})` : ""}`);
L.push("");
if (failing) {
  L.push(`The last build of the default branch fails its Lighthouse floors. This is not deployed yet unless it was shipped anyway; fix it before the next deploy.`);
  L.push("");
  if (errors.length) {
    L.push("## Failed assertions");
    for (const a of errors) L.push(`- ${line(a)}`);
    L.push("");
  } else {
    L.push("No assertion results were found; the build or the server may have failed before Lighthouse ran. Check the run log.");
    L.push("");
  }
} else {
  L.push("Lighthouse CI passes again; the earlier failure is resolved.");
  L.push("");
}
if (rows.length) {
  L.push("## Scores (median run, mobile)");
  L.push("");
  L.push("| Page | Perf | A11y | BP | SEO |");
  L.push("|---|---|---|---|---|");
  for (const r of rows) {
    const s = r.summary ?? {};
    L.push(`| ${path(r.url)} | ${pct(s.performance)} | ${pct(s.accessibility)} | ${pct(s["best-practices"])} | ${pct(s.seo)} |`);
  }
  L.push("");
}
if (warnings.length) {
  L.push("## Warnings (do not fail the build)");
  for (const a of warnings.slice(0, 20)) L.push(`- ${line(a)}`);
  L.push("");
}
const report = L.join("\n") + "\n";

mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, report);
console.log(report);
if (failing && args["issue-file"]) writeFileSync(String(args["issue-file"]), report.slice(0, 60000));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
output({
  changed: "true",
  failing: String(failing),
  summary: failing ? `${errors.length} failed Lighthouse assertion(s)` : "passing again",
  date,
});
