---
name: seo-schedule
description: Show or change how often the SEO monitor runs in this project (weekly, 10days, 15days, monthly), and keep the Claude fix routine's schedule in sync. Use when the user asks to change, pause or check the SEO monitoring schedule.
argument-hint: "[status|weekly|10days|15days|monthly|pause|resume]"
---

# SEO monitor schedule

Find `.seo/config.json` in the current project (search from the current directory; in a monorepo there may be several, ask which). If none exists, offer `/seo-setup` and stop.

## No argument or `status`

Run `node .seo/monitor.mjs --status` from the project folder and show the result, plus the fix routine's schedule if `.claude/seo-notes.md` records a routine id (RemoteTrigger `get`).

## `weekly` | `10days` | `15days` | `monthly`

1. Run `node .seo/monitor.mjs --set-interval=<value> --status`. It saves the interval in `config.json` and prints the next run date.
2. If `.claude/seo-notes.md` has a routine id, update its cron with RemoteTrigger `update` so it fires on the same calendar days at 08:00 in the config's `timezone` converted to UTC, on a local hour that stays on the same UTC date (Asia/Dhaka: weekly `0 2 * * 1`, 10days `0 2 1,11,21 * *`, 15days `0 2 1,16 * *`, monthly `0 2 1 * *`). Show old and new cron and confirm before updating.
3. Update the `## Monitoring` section of `seo-notes.md`.
4. The change takes effect on GitHub only once `config.json` is pushed. Offer to commit and push it; alternatively the user can change it from GitHub: Actions → SEO monitor → Run workflow → set_interval.

## `pause` / `resume`

The GitHub workflow: tell the user to disable or enable it under Actions → SEO monitor → "…" → Disable workflow (or `gh workflow disable "<name>"`). The routine: RemoteTrigger `update` with `enabled: false` / `true`.

Answer in the user's language, in two or three lines.
