---
name: seo-audit
description: Run an on-demand SEO and performance check of the current project's live site (PageSpeed mobile and desktop, crawl checks, Search Console and Bing when keys are set), compare it with the monitoring history, and propose or apply fixes with the seo agent. Use when the user asks to check, audit or measure SEO or performance now.
argument-hint: "[fix]"
---

# SEO audit now

1. Find `.seo/monitor.mjs` in the current project. If it's missing, run the checks the `seo` agent describes without it (PageSpeed API or local Lighthouse), and offer `/seo-setup` at the end.
2. Run `node .seo/monitor.mjs --force --dry` from the project folder. The dry run doesn't write history, so the scheduled runs stay comparable. Keys come from the environment (`PAGESPEED_API_KEY`, `GSC_SERVICE_ACCOUNT`, `BING_WEBMASTER_API_KEY`); if a local env file holds them, use `node --env-file=<file> .seo/monitor.mjs --force --dry`. Never print key values.
3. Hand the report to the `seo` agent (Agent tool, subagent_type `seo`, or `seo-toolkit:seo` when installed as a plugin) with the task:
   - without `fix`: find the causes in code and give a ranked list (impact × effort) with `file:line`; don't edit.
   - with `fix`: fix what's safe in code, build, and report before/after. Follow the project's constraints in `.claude/seo-notes.md`.
4. Reply in the user's language: the scores table (mobile and desktop), regressions, top 3–5 actions, and what only the user can do (content, links, Search Console).
