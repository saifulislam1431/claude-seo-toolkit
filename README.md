# SEO toolkit for Claude Code

An SEO and performance agent, plus scheduled monitoring for any live website:

- **`seo` agent**: audits and fixes SEO and performance issues (Lighthouse, Core Web Vitals, metadata, sitemap, structured data, Search Console and Bing setup).
- **`/seo-setup`**: installs monitoring in the current project. It adds `.seo/` (a zero-dependency monitor), a scheduled GitHub Actions workflow, Lighthouse CI on every push and pull request, and an IndexNow key file.
- **`/seo-schedule`**: shows or changes the interval (weekly, 10days, 15days, monthly), or pauses it.
- **`/seo-audit [fix]`**: measures the live site now and has the agent explain or fix what it finds.

How a run works: a GitHub Actions workflow wakes daily and, on the scheduled days, measures the live site with PageSpeed Insights (mobile and desktop), checks robots.txt, the sitemap and every page's title, description, canonical and noindex, and reads Search Console and Bing data. It commits the results to `.seo/`, opens a GitHub issue when something regresses, and sends new sitemap URLs to IndexNow. Lighthouse CI also checks every push and pull request; when the default branch fails it, the same issue is opened and `.seo/reports/ci-latest.md` is written, so a regression is caught before it is deployed. An optional Claude cloud routine reads the report on the same days and opens a pull request with fixes; a person reviews and merges.

## Install as a plugin (recommended)

In a terminal (needs the Claude Code CLI; the `/plugin` command is not available in the VS Code extension chat):

```
claude plugin marketplace add saifulislam1431/claude-seo-toolkit
claude plugin install seo-toolkit@saifulislam1431
```

Or inside the CLI (`claude`), the same as slash commands: `/plugin marketplace add saifulislam1431/claude-seo-toolkit`, then `/plugin install seo-toolkit@saifulislam1431`. Once installed, the plugin also works in the VS Code extension.

No CLI yet? Windows PowerShell: `irm https://claude.ai/install.ps1 | iex`. macOS or Linux: `curl -fsSL https://claude.ai/install.sh | bash`. On Windows it lands in `%USERPROFILE%.localin`, which may need adding to PATH.

Restart Claude Code. As a plugin the commands are namespaced: `/seo-toolkit:seo-setup`, `/seo-toolkit:seo-schedule`, `/seo-toolkit:seo-audit`, and the agent is `seo-toolkit:seo`. You can also just ask, for example "set up SEO monitoring for this project".

Get updates with `claude plugin marketplace update saifulislam1431` and `claude plugin update seo-toolkit@saifulislam1431`, then restart.

## Install from the zip

Copy the folders into your Claude Code home folder: `C:\Users\<you>\.claude\` on Windows, `~/.claude/` on macOS and Linux.

| From the zip | To |
| --- | --- |
| `agents/seo.md` | `~/.claude/agents/seo.md` |
| `skills/seo-setup/` | `~/.claude/skills/seo-setup/` |
| `skills/seo-schedule/` | `~/.claude/skills/seo-schedule/` |
| `skills/seo-audit/` | `~/.claude/skills/seo-audit/` |

Windows PowerShell, from the unzipped folder:

```
New-Item -ItemType Directory -Force "$HOME\.claude\agents", "$HOME\.claude\skills" | Out-Null
Copy-Item agents\seo.md "$HOME\.claude\agents\" -Force
Copy-Item skills\* "$HOME\.claude\skills\" -Recurse -Force
```

macOS or Linux, from the unzipped folder:

```
mkdir -p ~/.claude/agents ~/.claude/skills
cp agents/seo.md ~/.claude/agents/
cp -R skills/* ~/.claude/skills/
```

Restart Claude Code. The commands are `/seo-setup`, `/seo-schedule` and `/seo-audit`. A zip copy doesn't update itself: copy a newer zip over it.

Use one way, not both: a hand-copied toolkit and the plugin side by side show every command twice.

## Requirements

- Claude Code, and Node 20 or newer.
- A website that is live on a public URL, with its code in a GitHub repo you can push to.
- Keys (all free) go into GitHub secrets: `PAGESPEED_API_KEY` (recommended), and optionally `GSC_SERVICE_ACCOUNT` and `BING_WEBMASTER_API_KEY`. `/seo-setup` explains how to get each.
- For the optional Claude fix routine: a claude.ai account with Claude Code cloud access, connected to GitHub with `/web-setup` in the terminal CLI.

## License

MIT, see [LICENSE](LICENSE). Made by [Md. Saiful Islam](https://github.com/saifulislam1431).

## Layout

```
.claude-plugin/plugin.json        plugin manifest
.claude-plugin/marketplace.json   marketplace with this one plugin
agents/seo.md                     the agent
skills/seo-setup/                 setup skill + templates (monitor.mjs, config, workflow, routine prompt)
skills/seo-schedule/              schedule skill
skills/seo-audit/                 on-demand audit skill
```

To release a change: edit the files, bump `version` in both manifests, commit and push. Projects that already use the monitor pick up a new `monitor.mjs` when someone re-runs `/seo-setup` in them.
