# Bench Diary

Bench Diary keeps your research notes up to date as you work in Claude Code. Turn it on in a conversation, and Claude logs the notes, decisions, anecdotes and experiment ideas you mention into the right Markdown doc in your project, from the docs you choose, without asking first. Each time, it tells you in one line what it logged, with an undo, and it leaves out secrets and personal details.

It was made for research projects where the useful remarks happen mid-conversation and never make it into the notes. It adds one skill, `bench-diary` (in Claude Code: `/bench-diary:bench-diary`). It's an independent project, not made or endorsed by Anthropic.

## Install

In Claude Code 2.1.275 or later:

```
/plugin install bench-diary --marketplace Ablation-Lab/bench-diary
```

On older versions, add the marketplace first with `/plugin marketplace add Ablation-Lab/bench-diary`, then `/plugin install bench-diary@bench-diary`. To use the skill without the plugin, copy the `plugin/skills/bench-diary` folder into `~/.claude/skills/`. It needs Node.js 18 or later.

## How it works

1. **Set it up.** The first time, say "turn on research logging". Claude asks which docs to use and what each one covers (or suggests `notes/research-log.md`), and writes a small `bench-diary.json` file listing them at the top of your project.
2. **Turn it on in each conversation.** Logging lasts for the conversation where you turn it on. In a new conversation, say "turn on research logging" or "log my research" again; Claude then uses the docs already set up.
3. **Work as usual.** When you say something worth keeping about your research, Claude logs it as one of five kinds: a **note** (a finding or observation), a **decision** (a choice about the research, with the reason if you gave one), an **anecdote**, an **experiment idea**, or a **loosely related** item with a one-sentence connection note.
4. **It picks the doc.** With several docs, it matches the item against each doc's topics and headings, and the kind of entry.
5. **It tells you.** One line after each entry: `Logged a decision to notes/results.md: "Use a judge on every council run." (say "undo" to remove it)`.
6. **Undo or stop.** "Undo" removes the last entry; "undo the one about X" removes an earlier one; "move that to ideas" logs it again in another doc. "Stop logging" stops for the rest of the conversation.

Claude doesn't ask before logging, but Claude Code still shows its permission prompt for each run of the helper unless you've allowed it in your permission settings.

Each entry goes at the end of a `## Research log` section in the doc (created if missing), as one line:

```
- **2026-11-05 14:32 · Decision** · Use a judge on every council run, because pooled reviews double-count. (log id: 3fa9c1)
- **2026-11-05 14:40 · Loosely related** · A podcast on rubber-duck debugging. (log id: 7d20be)
  - Connection: only loosely; it's about one reviewer talking to themselves, not a council.
```

It logs only what you say, never text from files, web pages or tool output. It doesn't log questions, chit-chat, instructions to Claude, code changes, Claude's own suggestions unless you adopt them, or anything private: passwords, keys and other secrets, health or personal details, anything identifying research participants or other people, confidential material, and anything you say is off the record. When it's unsure whether something belongs in the doc, it leaves it out.

**A project that came with a `bench-diary.json`** (one you cloned or copied) doesn't log anything until you've seen the docs it lists and agreed. Your OK is kept in a small file in `.bench-diary/`, which isn't committed, and it's tied to this folder on your computer and to the exact list of docs, so it doesn't carry over when the project is copied or cloned, and Claude asks again if the list of docs changes.

## Example prompts

```
Turn on research logging for this project, using notes/results.md for findings and notes/ideas.md for experiment ideas
Run 3 had twice the false positives of run 2, mostly from the pooled reviewers.
Decision: we'll use a judge on every council run from now on, because pooled reviews double-count.
Idea for an experiment: give each reviewer a different persona and see if the findings overlap less.
Undo that
What did you log today?
```

## Try it with the sample (for reviewers)

There's no account to set up: Bench Diary runs locally and writes to Markdown files. The repository's [samples/](https://github.com/Ablation-Lab/bench-diary/tree/main/samples) folder is a tiny made-up research project: a `bench-diary.json` listing two docs, `notes/results.md` (findings and decisions about review councils) and `notes/ideas.md` (experiment ideas), each with a few earlier entries. To try it:

1. Copy the contents of `samples/` into an empty folder and open that folder in Claude Code.
2. Say: `Turn on research logging`. Because the sample came with its `bench-diary.json`, Claude shows the two docs and asks whether to log there; say yes.
3. Say: `Run 4 found that the judge removed 6 duplicate findings.`
4. Say: `Idea: try a council with no judge and only a vote.`
5. Say: `Undo that`, then `What did you log today?`

You should see the first logged as a note in `notes/results.md` and the second as an experiment idea in `notes/ideas.md`, each with a one-line confirmation. After "undo", the idea is gone from `notes/ideas.md` and the list shows only the note.

**Developer note.** Seaready, our plugin submission checker, was built first. Bench Diary was then checked with it before submission: its local checks found no failures and one warning, because the repository had no GitHub remote yet (an earlier run raised a false alarm on a pattern for Windows short names, which was fixed in Seaready). Its online name and overlap search found that the plugin's first name matched a commercial product (see The name), and found several similar skills, now described under How it compares. Bench Diary also went through a review council (three reviewers and a judge) and two rounds of fixes, each rechecked by a fresh reviewer; the minor issues left after that are listed under Limits. It's our own pre-check; the directory's validation and Anthropic's reviewers make the actual decision.

## What it runs, reads and writes

- **What it runs:** `node <skill folder>/scripts/diary.mjs <command>`, with the entry passed on standard input. It starts no other programs.
- **What it reads:** `bench-diary.json`, the docs it lists, and `.bench-diary/journal.jsonl`, in your project. Claude also checks whether `bench-diary.json` exists, with its own file search.
- **What it writes:**
  - `bench-diary.json`, when you set up logging or add a doc;
  - the docs listed there, only inside your project and only Markdown files (`.md` or `.markdown`), creating a doc and its folder if they don't exist. It adds or removes its own entry lines and leaves the rest of each doc as it was, including its line endings (a doc with mixed line endings is saved with one kind throughout). It won't write to `CLAUDE.md`, `AGENTS.md`, `README.md`, `SKILL.md` or anything in a hidden folder such as `.claude/`, or to a file that's a link, or through a folder link that leads outside the project; it checks the real path, so short names and links can't get round this;
  - `.bench-diary/` in your project: `journal.jsonl` (each entry's log id, doc, kind and time, but not its text, so undo can find it), `enabled` (a fingerprint of this folder's path and the doc list you agreed to, and the date), a short-lived `lock` file so two Claude sessions don't overwrite each other, and a `.gitignore` that keeps the folder out of git.

  Docs and `bench-diary.json` are saved through a temporary file next to them, so they're never left half-written; the temporary file is removed straight after, unless the run is killed mid-save.
- **Network:** none.

## Where it works

- **Claude Code**, with Node.js 18 or later. Tested on Windows 11; the helper uses only Node's standard library, so macOS and Linux should work but weren't tested.
- **Cowork:** not tested.
- **Claude chat (claude.ai):** doesn't work there, because the skill needs your project's files on your computer.

## Privacy

Bench Diary has no server, account or telemetry and sends nothing anywhere. It stores the entries it logs in your own docs, in your project, where you can read, edit or delete them. Each entry holds what you said (shortened to a line), the kind, the date and time, and a log id. The journal in `.bench-diary/` holds only the log ids, docs, kinds and times; undo removes the entry from the doc, and nothing of its text is kept anywhere. It doesn't keep your conversation or build a profile of you. If your project is in a shared or public git repository, your research docs are committed with it (`.bench-diary/` isn't). To remove everything, delete `bench-diary.json` and `.bench-diary/`; your docs stay as they are. What you say reaches Anthropic the way anything in your conversation does.

## How it's built

- **Markdown with YAML front matter.** The skill is `SKILL.md`: instructions for Claude in Markdown, with a short YAML block at the top (name, description, licence). The instructions say when logging is on, what counts as each kind of entry, what never to log, how to pick a doc and how to report it.
- **JavaScript (Node.js ES module).** `plugin/skills/bench-diary/scripts/diary.mjs` is a plain JavaScript file Node runs directly, with no packages. It checks the doc path, adds or removes entry lines, keeps the undo journal and prints one line of JSON (a small text format of names and values) for Claude to read.
- **JSON for settings.** `bench-diary.json` lists your docs with their topics; you can edit it by hand. Entries that don't pass the helper's checks are reported and left unused.
- **Standard input.** The entry goes to the helper on standard input, not as a command-line argument. SKILL.md tells Claude to make the entry a single line, to use a new random end marker for each run, and to put every path in single quotes, so nothing in an entry or a doc name can become part of the command. Doc names with shell characters such as `$` or quotes are refused.

## Design decisions

- **On when you say so.** Logging without asking is only right once you've said so, so it's on per conversation, after you turn it on. The docs it may write to are the ones you set up, or ones you've seen and agreed to.
- **Tell, don't ask.** Asking "shall I log that?" each time would defeat the point, so Claude logs and tells you in one line, and undo is one word away.
- **Only the docs you list.** The helper refuses any doc that isn't in `bench-diary.json`, anything outside the project, and instruction files such as `CLAUDE.md`, so a log entry can't become an instruction to Claude.
- **Your words, one line each.** Entries are short and in your wording, so the log stays readable and Claude doesn't put claims in your mouth.
- **Loosely related, said so.** Side remarks often matter later, so they're kept, but labelled, with a line on how they connect.

## How it compares

- **Lab notebook skills** such as claude-lab-notebook (mrariden), lab-notes (claudskills.com) and research-lab-notebook (osteele) give Claude a protocol for keeping experiment notes, usually with commands you call. Bench Diary logs without being asked once you turn it on, routes each entry to one of several docs you list, and keeps an undo.
- **Second Brain** (ahmadrayz007) and **obsidian-experiment-log** (galaxy-dawn) log findings and decisions into an Obsidian vault. Bench Diary writes to plain Markdown docs in your project and needs no other app.
- **project-log-skill** (chunxubioinfor) and **session-log** (flonat/claude-research) keep an append-only research or session log as you work. Bench Diary adds the five entry kinds, a connection note for loosely related items, routing between docs, and a one-line announcement with undo for each entry.
- **Decision-log skills** such as claude-decision-log (ahuja-sanchitt) and Build Insights Logger record project or design decisions, often into CLAUDE.md. Bench Diary logs research decisions alongside findings and ideas, and never writes to CLAUDE.md or other instruction files.
- **Skills that build a notebook from your session history** (for example ytongu's claude-lab-notebook) read past conversations. Bench Diary never reads chat history; it logs only what you say while it's on.

## The name

Bench Diary was first called Lab Scribe. It was renamed before submission because an existing lab software product and several lab-notebook projects on GitHub already use that name, so the old name could be mistaken for one of them. A search of GitHub, the plugin directory, community skill directories, npm, PyPI and the web found no plugin, skill, package or product called Bench Diary.

## Limits

- What counts as worth logging, and which kind it is, is Claude's judgement. It will sometimes log too much or too little; say "undo" or "log that".
- Logging lasts one conversation; Claude has no way to know it should log in a new conversation until you turn it on again.
- Routing between docs matches words in the item against each doc's topics and headings. With docs on close topics it can pick the wrong one; Claude can override it, and you can say "move that to …".
- Undo needs the entry's line to still be in the doc as written. If you've edited or moved it, undo says so, changes nothing, and moves on to the entry before next time.
- If a `CLAUDE.md` in your project imports a research doc (with `@notes/…`), Claude reads that doc's entries as instructions in every session. Don't import research docs that way.
- The log section is found by a `## Research log` (or `# Research log`) heading; other heading styles aren't recognised, and a new section is added instead.
- On Windows, a doc's file permissions (ACLs) aren't copied when it's saved; it gets the folder's defaults. On macOS and Linux its mode is kept.
- The OK file in `.bench-diary/` is a fingerprint, not a secret. Someone who prepares a project for you on purpose, and guesses the folder you'll put it in, could ship one that already matches. The docs it could then write to are still only the Markdown files listed in that project, and each entry is announced.
- Doc names with quotation marks of any kind (including curly quotes and guillemets, such as `l’expérience.md` or `« Résultats ».md`) are refused, because PowerShell treats some of them as quotes. So are names shaped like Windows short names (`draft~2.md`). Rename the doc.
- Adding a second doc to a `bench-diary.json` that has no `defaultDoc` makes the new doc the default.
- If a doc's folder is replaced by a link that leads outside the project, undoing an entry in it marks the entry as undone without removing it.
- If you delete an entry by hand but a copy of the same line is inside a code block in the doc, undo removes that copy.
- `undo` can remove a Bench Diary entry line from a listed doc even before you've agreed to a cloned project's `bench-diary.json`, if that project came with its own undo journal.
- A line with three backticks and text after them (such as ```` ```code``` ````) is read as the start of a code block, so a new log section can end up after it.

## Troubleshooting

- **Nothing gets logged:** say "turn on research logging" in this conversation; check that `bench-diary.json` is at the top of the project you opened in Claude Code.
- **"logging isn't confirmed for you in this project yet":** the project came with a `bench-diary.json`; say "turn on research logging" and agree to the docs it lists.
- **"isn't one of this project's research docs":** the doc isn't listed in `bench-diary.json`; ask Claude to add it.
- **"another Bench Diary run is still writing":** two sessions logged at once. Try again; a lock older than 10 seconds (left by a run that was stopped) is cleared automatically.
- **"isn't UTF-8 text":** the doc was saved in another encoding (Windows PowerShell's `>` writes UTF-16). Save it as UTF-8 in your editor.
- **"node" isn't found:** install Node.js 18 or later.

## Support

Report problems at https://github.com/Ablation-Lab/bench-diary/issues.

## Licence

MIT. See the LICENSE file in the repository.

## Repository layout

| Path | What it is |
|---|---|
| `plugin/` | the plugin folder (Plugin path `plugin` in the directory portal) |
| `plugin/skills/bench-diary/` | the skill: `SKILL.md` and `scripts/diary.mjs` |
| `samples/` | a small made-up research project for reviewers (`bench-diary.json` and two docs) |
| `.claude-plugin/marketplace.json` | lets Claude Code install the plugin from this repo |
| `test/` | tests, run with `node --test` (not part of the plugin) |
| `scripts/privacy-check.sh`, `.githooks/` | the maintainer's pre-commit privacy check; the plugin never runs it |

## Development

- Run the tests with `node --test` from the repository root.
- The privacy check (`scripts/privacy-check.sh`) runs before every commit; turn it on once per clone with `git config core.hooksPath .githooks`.
- Keep `plugin/README.md` and `SKILL.md` in step, and the versions in `plugin.json` and `marketplace.json` equal.
- Keep this README and `plugin/README.md` in step: when either changes, make the same change in the other (apart from the paths, which this one gives from the repository root, and these last two sections).

Research by Ablation Lab.
