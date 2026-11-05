# Bench Diary

Bench Diary is a Claude Code plugin that keeps your research notes up to date as you work. Turn it on in a conversation, and Claude logs the notes, decisions, anecdotes and experiment ideas you mention into the right Markdown doc in your project, from the docs you choose, without asking first. Each time, it tells you in one line what it logged, with an undo, and it leaves out secrets and personal details. The plugin lives in [plugin/](plugin/); its README, [plugin/README.md](plugin/README.md), describes what it does, what it reads and writes, and how to try it.

## Install

```
/plugin install bench-diary --marketplace Ablation-Lab/bench-diary
```

Or copy `plugin/skills/bench-diary` into `~/.claude/skills/` to use it as a personal skill.

## Repository layout

| Path | What it is |
|---|---|
| `plugin/` | the plugin folder (Plugin path `plugin` in the directory portal) |
| `plugin/skills/bench-diary/` | the skill: `SKILL.md` and `scripts/diary.mjs` |
| `samples/` | a small made-up research project for reviewers (`bench-diary.json` and two docs) |
| `.claude-plugin/marketplace.json` | lets Claude Code install the plugin from this repo |
| `test/` | tests, run with `node --test` (not part of the plugin) |
| `scripts/privacy-check.sh`, `.githooks/` | the maintainer's pre-commit privacy check; the plugin never runs it |

Keep `plugin/README.md` and `SKILL.md` in step, and the versions in `plugin.json` and `marketplace.json` equal.

Bench Diary was renamed before release; see [The name](plugin/README.md#the-name) for its first name and why it changed.

MIT licence. An independent project, not made or endorsed by Anthropic.
