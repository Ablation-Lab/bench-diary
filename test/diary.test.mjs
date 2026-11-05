import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCommand, parseArgs, clean, splitEntry, insertEntry, resolveDoc, stamp } from '../plugin/skills/bench-diary/scripts/diary.mjs';

const SCRIPT = fileURLToPath(new URL('../plugin/skills/bench-diary/scripts/diary.mjs', import.meta.url));
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-diary-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const run = (project, argv, input = '', now) => runCommand({ ...parseArgs(argv), project }, input, now);
const setup = () => {
  const p = tmp();
  run(p, ['init', '--doc', 'notes/councils.md', '--topics', 'review councils, judges, reviewers, findings']);
  run(p, ['init', '--doc', 'notes/methods.md', '--topics', 'methods, protocol, sample size']);
  return p;
};
const read = (p, f) => fs.readFileSync(path.join(p, f), 'utf8');

test('init makes the config and a doc with a Research log section', () => {
  const p = setup();
  assert.deepEqual(JSON.parse(read(p, 'bench-diary.json')).docs.map(d => d.path), ['notes/councils.md', 'notes/methods.md']);
  assert.match(read(p, 'notes/councils.md'), /^# councils\n\n## Research log\n/);
  assert.equal(read(p, '.bench-diary/.gitignore'), '*\n');
});

test('route picks the doc whose topics match', () => {
  const p = setup();
  assert.equal(run(p, ['route'], 'The judge dropped two reviewer findings as duplicates.').best, 'notes/councils.md');
  assert.equal(run(p, ['route'], 'We need a bigger sample size for the protocol.').best, 'notes/methods.md');
  assert.equal(run(p, ['route'], 'Completely unrelated words here.').best, 'notes/councils.md', 'falls back to the default doc');
});

test('add appends under the log heading, keeps other text, and undo removes only that entry', () => {
  const p = setup();
  fs.writeFileSync(path.join(p, 'notes/councils.md'), '# Councils\n\nMy own notes.\n\n## Research log\n\n- an old line I wrote\n\n## Later section\n\nKeep me.\n');
  const a = run(p, ['add', '--doc', 'notes/councils.md', '--kind', 'decision'], 'Use a judge on every run.');
  const b = run(p, ['add', '--doc', 'notes/councils.md', '--kind', 'related'], 'A podcast on rubber-ducking.\nConnection: only loosely; it is about one reviewer.');
  const doc = read(p, 'notes/councils.md');
  assert.match(doc, /- an old line I wrote\n- \*\*.* · Decision\*\* · Use a judge on every run\. \(log id: [0-9a-f]{6}\)\n- \*\*.* · Loosely related\*\* · A podcast on rubber-ducking\. \(log id: [0-9a-f]{6}\)\n {2}- Connection: only loosely; it is about one reviewer\.\n\n## Later section\n\nKeep me\.\n$/);
  run(p, ['undo']);
  assert.ok(!read(p, 'notes/councils.md').includes(b.id));
  assert.ok(!read(p, 'notes/councils.md').includes('Connection:'));
  assert.ok(read(p, 'notes/councils.md').includes(a.id));
  assert.match(read(p, 'notes/councils.md'), /My own notes\.[\s\S]*Keep me\.\n$/);
  run(p, ['undo']);
  assert.throws(() => run(p, ['undo']), /nothing to undo/);
  assert.equal(run(p, ['recent']).entries.length, 0);
});

test('undo by id, and undo of an entry edited away', () => {
  const p = setup();
  const a = run(p, ['add', '--doc', 'notes/methods.md', '--kind', 'note'], 'First.');
  run(p, ['add', '--doc', 'notes/methods.md', '--kind', 'idea'], 'Second.');
  run(p, ['undo', '--id', a.id]);
  assert.ok(!read(p, 'notes/methods.md').includes('First.'));
  assert.throws(() => run(p, ['undo', '--id', a.id]), /already undone/);
  const c = run(p, ['add', '--doc', 'notes/methods.md', '--kind', 'note'], 'Third.');
  fs.writeFileSync(path.join(p, 'notes/methods.md'), read(p, 'notes/methods.md').replace(/.*Third.*\n/, ''));
  const u = run(p, ['undo', '--id', c.id]);
  assert.equal(u.removed, false);
  assert.match(u.message, /already gone/);
  assert.throws(() => run(p, ['undo', '--id', c.id]), /already undone/, 'not offered again');
});

test('related items need a connection note', () => {
  const p = setup();
  assert.throws(() => run(p, ['add', '--doc', 'notes/councils.md', '--kind', 'related'], 'A loose thing.'), /Connection/);
});

test('only listed docs inside the project, never instruction files', () => {
  const p = setup();
  assert.throws(() => run(p, ['add', '--doc', 'notes/other.md', '--kind', 'note'], 'x'), /isn't one of this project's research docs/);
  for (const bad of ['../x.md', '/etc/x.md', 'C:/x.md', '//host/share/x.md', 'notes/x.txt', 'notes/a.md:hidden.md', 'CLAUDE.md', 'docs/AGENTS.md', '.claude/notes.md', 'skills/x/SKILL.md', 'README.md', 'notes/../../x.md'])
    assert.throws(() => run(p, ['init', '--doc', bad]), /inside the project|Markdown|instruction/, bad);
  assert.equal(resolveDoc(p, './notes/a.md').rel, 'notes/a.md');
});

test('a planted config cannot point add outside the project', () => {
  const p = tmp();
  fs.writeFileSync(path.join(p, 'bench-diary.json'), JSON.stringify({ docs: [{ path: '../evil.md' }, { path: 'CLAUDE.md' }], defaultDoc: 'CLAUDE.md' }));
  assert.throws(() => run(p, ['add', '--kind', 'note'], 'x'), /confirmed|no usable docs/);
  const d = run(p, ['docs']);
  assert.deepEqual(d.docs, []);
  assert.equal(d.invalid.length, 2);
  assert.throws(() => run(p, ['enable']), /no usable docs/);
  assert.throws(() => run(p, ['add', '--doc', '../evil.md', '--kind', 'note'], 'x'), /confirmed|inside the project/);
  assert.throws(() => run(p, ['init', '--doc', '../evil.md']), /inside the project/);
  assert.ok(!fs.existsSync(path.join(p, 'CLAUDE.md')));
});

test('entries stay on one line and hidden characters are dropped', () => {
  const ESC = String.fromCodePoint(0x1b), RLO = String.fromCodePoint(0x202e), ZW = String.fromCodePoint(0x200b), TAG = String.fromCodePoint(0xe0041);
  assert.equal(clean(`a${ESC}[31mb${RLO}c${ZW}d${TAG}e\nf`), 'a[31mbcde f');
  const cp = String.fromCodePoint;
  const flag = cp(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f); // England
  const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  const persian = 'می' + cp(0x200c) + 'خواهم';
  assert.equal(clean(`${flag} ${family} ${persian}`), `${flag} ${family} ${persian}`, 'flags, emoji joins and ZWNJ kept');
  assert.equal(clean('<img src=x onerror=y> ![t](https://x.example/p.png) a < b'), '&lt;img src=x onerror=y> !\\[t](https://x.example/p.png) a < b');
  assert.equal(clean('-1 is odd'), '-1 is odd');
  const long = clean('x'.repeat(598) + String.fromCodePoint(0x1f600) + 'yy');
  assert.ok(!long.includes(String.fromCodePoint(0xfffd)) && Array.from(long).length === 600);
  assert.deepEqual(splitEntry('Line one\nline two\nConnection: because\nmore'), { text: 'Line one line two', connection: 'because more' });
  const p = setup();
  run(p, ['add', '--doc', 'notes/methods.md', '--kind', 'note'], 'one\n## Fake heading\n- [ ] fake item');
  assert.ok(!/^## Fake/m.test(read(p, 'notes/methods.md')));
});

test('CRLF docs stay CRLF; UTF-16 docs and links are refused', () => {
  const p = setup();
  fs.writeFileSync(path.join(p, 'notes/methods.md'), '# Methods\r\n\r\n## Research log\r\n\r\n- old\r\n');
  const a = run(p, ['add', '--doc', 'notes/methods.md', '--kind', 'note'], 'New.');
  assert.ok(!/[^\r]\n/.test(read(p, 'notes/methods.md')), 'every newline is CRLF');
  run(p, ['undo', '--id', a.id]);
  assert.equal(read(p, 'notes/methods.md'), '# Methods\r\n\r\n## Research log\r\n\r\n- old\r\n');
  fs.writeFileSync(path.join(p, 'notes/councils.md'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# C\n', 'utf16le')]));
  assert.throws(() => run(p, ['add', '--doc', 'notes/councils.md', '--kind', 'note'], 'x'), /UTF-16/);
  const hard = path.join(p, 'notes/hard.md');
  fs.linkSync(path.join(p, 'notes/methods.md'), hard);
  assert.throws(() => run(p, ['init', '--doc', 'notes/hard.md']), /hard links/);
});

test('local date and time in the stamp', () => {
  const d = new Date(2026, 10, 5, 23, 59);
  assert.equal(stamp(d), '2026-11-05 23:59');
});

test('insertEntry creates the section at the end when missing', () => {
  assert.equal(insertEntry('# Doc\n\ntext\n\n\n', ['- e']), '# Doc\n\ntext\n\n## Research log\n\n- e\n');
});

test('off without a config', () => {
  const p = tmp();
  assert.equal(run(p, ['docs']).active, false);
  assert.throws(() => run(p, ['add', '--kind', 'note'], 'x'), /off here/);
});

test('bad options are refused', () => {
  assert.throws(() => parseArgs(['add', '--kind', 'gossip']), /--kind/);
  assert.throws(() => parseArgs(['undo', '--id', '$(rm)']), /--id/);
  assert.throws(() => parseArgs(['nope']), /unknown command/);
});

test('parallel runs from the CLI lose no entries and leave no temp files', async () => {
  const p = setup();
  const one = i => new Promise(res => {
    const c = spawn(process.execPath, [SCRIPT, 'add', '--doc', 'notes/councils.md', '--kind', 'note', '--project', p]);
    let out = ''; c.stdout.on('data', d => (out += d)); c.on('close', code => res({ code, out }));
    c.stdin.end(`Parallel entry ${i}.`);
  });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => one(i)));
  assert.ok(results.every(r => r.code === 0), results.map(r => r.out).join('\n'));
  const doc = read(p, 'notes/councils.md');
  for (let i = 0; i < 12; i++) assert.ok(doc.includes(`Parallel entry ${i}.`), `entry ${i}`);
  assert.deepEqual(fs.readdirSync(path.join(p, 'notes')).filter(f => f.includes('.tmp-')), []);
  assert.ok(!fs.existsSync(path.join(p, '.bench-diary/lock')));
});

test('the README sample steps work on samples/', () => {
  const p = tmp();
  fs.cpSync(new URL('../samples/', import.meta.url), p, { recursive: true });
  // The sample comes with a bench-diary.json, so logging waits for the user's OK.
  assert.equal(run(p, ['docs']).setUpHere, false);
  assert.throws(() => run(p, ['add', '--doc', 'notes/results.md', '--kind', 'note'], 'x'), /confirmed/);
  run(p, ['enable']);
  // The README's step 3 wording, with and without the "Idea:" prefix.
  assert.equal(run(p, ['route', '--kind', 'idea'], 'Try a council with no judge and only a vote.').best, 'notes/ideas.md');
  const a = run(p, ['route', '--kind', 'note'], 'Run 4 found that the judge removed 6 duplicate findings.');
  assert.equal(a.best, 'notes/results.md');
  run(p, ['add', '--doc', a.best, '--kind', 'note'], 'Run 4 found that the judge removed 6 duplicate findings.');
  const b = run(p, ['route', '--kind', 'idea'], 'Idea: try a council with no judge and only a vote.');
  assert.equal(b.best, 'notes/ideas.md');
  run(p, ['add', '--doc', b.best, '--kind', 'idea'], 'Try a council with no judge and only a vote.');
  run(p, ['undo']);
  assert.ok(!read(p, 'notes/ideas.md').includes('only a vote'));
  assert.ok(read(p, 'notes/ideas.md').includes('9d0e1f') && read(p, 'notes/ideas.md').includes('Connection: only loosely'));
  const recent = run(p, ['recent']).entries;
  assert.equal(recent.length, 1);
  assert.match(recent[0].text, /Run 4/);
});
