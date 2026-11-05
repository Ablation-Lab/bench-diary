#!/usr/bin/env node
// Lab Scribe helper: appends research-log entries to the Markdown docs a project lists in
// lab-scribe.json, and undoes them.
//
//   node scribe.mjs init   --doc <path> [--topics "a, b"] [--description "..."] [--project <dir>]
//   node scribe.mjs docs   [--project <dir>]
//   node scribe.mjs route  [--project <dir>]                      (the item on stdin)
//   node scribe.mjs add    --doc <path> --kind <kind> [--project <dir>]   (entry on stdin; a line
//                          starting "Connection:" becomes the connection note)
//   node scribe.mjs undo   [--id <log id>] [--project <dir>]
//   node scribe.mjs recent [--n 10] [--project <dir>]
//
// It writes only: lab-scribe.json, the docs listed in it (inside the project, .md only), and the
// undo journal .lab-scribe/journal.jsonl. Each write goes through a temporary file and a rename.
// It reads nothing else and makes no network requests. Output is one line of JSON.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const KINDS = ['note', 'decision', 'anecdote', 'idea', 'related'];
const LABEL = { note: 'Note', decision: 'Decision', anecdote: 'Anecdote', idea: 'Experiment idea', related: 'Loosely related' };
const LOG_HEADING = '## Research log';
const CONFIG = 'lab-scribe.json';

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
  if (!['init', 'docs', 'route', 'add', 'undo', 'recent'].includes(cmd)) throw new Error(`unknown command "${cmd ?? ''}"; use init, docs, route, add, undo or recent`);
  if (o.kind != null && !KINDS.includes(o.kind)) throw new Error(`--kind must be one of ${KINDS.join(', ')}`);
  if (!Number.isInteger(o.n) || o.n < 1 || o.n > 200) throw new Error('--n must be a whole number from 1 to 200');
  if (o.id != null && !/^[0-9a-f]{6}$/.test(o.id)) throw new Error('--id is the six-character log id shown after an entry, such as 3fa9c1');
  return o;
}

// One line, capped by characters (not UTF-16 units, so emoji aren't split). Entries always sit after
// a "- **date · Kind** · " prefix, so text starting with "-" or "#" can't turn into Markdown structure.
// Built from code points so the source holds no invisible characters.
const cp = n => String.fromCodePoint(n);
// Bidi embeddings, overrides and isolates (they can make text read differently from how it's stored),
// and zero-width spaces and word joiners (used to hide text). Joiners that emoji and many scripts
// need (U+200C, U+200D) are kept.
const HIDDEN = new RegExp(`[${cp(0x202a)}-${cp(0x202e)}${cp(0x2066)}-${cp(0x2069)}${cp(0x200b)}${cp(0x2060)}${cp(0xfeff)}]`, 'gu');
// Tag characters, except inside a subdivision flag (a black flag, tag letters, then a cancel tag).
const TAGS = new RegExp(`(${cp(0x1f3f4)}[${cp(0xe0020)}-${cp(0xe007e)}]+${cp(0xe007f)})|[${cp(0xe0000)}-${cp(0xe007f)}]`, 'gu');
export function clean(text, max = 600) {
  const t = String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\p{Cc}/gu, '') // control characters, such as terminal colour codes
    .replace(HIDDEN, '')
    .replace(TAGS, (m, flag) => flag || '')
    // Shown as text, not rendered: no HTML tags, and no images a Markdown viewer would fetch.
    .replace(/<(?=[A-Za-z!/?])/g, '&lt;').replace(/!\[/g, '!\\[')
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

// A doc path from the config or the user: relative, inside the project, Markdown.
export function resolveDoc(project, rel) {
  const r = String(rel ?? '').replace(/\\/g, '/').trim();
  if (!r) throw new Error('give the doc with --doc');
  if (/^(\/|[A-Za-z]:)/.test(r) || r.includes(':') || r.split('/').includes('..')) throw new Error(`doc paths must stay inside the project: ${rel}`);
  if (!/\.(md|markdown)$/i.test(r)) throw new Error(`docs must be Markdown files (.md): ${rel}`);
  // Files that instruct Claude or other tools are never research docs.
  const parts = r.toLowerCase().split('/');
  if (parts.some(p => p.startsWith('.') && p !== '.') || ['claude.md', 'claude.local.md', 'agents.md', 'gemini.md', 'skill.md', 'readme.md'].includes(parts[parts.length - 1]))
    throw new Error(`${rel} is an instruction or project file (or in a hidden folder), not a research doc; pick a doc of your own, such as notes/research-log.md`);
  const abs = path.resolve(project, r);
  if (!abs.startsWith(path.resolve(project) + path.sep)) throw new Error(`doc paths must stay inside the project: ${rel}`);
  // A folder on the way that is a link could point outside the project.
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  const realProject = fs.realpathSync(project);
  const realDir = fs.realpathSync(dir);
  if (realDir !== realProject && !realDir.startsWith(realProject + path.sep)) throw new Error(`doc paths must stay inside the project (a linked folder leads outside it): ${rel}`);
  return { rel: path.posix.normalize(r), abs };
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// One run at a time per project: two Claude sessions logging at once must not lose an entry.
export function withLock(project, fn) {
  const dir = path.join(project, '.lab-scribe');
  fs.mkdirSync(dir, { recursive: true });
  // The undo journal holds copies of entries; keep it out of git.
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  const lock = path.join(dir, 'lock');
  const until = Date.now() + 12000;
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (Date.now() > until) throw new Error('another Lab Scribe run is still writing (its lock is .lab-scribe/lock); try again in a moment');
      sleep(50);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error(`${path.basename(file)} is not valid JSON: ${e.message}`); }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a link; Lab Scribe won't write through it`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text);
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

export function loadConfig(project) {
  const cfg = readJson(path.join(project, CONFIG), null);
  if (!cfg) return null;
  if (!Array.isArray(cfg.docs)) throw new Error(`${CONFIG} needs a "docs" list`);
  return cfg;
}

// Lower-case words of three letters or more, without a plural "s", so "councils" matches "council".
const stem = w => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const words = s => new Set((String(s).toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || []).filter(w => !STOP.has(w)).map(stem));
const STOP = new Set('the and for with that this from into about over have has was were are not but you your our its their them they then than when what which will would could should also just more most some such only very each other here there being been out how why who use used using can may might must research log'.split(' '));
// Words in a doc's topics that suit each kind of entry.
const KIND_WORDS = { note: ['finding', 'result', 'observation', 'note'], decision: ['decision', 'choice'], anecdote: ['anecdote', 'story', 'stories'], idea: ['idea', 'experiment', 'plan'], related: ['related', 'misc', 'reading'] };

// Ranks the configured docs for an item, by shared words with each doc's topics, description and
// headings, plus a bonus when a doc's topics suit the entry's kind.
export function route(project, cfg, input, kind = null) {
  const item = words(input);
  const scored = cfg.docs.map(d => {
    let headings = '';
    try { const { rel, abs } = resolveDoc(project, d.path); headings = (readDoc(abs, rel) || '').split('\n').filter(l => /^#{1,4}\s/.test(l)).slice(0, 80).join(' '); } catch { /* missing or refused doc: route on topics only */ }
    const topicWords = words([...(Array.isArray(d.topics) ? d.topics : []), typeof d.description === 'string' ? d.description : ''].join(' '));
    const headingWords = words(headings);
    const matched = [...item].filter(w => topicWords.has(w) || headingWords.has(w));
    let score = [...item].reduce((s, w) => s + (topicWords.has(w) ? 2 : 0) + (headingWords.has(w) ? 1 : 0), 0);
    if (kind && (KIND_WORDS[kind] || []).some(w => topicWords.has(stem(w)))) score += 3;
    return { doc: String(d.path), score, matched };
  }).sort((a, b) => b.score - a.score);
  return { ranked: scored, best: scored[0]?.score > 0 ? scored[0].doc : (cfg.defaultDoc || null) };
}

// Local date and time, both from the same clock.
const pad = n => String(n).padStart(2, '0');
export const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Inserts entry lines at the end of the "## Research log" section, creating it at the end of the doc.
export function insertEntry(docText, entryLines) {
  const eol = eolOf(docText);
  const lines = docText.replace(/\r\n/g, '\n').split('\n');
  let start = lines.findIndex(l => l.trim().toLowerCase() === LOG_HEADING.toLowerCase());
  if (start < 0) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push('', LOG_HEADING, '', ...entryLines, '');
    return lines.join(eol);
  }
  let end = start + 1;
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++;
  let at = end;
  while (at > start + 1 && lines[at - 1] === '') at--;
  const prefix = at === start + 1 ? [''] : [];
  // Keep a blank line before the next heading, and the file's final newline.
  const suffix = at < lines.length && lines[at] !== '' ? [''] : [];
  lines.splice(at, 0, ...prefix, ...entryLines, ...suffix);
  if (lines[lines.length - 1] !== '') lines.push('');
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
  return buf.toString('utf8');
}

function readJournal(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && typeof r === 'object' && (/^[0-9a-f]{6}$/.test(r.id) || /^[0-9a-f]{6}$/.test(r.undo)));
}

export function runCommand(o, input, now = new Date()) {
  const project = path.resolve(o.project || process.cwd());
  const cfgFile = path.join(project, CONFIG);
  const journal = path.join(project, '.lab-scribe', 'journal.jsonl');
  let cfg = loadConfig(project);
  switch (o.cmd) {
    case 'init': {
      const { rel, abs } = resolveDoc(project, o.doc);
      cfg = cfg || { docs: [] };
      const topics = o.topics ? o.topics.split(',').map(s => clean(s, 60)).filter(Boolean) : [];
      const existing = cfg.docs.find(d => d.path === rel);
      if (existing) { if (topics.length) existing.topics = topics; if (o.description) existing.description = clean(o.description, 200); }
      else cfg.docs.push({ path: rel, topics, description: o.description ? clean(o.description, 200) : '' });
      if (!cfg.defaultDoc) cfg.defaultDoc = rel;
      return withLock(project, () => {
        const docText = readDoc(abs, rel);
        writeAtomic(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
        if (docText == null) writeAtomic(abs, `# ${path.basename(rel).replace(/\.(md|markdown)$/i, '')}\n\n${LOG_HEADING}\n`);
        return { config: CONFIG, docs: cfg.docs.map(d => d.path), created: docText == null ? rel : null, message: `Research logging is on for ${rel}.` };
      });
    }
    case 'docs':
      if (!cfg) return { active: false, message: `No ${CONFIG} in this project, so research logging is off here.` };
      return { active: true, docs: cfg.docs, defaultDoc: cfg.defaultDoc || null };
    case 'route':
      if (!cfg) return { active: false, message: `No ${CONFIG} in this project.` };
      return { active: true, ...route(project, cfg, input, o.kind) };
    case 'add': {
      if (!cfg) throw new Error(`research logging is off here: no ${CONFIG} (run init first)`);
      if (!o.kind) throw new Error(`give --kind (${KINDS.join(', ')})`);
      const { rel, abs } = resolveDoc(project, o.doc || cfg.defaultDoc);
      if (!cfg.docs.some(d => { try { return resolveDoc(project, d.path).rel === rel; } catch { return false; } })) throw new Error(`${rel} isn't one of this project's research docs in ${CONFIG}; add it with init first`);
      const { text, connection } = splitEntry(input);
      if (!text) throw new Error('give the entry on stdin');
      if (o.kind === 'related' && !connection) throw new Error('a loosely related item needs a "Connection:" line saying how it does or doesn\'t connect');
      const id = crypto.randomBytes(3).toString('hex');
      const entry = [`- **${stamp(now)} · ${LABEL[o.kind]}** · ${text} (log id: ${id})`];
      if (connection) entry.push(`  - Connection: ${connection}`);
      return withLock(project, () => {
        const before = readDoc(abs, rel) ?? `# ${path.basename(rel).replace(/\.(md|markdown)$/i, '')}\n`;
        writeAtomic(abs, insertEntry(before, entry));
        fs.appendFileSync(journal, JSON.stringify({ id, doc: rel, kind: o.kind, time: now.toISOString(), lines: entry }) + '\n');
        return { logged: true, id, doc: rel, kind: o.kind, entry: entry.join('\n'), message: `Logged to ${rel} (${LABEL[o.kind].toLowerCase()}). Say "undo" to remove it.` };
      });
    }
    case 'undo':
      return withLock(project, () => {
        const rows = readJournal(journal);
        const undone = new Set(rows.filter(r => r.undo).map(r => r.undo));
        const target = o.id ? rows.find(r => r.id === o.id) : [...rows].reverse().find(r => r.id && !undone.has(r.id));
        if (!target) throw new Error(o.id ? `no log entry with id ${o.id}` : 'nothing to undo');
        if (undone.has(target.id)) throw new Error(`entry ${target.id} was already undone`);
        const { rel, abs } = resolveDoc(project, target.doc);
        const text = readDoc(abs, rel);
        if (text == null) throw new Error(`${rel} isn't there any more`);
        const eol = eolOf(text);
        const lines = text.replace(/\r\n/g, '\n').split('\n');
        const k = lines.findIndex(l => l.endsWith(`(log id: ${target.id})`));
        if (k < 0) throw new Error(`entry ${target.id} isn't in ${rel} any more (edited or moved by hand), so there's nothing to remove`);
        const count = lines[k + 1] != null && /^ {2}- Connection: /.test(lines[k + 1]) ? 2 : 1;
        lines.splice(k, count);
        writeAtomic(abs, lines.join(eol));
        fs.appendFileSync(journal, JSON.stringify({ undo: target.id, time: now.toISOString() }) + '\n');
        return { undone: target.id, doc: rel, message: `Removed the ${LABEL[target.kind]?.toLowerCase() || 'entry'} from ${rel}.` };
      });
    case 'recent': {
      const rows = readJournal(journal);
      const undone = new Set(rows.filter(r => r.undo).map(r => r.undo));
      return { entries: rows.filter(r => r.id && !undone.has(r.id)).slice(-o.n).map(r => ({ id: r.id, doc: r.doc, kind: r.kind, time: r.time, text: r.lines[0] })) };
    }
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
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
