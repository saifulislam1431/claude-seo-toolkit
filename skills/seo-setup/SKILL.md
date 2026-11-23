---
name: seo-setup
description: Set up scheduled SEO and performance monitoring for the current project. Copies the zero-dependency monitor (PageSpeed, crawl checks, Search Console, Bing, IndexNow) into .seo/, writes its config, adds a GitHub Actions workflow that runs weekly, every 10 days, every 15 days or monthly, and optionally a Claude cloud routine that fixes regressions in a PR. Use when the user asks to add SEO monitoring, the seo agent, or scheduled Lighthouse checks to a project.
argument-hint: "[weekly|10days|15days|monthly]"
---

# Set up SEO monitoring in this project

Templates live next to this file in `templates/`: `monitor.mjs`, `config.json`, `seo-monitor.yml`, `routine-prompt.md`. Write files only into the current project. Don't commit, push or create the cloud routine without asking.

## 1. Find the project

- `REPO` = `git rev-parse --show-toplevel`. `PROJECT` = the folder holding the website (where `package.json`, `index.html`, `composer.json` etc. is). In a monorepo ask which app if it isn't obvious from the current directory.
- `PROJECT_DIR` = PROJECT relative to REPO, with forward slashes (`.` if they're the same).
- `NAME` = short slug of the project (folder name), used in the workflow file name and title.
- If `PROJECT/.seo/config.json` already exists, this is a re-run: keep its values, refresh `monitor.mjs` from the template, and only fill in what's missing.

## 2. Gather the values

Discover first, ask only for what's missing (use AskUserQuestion, one call, up to 4 questions):

- **SITE**: the live URL with https and no trailing slash. Look in `.claude/seo-notes.md`, Next.js `metadataBase`, `astro.config.*` `site`, `nuxt.config.*`, `package.json` `homepage`, `README`, `CNAME`, `vercel.json`. Must be the public production URL; the monitor measures the live site, not localhost.
- **ROUTES**: the public pages that matter (JSON array of paths). Take them from the live `sitemap.xml` if it exists, otherwise from the router (`app/`, `pages/`, `src/routes/`). Keep it to the 5–10 most important pages; every route costs 2 PageSpeed calls per run. Leave out auth, dashboard, API and preview routes.
- **INTERVAL**: from the argument if given, else ask. Options with these exact descriptions:
  - `weekly`: every Monday (recommended for active sites)
  - `10days`: on the 1st, 11th and 21st of each month
  - `15days`: on the 1st and 16th
  - `monthly`: on the 1st
- **TIMEZONE**: the user's IANA timezone (from the environment, e.g. `Asia/Dhaka`). Schedule dates are calendar days in this timezone.
- **GSC_PROPERTY**: `sc-domain:<host without www>` if the user verified a Domain property in Search Console, else `SITE/` (URL-prefix property). Ask which one they use if unknown; default to `sc-domain:`.

## 3. Write the files

1. `PROJECT/.seo/monitor.mjs`: copy of `templates/monitor.mjs` as is.
2. `PROJECT/.seo/config.json`: from `templates/config.json`, replacing `__SITE__`, `__ROUTES__` (JSON array), `__INTERVAL__`, `__TIMEZONE__`, `__GSC_PROPERTY__`. Leave the thresholds at the template defaults on first setup; after the first real run, set each floor ~5 points below the measured score so a real drop gets flagged (never above 100).
3. `PROJECT/.seo/history.json`: `{"runs": []}` if it doesn't exist.
4. `REPO/.github/workflows/seo-monitor-NAME.yml`: from `templates/seo-monitor.yml`, replacing `__NAME__`, `__PROJECT_DIR__`, and `__CRON__` = daily at 03:00 in TIMEZONE converted to UTC (Asia/Dhaka UTC+6 → `0 21 * * *`; UTC → `0 3 * * *`). Monorepo: keep one workflow per project.
5. **IndexNow (Bing, Yandex, Seznam, Naver):** generate a key with `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`, write it as the only content of `<public web root>/<key>.txt` (e.g. `public/` for Next/Vite/Astro, the web root for static or PHP sites), and set `indexNow.key` in config. Keep `submitOnChange: false` until the user says yes to pinging; tell them it pings only URLs new to the sitemap.
6. `PROJECT/.claude/seo-notes.md`: create it from the template in the `seo` agent definition if missing. Add or update a `## Monitoring` section: interval, workflow path, which secrets are set, routine id once it exists.
7. If the project has a `.gitignore` that ignores dotfolders, make sure `.seo/` is not ignored.

## 4. Test locally

Run `node PROJECT/.seo/monitor.mjs --force --dry` (pass `PAGESPEED_API_KEY` from the environment if the user has one; Node 20+ can also load it with `node --env-file=<file>`). It takes 1–3 minutes. Check the report renders and the crawl section makes sense. A keyless PageSpeed quota error is expected without a key; crawl checks should still work. Show the user a short summary.

Then `node PROJECT/.seo/monitor.mjs --status` to show the schedule.

## 5. Tell the user what's left

Write this as a short checklist in the user's language:

1. **GitHub secrets** (repo → Settings → Secrets and variables → Actions → New repository secret):
   - `PAGESPEED_API_KEY`: Google Cloud Console → enable "PageSpeed Insights API" → Credentials → Create API key (restrict it to that API).
   - `GSC_SERVICE_ACCOUNT` (optional): Google Cloud → IAM → Service accounts → create → Keys → Add key → JSON; paste the whole JSON. Enable "Google Search Console API" in the project. In Search Console → Settings → Users and permissions → Add user → the service account's `client_email`, permission Restricted.
   - `BING_WEBMASTER_API_KEY` (optional): Bing Webmaster Tools → Settings (gear) → API access → API key.
   - With the `gh` CLI: `gh secret set PAGESPEED_API_KEY`, `gh secret set GSC_SERVICE_ACCOUNT < key.json`.
2. Commit and push `.seo/`, the workflow and the IndexNow key file (offer to do it). The first run happens on the next scheduled day, or right away via Actions → "SEO monitor (NAME)" → Run workflow.
3. **Fix routine (optional, needs GitHub connected at https://claude.ai/connect-github):** offer to create a Claude cloud routine with the `schedule` skill / RemoteTrigger:
   - prompt: `templates/routine-prompt.md` with `__PROJECT_DIR__` and `__SITE__` replaced
   - cron: same calendar days as the interval, at 08:00 in TIMEZONE converted to UTC. Pick a local hour that stays on the same UTC date (for Asia/Dhaka 08:00 = 02:00 UTC): weekly `0 2 * * 1`, 10days `0 2 1,11,21 * *`, 15days `0 2 1,16 * *`, monthly `0 2 1 * *`.
   - repo: the project's GitHub URL; model: the default.
   - Record the routine id in `seo-notes.md` so `/seo-schedule` can keep it in sync.
   - The routine follows `.claude/agents/seo.md` in the repo, so copy the toolkit's agent there if it's missing or older: `../../agents/seo.md` relative to this skill's folder when installed as the `seo-toolkit` plugin, `~/.claude/agents/seo.md` when copied by hand.
