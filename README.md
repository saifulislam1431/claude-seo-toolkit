# SEO toolkit for Claude Code

An SEO and performance agent, plus scheduled monitoring for any live website:

- **`seo` agent**: audits and fixes SEO and performance issues (Lighthouse, Core Web Vitals, metadata, sitemap, structured data, Search Console and Bing setup).
- **`/seo-setup`**: installs monitoring in the current project. It adds `.seo/` (a zero-dependency monitor), a GitHub Actions workflow and an IndexNow key file.
- **`/seo-schedule`**: shows or changes the interval (weekly, 10days, 15days, monthly), or pauses it.
- **`/seo-audit [fix]`**: measures the live site now and has the agent explain or fix what it finds.

Full guide (how it works, keys, routine setup, troubleshooting): ask the toolkit's maintainer for the "SEO & Performance Agent — Developer Guide" doc.

## Install as a plugin (recommended)

In Claude Code (CLI or VS Code extension), replace `OWNER/REPO` with this repo's path on GitHub:

```
/plugin marketplace add OWNER/REPO
/plugin install seo-toolkit@jurnyon-tools
```

Restart Claude Code. As a plugin the commands are namespaced: `/seo-toolkit:seo-setup`, `/seo-toolkit:seo-schedule`, `/seo-toolkit:seo-audit`, and the agent is `seo-toolkit:seo`. You can also just ask, for example "set up SEO monitoring for this project".

Get updates with `/plugin marketplace update jurnyon-tools`, then restart. If the repo is private, your GitHub credentials (`gh auth login`) must be able to read it.

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
