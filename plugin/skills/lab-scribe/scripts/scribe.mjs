#!/usr/bin/env node
// Lab Scribe helper: appends research-log entries to the Markdown docs a project lists in
// lab-scribe.json, and undoes them.
//
//   node scribe.mjs init   --doc <path> [--topics "a, b"] [--description "..."] [--project <dir>]
//   node scribe.mjs enable [--project <dir>]     (confirm a lab-scribe.json this user didn't create)
//   node scribe.mjs docs   [--project <dir>]
//   node scribe.mjs route  [--kind <kind>] [--project <dir>]           (the item on stdin)
//   node scribe.mjs add    --doc <path> --kind <kind> [--project <dir>] (entry on stdin; a line
//                          starting "Connection:" becomes the connection note)
//   node scribe.mjs undo   [--id <log id>] [--project <dir>]
//   node scribe.mjs recent [--n 10] [--project <dir>]
//
// It writes only: lab-scribe.json; the docs listed in it (inside the project, Markdown only); and
// the folder .lab-scribe/ (enabled, journal.jsonl, lock, .gitignore). The docs and lab-scribe.json
// are saved through a temporary file and a rename. It reads nothing else and makes no network
// requests. Output is one line of JSON.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const KINDS = ['note', 'decision', 'anecdote', 'idea', 'related'];
const LABEL = { note: 'Note', decision: 'Decision', anecdote: 'Anecdote', idea: 'Experiment idea', related: 'Loosely related' };
const LOG_HEADING = '## Research log';
const CONFIG = 'lab-scribe.json';
const STATE = '.lab-scribe';
const COMMANDS = ['init', 'enable', 'docs', 'route', 'add', 'undo', 'recent'];

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const o = { cmd, doc: null, kind: null, topics: null, description: null, project: null, id: null, n: 10 };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = () => { const v = rest[++i]; if (v == null) throw new Error(`${a} needs a value`); return v; };
    if (a === '--doc') o.doc = val();
    else if (a === '--kind') o.kind = val();
    else if (a === '--topics') o.topics = val();
    else if (a === '--description') o.description = val();
    else if (a === '--project') o.project = val();
    else if (a === '--id') o.id = val();
    else if (a === '--n') o.n = Number(val());
    else throw new Error(`unknown option ${a}`);
  }
  if (!COMMANDS.includes(cmd)) throw new Error(`unknown command "${cmd ?? ''}"; use ${COMMANDS.join(', ')}`);
  if (o.kind != null && !KINDS.includes(o.kind)) throw new Error(`--kind must be one of ${KINDS.join(', ')}`);
  if (!Number.isInteger(o.n) || o.n < 1 || o.n > 200) throw new Error('--n must be a whole number from 1 to 200');
  if (o.id != null && !/^[0-9a-f]{6}$/.test(o.id)) throw new Error('--id is the six-character log id shown after an entry, such as 3fa9c1');
  return o;
}

// Built from code points so the source holds no invisible characters.
const cp = n => String.fromCodePoint(n);
// Bidi embeddings, overrides and isolates (they can make text read differently from how it's
// stored), zero-width spaces and word joiners, soft hyphens, invisible operators and fillers (used to
// hide text). The joiners emoji and many scripts need (U+200C, U+200D) and LRM/RLM (needed by
// right-to-left text) are kept.
const HIDDEN = new RegExp(`[${cp(0x202a)}-${cp(0x202e)}${cp(0x2066)}-${cp(0x2069)}${cp(0x200b)}${cp(0x2060)}-${cp(0x2064)}${cp(0x206a)}-${cp(0x206f)}${cp(0xfeff)}${cp(0xad)}${cp(0x180e)}${cp(0x3164)}${cp(0xfff9)}-${cp(0xfffb)}]`, 'gu');
// Tag characters, except inside a subdivision flag (a black flag, tag letters, then a cancel tag).
const TAGS = new RegExp(`(${cp(0x1f3f4)}[${cp(0xe0020)}-${cp(0xe007e)}]+${cp(0xe007f)})|[${cp(0xe0000)}-${cp(0xe007f)}]`, 'gu');
// Runs of variation selectors: one after a character is normal, more are a way to hide data.
const VS = `${cp(0xfe00)}-${cp(0xfe0f)}${cp(0xe0100)}-${cp(0xe01ef)}`;
const VS_RUN = new RegExp(`([${VS}])[${VS}]+`, 'gu');

// One line, capped by characters (not UTF-16 units, so emoji aren't split). Entries always sit after
// a "- **date · Kind** · " prefix, so text starting with "-" or "#" can't turn into Markdown structure.
export function clean(text, max = 600) {
  const t = String(text ?? '')
    .replace(/[\r\n\t\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\p{Cc}/gu, '') // control characters, such as terminal colour codes
    .replace(HIDDEN, '')
    .replace(TAGS, (m, flag) => flag || '')
    .replace(VS_RUN, '$1')
    // Shown as text, not rendered: no HTML tags, and no images a Markdown viewer would fetch.
    .replace(/<(?=[A-Za-z!/?])/g, '&lt;').replace(/!\[/g, '!\\[')
    // A log id belongs only at the end of an entry line, where undo looks for it.
    .replace(/\(log id: ([0-9a-f]{6})\)/gi, '(log id $1)')
    .replace(/\s{2,}/g, ' ').trim();
  const chars = Array.from(t);
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : t;
}

// Splits stdin into the entry and an optional "Connection:" note.
export function splitEntry(input) {
  const lines = String(input ?? '').replace(/\r\n/g, '\n').split('\n');
  const k = lines.findIndex(l => /^\s*connection\s*:/i.test(l));
  if (k < 0) return { text: clean(lines.join(' ')), connection: '' };
  return { text: clean(lines.slice(0, k).join(' ')), connection: clean([lines[k].replace(/^\s*connection\s*:\s*/i, ''), ...lines.slice(k + 1)].join(' '), 400) };
}

// Files that instruct Claude or other tools are never research docs.
const INSTRUCTION_FILES = ['claude.md', 'claude.local.md', 'agents.md', 'gemini.md', 'skill.md', 'readme.md'];
// Characters that mean something to a shell, so a doc name can always be quoted safely. PowerShell
// also treats curly quotes (U+2018 to U+201B) as single quotes and U+201C to U+201E as double ones,
// so every quotation mark (\p{Pi}, \p{Pf} and the low ones U+201A, U+201E) is refused too.
const SHELL_CHARS = new RegExp(`[$\`'"\\\\;&|<>*?%!{}\\0\\p{Pi}\\p{Pf}${cp(0x201a)}${cp(0x201e)}]`, 'u');
// A Windows 8.3 short name: up to six characters, ~ and a number, and up to three after a dot.
const SHORT_NAME = /^[^.\s]{1,6}~\d{1,6}(\.[^.\s]{0,3})?$/i;

function refuseGuarded(parts, rel) {
  if (parts.some(p => p.startsWith('.') && p !== '.') || INSTRUCTION_FILES.includes(parts[parts.length - 1]))
    throw new Error(`${clean(rel, 120)} is an instruction or project file (or in a hidden folder), not a research doc; pick a doc of your own, such as notes/research-log.md`);
}
const inside = (root, p) => { const r = path.relative(root, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const realNative = p => (fs.realpathSync.native || fs.realpathSync)(p);

// A doc path from the config or the user: relative, inside the project, Markdown, a plain name.
export function resolveDoc(project, rel) {
  const r = String(rel ?? '').replace(/\\/g, '/').trim();
  if (!r) throw new Error('give the doc with --doc');
  if (/^(\/|[A-Za-z]:)/.test(r) || r.includes(':') || r.split('/').includes('..')) throw new Error(`doc paths must stay inside the project: ${clean(rel, 120)}`);
  // Joiners (U+200C, U+200D) are allowed: Persian and Indic names and emoji need them.
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(r) || [...r].some(c => /\p{Cf}/u.test(c) && c !== cp(0x200c) && c !== cp(0x200d)) || new RegExp(HIDDEN.source, 'u').test(r)) throw new Error('doc names can\'t contain control or invisible characters');
  if (SHELL_CHARS.test(r)) throw new Error(`doc names can't contain $ \` ' " ; & | < > * ? % ! { } or backslashes: ${clean(rel, 120)}`);
  // Windows short names (CLAUDE~1) could reach a guarded file under another spelling.
  if (r.split('/').some(p => SHORT_NAME.test(p))) throw new Error(`use the doc's full name, not a short name like NOTES~1: ${clean(rel, 120)}`);
  if (!/\.(md|markdown)$/i.test(r)) throw new Error(`docs must be Markdown files (.md): ${clean(rel, 120)}`);
  refuseGuarded(r.toLowerCase().split('/'), rel);
  const abs = path.resolve(project, r);
  if (!inside(path.resolve(project), abs) || abs === path.resolve(project)) throw new Error(`doc paths must stay inside the project: ${clean(rel, 120)}`);
  // Check the real path too: a linked folder could lead outside the project or into a guarded folder.
  if (!fs.existsSync(project)) throw new Error(`the project folder doesn't exist: ${clean(project, 120)}`);
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const realProject = realNative(project);
  const realDir = realNative(dir);
  if (!inside(realProject, realDir)) throw new Error(`doc paths must stay inside the project (a linked folder leads outside it): ${clean(rel, 120)}`);
  let realFile = path.join(realDir, path.relative(dir, abs));
  try { if (!fs.lstatSync(abs).isSymbolicLink()) realFile = realNative(abs); } catch { /* a new doc */ }
  refuseGuarded(path.relative(realProject, realFile).toLowerCase().split(/[\\/]+/), rel);
  return { rel: path.posix.normalize(r), abs };
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The .lab-scribe folder, refusing links so nothing in it can be redirected outside the project.
function stateDir(project, create) {
  const dir = path.join(project, STATE);
  let st = null;
  try { st = fs.lstatSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error(`${STATE} is a link or not a folder; Lab Scribe won't use it`);
  if (!st) { if (!create) return null; fs.mkdirSync(dir); }
  if (!inside(realNative(project), realNative(dir))) throw new Error(`${STATE} leads outside the project; Lab Scribe won't use it`);
  for (const f of ['.gitignore', 'journal.jsonl', 'lock', 'enabled']) {
    try { if (fs.lstatSync(path.join(dir, f)).isSymbolicLink()) throw new Error(`${STATE}/${f} is a link; Lab Scribe won't use it`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  // The journal holds log ids; keep the folder out of git.
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n', { flag: 'wx' });
  return dir;
}

// One run at a time per project: two Claude sessions logging at once must not lose an entry.
export function withLock(project, fn) {
  const lock = path.join(stateDir(project, true), 'lock');
  const token = crypto.randomBytes(8).toString('hex');
  const until = Date.now() + 12000;
  for (;;) {
    try { fs.writeFileSync(lock, token, { flag: 'wx' }); break; } catch (e) {
      // EPERM/EACCES: on Windows, a lock that is being deleted can't be created for a moment.
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(e.code)) throw e;
      try {
        if (e.code === 'EEXIST' && Date.now() - fs.statSync(lock).mtimeMs > 10000) {
          // Move a stale lock aside under a unique name first, so two runs can't both remove it.
          const aside = `${lock}.stale-${token}`;
          fs.renameSync(lock, aside); fs.rmSync(aside, { force: true });
          continue;
        }
      } catch { /* someone else moved it */ }
      if (Date.now() > until) throw new Error(e.code === 'EEXIST' ? 'another Lab Scribe run is still writing (its lock is .lab-scribe/lock); try again in a moment' : `can't create .lab-scribe/lock (${e.code}); check the folder isn't read-only`);
      sleep(50);
    }
  }
  try { return fn(); } finally {
    try { if (fs.readFileSync(lock, 'utf8') === token) fs.rmSync(lock, { force: true }); } catch { /* already gone */ }
  }
}

const BOM = String.fromCharCode(0xfeff);
const decode = (buf, what) => {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); } catch { throw new Error(`${what} isn't UTF-8 text; save it as UTF-8 first`); }
};

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = null;
  try { const st = fs.lstatSync(file); if (st.isSymbolicLink()) throw new Error(`${path.basename(file)} is a link; Lab Scribe won't write through it`); mode = st.mode & 0o7777; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx' });
    if (mode != null && process.platform !== 'win32') fs.chmodSync(tmp, mode);
    // Windows refuses a rename while another program (an editor, a sync tool) has the file open.
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, file); break; } catch (e) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= 10) throw new Error(`couldn't save ${path.basename(file)} (${e.code}); is it open somewhere that locks it?`);
        sleep(100);
      }
    }
  } finally { fs.rmSync(tmp, { force: true }); }
}

// Keeps a file's own line endings.
const eolOf = text => (/\r\n/.test(text) ? '\r\n' : '\n');

// The config, with every doc path checked. Entries that fail are left out and reported, never used.
export function loadConfig(project) {
  const file = path.join(project, CONFIG);
  let raw;
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${CONFIG} is a link or not a file; Lab Scribe won't use it`);
    raw = decode(fs.readFileSync(file), CONFIG).replace(new RegExp('^' + BOM), '');
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { throw new Error(`${CONFIG} is not valid JSON (${clean(e.message, 80)})`); }
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.docs)) throw new Error(`${CONFIG} needs a "docs" list`);
  const docs = [], invalid = [];
  for (const d of cfg.docs) {
    const p = d && typeof d === 'object' ? d.path : d;
    try {
      const { rel } = resolveDoc(project, typeof p === 'string' ? p : '');
      if (docs.some(x => x.path === rel)) continue;
      docs.push({
        path: rel,
        topics: Array.isArray(d?.topics) ? d.topics.filter(t => typeof t === 'string').map(t => clean(t, 60)).filter(Boolean).slice(0, 40) : [],
        description: typeof d?.description === 'string' ? clean(d.description, 200) : '',
      });
    } catch (e) { invalid.push({ path: clean(typeof p === 'string' ? p : JSON.stringify(p), 120), problem: e.message }); }
  }
  let defaultDoc = null;
  try { if (typeof cfg.defaultDoc === 'string') { const { rel } = resolveDoc(project, cfg.defaultDoc); if (docs.some(x => x.path === rel)) defaultDoc = rel; } } catch { /* ignored */ }
  return { docs, invalid, defaultDoc: defaultDoc || docs[0]?.path || null };
}

// Lower-case words of three letters or more, without a plural "s", so "councils" matches "council".
const stem = w => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const words = s => new Set((String(s).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) || []).filter(w => !STOP.has(w)).map(stem));
const STOP = new Set('the and for with that this from into about over have has was were are not but you your our its their them they then than when what which will would could should also just more most some such only very each other here there being been out how why who use used using can may might must research log'.split(' '));
// Words in a doc's topics that suit each kind of entry.
const KIND_WORDS = { note: ['finding', 'result', 'observation', 'note'], decision: ['decision', 'choice'], anecdote: ['anecdote', 'story', 'stories'], idea: ['idea', 'experiment', 'plan', 'try'], related: ['related', 'misc', 'reading'] };

// Ranks the configured docs for an item, by shared words with each doc's topics, description and
// headings, plus a bonus when a doc's topics suit the entry's kind (which also breaks ties).
export function route(project, cfg, input, kind = null) {
  const item = words(input);
  const scored = cfg.docs.map(d => {
    let headings = '';
    try { const { rel, abs } = resolveDoc(project, d.path); headings = (readDoc(abs, rel) || '').split('\n').filter(l => /^#{1,4}\s/.test(l)).slice(0, 80).join(' '); } catch { /* missing or refused doc: route on topics only */ }
    const topicWords = words([...d.topics, d.description].join(' '));
    const headingWords = words(headings);
    const matched = [...item].filter(w => topicWords.has(w) || headingWords.has(w));
    const kindMatch = !!kind && (KIND_WORDS[kind] || []).some(w => topicWords.has(stem(w)));
    const score = [...item].reduce((s, w) => s + (topicWords.has(w) ? 2 : 0) + (headingWords.has(w) ? 1 : 0), 0) + (kindMatch ? 3 : 0);
    return { doc: d.path, score, kindMatch, matched };
  }).sort((a, b) => b.score - a.score || Number(b.kindMatch) - Number(a.kindMatch));
  return { ranked: scored, best: scored[0]?.score > 0 ? scored[0].doc : cfg.defaultDoc };
}

// Local date and time, both from the same clock.
const pad = n => String(n).padStart(2, '0');
export const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Which lines are inside fenced code blocks, so a "#" line or a "## Research log" example in code
// isn't taken for a heading. An unclosed fence runs to the end of the doc, as Markdown renders it.
function fencedLines(lines) {
  const inFence = new Array(lines.length).fill(false);
  let mark = null;
  lines.forEach((l, i) => {
    const m = l.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (mark) { inFence[i] = true; if (m && m[1][0] === mark[0] && m[1].length >= mark.length && /^\s{0,3}[`~]+\s*$/.test(l)) mark = null; }
    else if (m) { inFence[i] = true; mark = m[1]; }
  });
  inFence.openMark = mark; // the fence still open at the end of the doc, if any
  return inFence;
}

// Inserts entry lines at the end of the "## Research log" section, creating it at the end of the doc.
export function insertEntry(docText, entryLines) {
  const eol = eolOf(docText);
  const lines = docText.replace(/\r\n/g, '\n').split('\n');
  const fenced = fencedLines(lines);
  const isLogHeading = l => /^#{1,2}\s+research log\s*#*\s*$/i.test(l.trim());
  const start = lines.findIndex((l, i) => !fenced[i] && isLogHeading(l));
  if (start < 0) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    // If the doc ends inside an unclosed code fence, close it so the new section isn't swallowed.
    if (fenced.openMark) lines.push(fenced.openMark);
    if (lines.length) lines.push('');
    lines.push(LOG_HEADING, '', ...entryLines, '');
    return lines.join(eol);
  }
  const level = lines[start].trim().match(/^#+/)[0].length;
  let end = start + 1;
  while (end < lines.length && !(!fenced[end] && new RegExp(`^#{1,${level}}\\s`).test(lines[end]))) end++;
  let at = end;
  while (at > start + 1 && lines[at - 1] === '') at--;
  const prefix = at === start + 1 ? [''] : [];
  // Keep a blank line before the next heading, and the file's final newline.
  const suffix = at < lines.length && lines[at] !== '' ? [''] : [];
  lines.splice(at, 0, ...prefix, ...entryLines, ...suffix);
  if (lines[lines.length - 1] !== '') lines.push('');
  return lines.join(eol);
}

const isEntryLine = (l, id) => l.startsWith('- **') && l.endsWith(`(log id: ${id})`);

// Removes an entry (and its Connection line) and the blank line it may leave between two others.
export function removeEntry(docText, id) {
  const eol = eolOf(docText);
  const lines = docText.replace(/\r\n/g, '\n').split('\n');
  const fenced = fencedLines(lines);
  // Entry lines are distinctive, so if none is found outside code (an unclosed fence above it, say),
  // take the one inside.
  let k = lines.findIndex((l, i) => !fenced[i] && isEntryLine(l, id));
  if (k < 0) k = lines.findIndex(l => isEntryLine(l, id));
  if (k < 0) return null;
  const count = lines[k + 1] != null && /^ {2}- Connection: /.test(lines[k + 1]) ? 2 : 1;
  lines.splice(k, count);
  // add put a blank line before a following heading; take it back out if the section is now empty.
  if (lines[k - 1] === '' && lines[k] === '' && k - 2 >= 0 && /^#{1,2}\s+research log/i.test(lines[k - 2].trim())) lines.splice(k, 1);
  return lines.join(eol);
}

// Reads a research doc, refusing files Lab Scribe would damage or shouldn't touch.
export function readDoc(abs, rel) {
  let st;
  try { st = fs.lstatSync(abs); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${rel} is a link or not an ordinary file; Lab Scribe won't write to it`);
  if (st.nlink > 1) throw new Error(`${rel} has other hard links; Lab Scribe won't write to it`);
  const buf = fs.readFileSync(abs);
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff) || buf.includes(0)) throw new Error(`${rel} isn't UTF-8 text (it looks like UTF-16); save it as UTF-8 first`);
  return decode(buf, rel);
}

// The journal: one row per entry with its id, doc, kind and time (never the text), and one per undo.
function readJournal(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && typeof r === 'object' && ((/^[0-9a-f]{6}$/.test(r.id) && typeof r.doc === 'string' && KINDS.includes(r.kind)) || /^[0-9a-f]{6}$/.test(r.undo)));
}

// The user's OK for this project: tied to the project's real path and to the exact list of docs, so
// a marker copied in with the project, or a config that later lists other docs, doesn't count.
const enabledFile = project => path.join(project, STATE, 'enabled');
const consentKey = (project, cfg) => crypto.createHash('sha256').update(JSON.stringify([realNative(project), cfg.docs.map(d => d.path).sort()])).digest('hex');
const isEnabled = (project, cfg) => {
  try {
    if (!fs.lstatSync(enabledFile(project)).isFile()) return false;
    return fs.readFileSync(enabledFile(project), 'utf8').split('\n').some(l => l.trim() === consentKey(project, cfg));
  } catch { return false; }
};
const markEnabled = (project, cfg, now) => fs.writeFileSync(enabledFile(project), `${consentKey(project, cfg)}\n${now.toISOString()}\n`);

// The config as written, for init to change one entry and keep everything else (other keys, other
// entries, even ones Lab Scribe refuses to use).
function rawConfig(project) {
  const file = path.join(project, CONFIG);
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${CONFIG} is a link or not a file; Lab Scribe won't use it`);
    const v = JSON.parse(decode(fs.readFileSync(file), CONFIG).replace(new RegExp('^' + BOM), ''));
    if (!v || typeof v !== 'object' || Array.isArray(v) || !Array.isArray(v.docs)) throw new Error(`${CONFIG} needs a "docs" list`);
    return v;
  } catch (e) { if (e.code === 'ENOENT') return null; if (e instanceof SyntaxError) throw new Error(`${CONFIG} is not valid JSON (${clean(e.message, 80)})`); throw e; }
}

export function runCommand(o, input, now = new Date()) {
  const project = path.resolve(o.project || process.cwd());
  const cfgFile = path.join(project, CONFIG);
  const journal = path.join(project, STATE, 'journal.jsonl');
  const off = `No ${CONFIG} in this project, so research logging is off here.`;
  switch (o.cmd) {
    case 'init': {
      const { rel, abs } = resolveDoc(project, o.doc);
      const topics = o.topics ? o.topics.split(',').map(s => clean(s, 60)).filter(Boolean) : [];
      return withLock(project, () => {
        // Read the config inside the lock, so two inits at once both keep their doc.
        const before = loadConfig(project);
        // A config that came with the project must be confirmed first, or init would quietly
        // approve every doc it lists.
        if (before && before.docs.length && !isEnabled(project, before)) throw new Error(`this project came with a ${CONFIG} listing ${before.docs.map(d => d.path).join(', ')}; ask the user about those docs and run enable before adding one`);
        const raw = rawConfig(project) || { docs: [] };
        const k = raw.docs.findIndex(d => { try { return resolveDoc(project, d && typeof d === 'object' ? d.path : d).rel === rel; } catch { return false; } });
        const entry = k >= 0 && raw.docs[k] && typeof raw.docs[k] === 'object' ? raw.docs[k] : { path: rel, topics: [], description: '' };
        if (topics.length) entry.topics = topics;
        if (o.description) entry.description = clean(o.description, 200);
        if (k >= 0) raw.docs[k] = entry; else raw.docs.push(entry);
        if (typeof raw.defaultDoc !== 'string') raw.defaultDoc = rel;
        const docText = readDoc(abs, rel);
        writeAtomic(cfgFile, JSON.stringify(raw, null, 2) + '\n');
        if (docText == null) writeAtomic(abs, `# ${path.basename(rel).replace(/\.(md|markdown)$/i, '')}\n\n${LOG_HEADING}\n`);
        const after = loadConfig(project);
        markEnabled(project, after, now);
        return { config: CONFIG, docs: after.docs.map(d => d.path), created: docText == null ? rel : null, message: `Research logging is set up for ${rel}.` };
      });
    }
    case 'enable': {
      const cfg = loadConfig(project);
      if (!cfg) throw new Error(off);
      if (!cfg.docs.length) throw new Error(`${CONFIG} lists no usable docs`);
      return withLock(project, () => {
        markEnabled(project, cfg, now);
        return { enabled: true, docs: cfg.docs.map(d => d.path), message: `Research logging is on here for ${cfg.docs.map(d => d.path).join(', ')}.` };
      });
    }
    case 'docs': {
      const cfg = loadConfig(project);
      if (!cfg) return { active: false, message: off };
      return { active: true, setUpHere: isEnabled(project, cfg), docs: cfg.docs, defaultDoc: cfg.defaultDoc, invalid: cfg.invalid };
    }
    case 'route': {
      const cfg = loadConfig(project);
      if (!cfg) return { active: false, message: off };
      return { active: true, ...route(project, cfg, input, o.kind) };
    }
    case 'add': {
      if (!o.kind) throw new Error(`give --kind (${KINDS.join(', ')})`);
      const { text, connection } = splitEntry(input);
      if (!text) throw new Error('give the entry on stdin');
      if (o.kind === 'related' && !connection) throw new Error('a loosely related item needs a "Connection:" line saying how it does or doesn\'t connect');
      if (!fs.existsSync(cfgFile)) throw new Error(`research logging is off here: no ${CONFIG} (run init first)`);
      return withLock(project, () => {
        const cfg = loadConfig(project);
        if (!cfg) throw new Error(`research logging is off here: no ${CONFIG} (run init first)`);
        // A lab-scribe.json that came with the project (a clone, a copy) needs this user's OK first.
        if (!isEnabled(project, cfg)) throw new Error(`logging isn't confirmed for you in this project yet: ${CONFIG} lists ${cfg.docs.map(d => d.path).join(', ') || 'no usable docs'}; ask the user, then run enable`);
        const { rel, abs } = resolveDoc(project, o.doc || cfg.defaultDoc || '');
        if (!cfg.docs.some(d => d.path === rel)) throw new Error(`${rel} isn't one of this project's research docs in ${CONFIG}; add it with init first`);
        const before = readDoc(abs, rel) ?? `# ${path.basename(rel).replace(/\.(md|markdown)$/i, '')}\n`;
        const used = new Set(readJournal(journal).map(r => r.id || r.undo));
        let id;
        do id = crypto.randomBytes(3).toString('hex'); while (used.has(id) || before.includes(`(log id: ${id})`));
        const entry = [`- **${stamp(now)} · ${LABEL[o.kind]}** · ${text} (log id: ${id})`];
        if (connection) entry.push(`  - Connection: ${connection}`);
        writeAtomic(abs, insertEntry(before, entry));
        fs.appendFileSync(journal, JSON.stringify({ id, doc: rel, kind: o.kind, time: now.toISOString() }) + '\n');
        return { logged: true, id, doc: rel, kind: o.kind, entry: entry.join('\n'), message: `Logged to ${rel} (${LABEL[o.kind].toLowerCase()}). Say "undo" to remove it.` };
      });
    }
    case 'undo': {
      if (!fs.existsSync(journal)) throw new Error('nothing to undo');
      return withLock(project, () => {
        const rows = readJournal(journal);
        const undone = new Set(rows.filter(r => r.undo).map(r => r.undo));
        const target = o.id ? rows.find(r => r.id === o.id) : [...rows].reverse().find(r => r.id && !undone.has(r.id));
        if (!target) throw new Error(o.id ? `no log entry with id ${o.id}` : 'nothing to undo');
        if (undone.has(target.id)) throw new Error(`entry ${target.id} was already undone`);
        // A row whose doc the current rules refuse (an old journal) is marked undone, not retried forever.
        let rel = clean(target.doc, 120), abs = null;
        try { ({ rel, abs } = resolveDoc(project, target.doc)); } catch { /* left as null */ }
        const text = abs ? readDoc(abs, rel) : null;
        const after = text == null ? null : removeEntry(text, target.id);
        // Older journals kept a copy of each entry's text; drop those copies whenever undo runs.
        const rewrite = rows.map(r => (r.undo ? { undo: r.undo, time: r.time } : { id: r.id, doc: r.doc, kind: r.kind, time: r.time }));
        rewrite.push({ undo: target.id, time: now.toISOString() });
        if (after != null) writeAtomic(abs, after);
        writeAtomic(journal, rewrite.map(r => JSON.stringify(r)).join('\n') + '\n');
        if (after == null) return { undone: target.id, doc: rel, removed: false, message: `The ${LABEL[target.kind].toLowerCase()} ${target.id} was already gone from ${rel} (edited or moved by hand), so nothing changed; it won't be offered for undo again.` };
        return { undone: target.id, doc: rel, removed: true, message: `Removed the ${LABEL[target.kind].toLowerCase()} from ${rel}.` };
      });
    }
    case 'recent': {
      if (!fs.existsSync(journal)) return { entries: [] };
      const rows = readJournal(journal);
      const undone = new Set(rows.filter(r => r.undo).map(r => r.undo));
      const docs = new Map();
      const lineFor = r => {
        try {
          if (!docs.has(r.doc)) { const { rel, abs } = resolveDoc(project, r.doc); docs.set(r.doc, (readDoc(abs, rel) || '').replace(/\r\n/g, '\n').split('\n')); }
          return docs.get(r.doc).find(l => isEntryLine(l, r.id)) || null;
        } catch { return null; }
      };
      const entries = rows.filter(r => r.id && !undone.has(r.id)).slice(-o.n).map(r => {
        const line = lineFor(r);
        return { id: r.id, doc: clean(r.doc, 120), kind: r.kind, time: r.time, localTime: stamp(new Date(r.time)), text: line ? clean(line, 700) : null, inDoc: !!line };
      });
      return { entries };
    }
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Compares real paths, so the helper still runs when its folder is reached through a link.
const realOrSame = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isMain = process.argv[1] && realOrSame(process.argv[1]) === realOrSame(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const input = ['route', 'add'].includes(o.cmd) ? await readStdin() : '';
    console.log(JSON.stringify(runCommand(o, input)));
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }));
    process.exit(2);
  }
}
