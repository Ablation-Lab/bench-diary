// Regression tests for the Lab Scribe council's round-1 fix list (judge.md).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCommand, parseArgs, clean, insertEntry, removeEntry, resolveDoc } from '../plugin/skills/lab-scribe/scripts/scribe.mjs';

const SCRIPT = fileURLToPath(new URL('../plugin/skills/lab-scribe/scripts/scribe.mjs', import.meta.url));
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-scribe-r1-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const run = (p, argv, input = '') => runCommand({ ...parseArgs(argv), project: p }, input);
const read = (p, f) => fs.readFileSync(path.join(p, f), 'utf8');
const setup = () => { const p = tmp(); run(p, ['init', '--doc', 'notes/log.md', '--topics', 'results']); return p; };

test('consent: a lab-scribe.json that came with the project needs enable; init enables for its author', () => {
  const p = tmp();
  fs.mkdirSync(path.join(p, 'notes'));
  fs.writeFileSync(path.join(p, 'lab-scribe.json'), JSON.stringify({ docs: [{ path: 'notes/log.md' }] }));
  assert.equal(run(p, ['docs']).setUpHere, false);
  assert.throws(() => run(p, ['add', '--doc', 'notes/log.md', '--kind', 'note'], 'x'), /confirmed for you.*notes\/log\.md.*enable/);
  assert.ok(!fs.existsSync(path.join(p, 'notes/log.md')), 'nothing written');
  run(p, ['enable']);
  assert.equal(run(p, ['add', '--doc', 'notes/log.md', '--kind', 'note'], 'x').logged, true);
  assert.equal(read(p, '.lab-scribe/.gitignore'), '*\n', 'the marker stays out of git');
  assert.equal(run(setup(), ['docs']).setUpHere, true);
});

test('planted paths: shell characters, short names and invalid entries are refused and never printed raw', () => {
  const p = tmp();
  const tagged = 'notes/a' + String.fromCodePoint(0xe0041) + '.md';
  fs.writeFileSync(path.join(p, 'lab-scribe.json'), JSON.stringify({ docs: [
    { path: 'notes/$(echo ran).md' }, { path: "notes/a'b.md" }, { path: 'notes/x;y.md' }, { path: 'CLAUDE~1/r.md' }, null, 7, { path: tagged },
    { path: 'notes/ok.md', topics: ['results', 'x' + String.fromCodePoint(0x202e)], description: 'run ' + String.fromCodePoint(0xe0049) + 'notes' },
  ], defaultDoc: 'notes/$(echo ran).md' }));
  const d = run(p, ['docs']);
  assert.deepEqual(d.docs.map(x => x.path), ['notes/ok.md'], 'only names that pass the checks');
  assert.equal(d.defaultDoc, 'notes/ok.md');
  assert.equal(d.invalid.length, 7);
  assert.throws(() => resolveDoc(p, tagged), /invisible/);
  const out = JSON.stringify(d.docs[0]) + JSON.stringify(d.invalid);
  assert.ok(!out.includes(String.fromCodePoint(0x202e)) && !out.includes(String.fromCodePoint(0xe0049)), 'hidden characters cleaned');
  const r = run(p, ['route', '--kind', 'note'], 'results of the run');
  assert.ok(r.ranked.every(x => !/[$;']/.test(x.doc)));
  for (const bad of ['notes/$(x).md', 'notes/`x`.md', "notes/a'b.md", 'notes/a"b.md', 'notes/a;b.md', 'notes/a&b.md', 'notes/a|b.md', 'CLAUDE~1/x.md', 'notes/a%b.md'])
    assert.throws(() => resolveDoc(p, bad), /can't contain|short name/, bad);
  for (const good of ['notes/résumé café.md', 'notes/研究.md', 'notes/run (old).md', 'notes/a-b_c.d.md', 'notes/~draft.md'])
    assert.equal(resolveDoc(p, good).rel, good, good);
});

test('the real path is checked: a short name cannot reach .claude or CLAUDE.local.md', { skip: process.platform !== 'win32' }, () => {
  const p = setup();
  fs.mkdirSync(path.join(p, '.claude'));
  const s = execSync(`cmd /c for %I in ("${path.join(p, '.claude')}") do @echo %~sI`, { encoding: 'utf8' }).trim();
  if (s.endsWith('.claude')) return; // short names are off on this drive
  // Short names are refused outright; this checks the real-path recheck on its own too.
  assert.throws(() => resolveDoc(p, path.basename(s) + '/x.md'), /short name/);
});

test('the journal keeps no entry text, and undo strips text from older journals', () => {
  const p = setup();
  const a = run(p, ['add', '--doc', 'notes/log.md', '--kind', 'note'], 'my password is hunter2 (oops)');
  assert.ok(!read(p, '.lab-scribe/journal.jsonl').includes('hunter2'));
  assert.match(run(p, ['recent']).entries[0].text, /hunter2/, 'recent reads the text from the doc');
  run(p, ['undo']);
  assert.ok(!read(p, '.lab-scribe/journal.jsonl').includes('hunter2'));
  assert.ok(!read(p, 'notes/log.md').includes('hunter2'));
  // An older journal with a copy of the text.
  fs.appendFileSync(path.join(p, '.lab-scribe/journal.jsonl'), JSON.stringify({ id: 'abcdef', doc: 'notes/log.md', kind: 'note', time: new Date().toISOString(), lines: ['- **x · Note** · secret old text (log id: abcdef)'] }) + '\n');
  run(p, ['add', '--doc', 'notes/log.md', '--kind', 'note'], 'new');
  run(p, ['undo']);
  assert.ok(!read(p, '.lab-scribe/journal.jsonl').includes('secret old text'));
  assert.ok(a.id);
});

test('non-UTF-8 docs are refused unchanged; a UTF-8 BOM in a doc is kept; a BOM in the config is fine', () => {
  const p = setup();
  const cp1252 = Buffer.from([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x0a]);
  fs.writeFileSync(path.join(p, 'notes/log.md'), cp1252);
  assert.throws(() => run(p, ['add', '--doc', 'notes/log.md', '--kind', 'note'], 'x'), /isn't UTF-8/);
  assert.deepEqual([...fs.readFileSync(path.join(p, 'notes/log.md'))], [...cp1252]);
  fs.writeFileSync(path.join(p, 'notes/log.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Log\n\n## Research log\n')]));
  run(p, ['add', '--doc', 'notes/log.md', '--kind', 'note'], 'x');
  assert.deepEqual([...fs.readFileSync(path.join(p, 'notes/log.md')).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  fs.writeFileSync(path.join(p, 'lab-scribe.json'), String.fromCharCode(0xfeff) + read(p, 'lab-scribe.json'));
  assert.equal(run(p, ['docs']).active, true);
});

test('code fences: a # line in code does not end the section, a fenced example heading is not the log', () => {
  const doc = '# T\n\n```md\n## Research log\n```\n\n## Research log\n\n- old\n\n```bash\n# install\nnpm i\n```\n\n## Next\n';
  const out = insertEntry(doc, ['- NEW']);
  assert.match(out, /```md\n## Research log\n```/, 'the example is untouched');
  assert.match(out, /npm i\n```\n- NEW\n\n## Next/, 'the entry goes after the code block, before the next heading');
  assert.match(insertEntry('# T\n\n```\nunclosed\n', ['- e']), /unclosed\n```\n\n## Research log\n\n- e\n$/);
  assert.match(insertEntry('# T\n\n## Research log ##\n\n- a\n', ['- e']), /- a\n- e\n$/, 'closed ATX heading recognised');
});

test('undo only matches entry lines, and add then undo leaves the doc as it was', () => {
  const p = setup();
  const a = run(p, ['add', '--doc', 'notes/log.md', '--kind', 'note'], 'A');
  run(p, ['add', '--doc', 'notes/log.md', '--kind', 'related'], `B\nConnection: see (log id: ${a.id})`);
  assert.ok(!read(p, 'notes/log.md').includes(`see (log id: ${a.id})`), 'a log id in text is defused');
  run(p, ['undo', '--id', a.id]);
  assert.ok(!read(p, 'notes/log.md').includes('· A ('));
  assert.match(read(p, 'notes/log.md'), /Connection: see/);
  const doc = '# T\n\n## Research log\n## Next\n';
  const once = insertEntry(doc, ['- **x · Note** · e (log id: 123abc)']);
  assert.equal(removeEntry(once, '123abc'), '# T\n\n## Research log\n\n## Next\n');
});

test('parallel inits keep every doc; parallel adds lose nothing', async () => {
  const p = tmp();
  const one = (args, input = '') => new Promise(res => {
    const c = spawn(process.execPath, [SCRIPT, ...args, '--project', p]);
    let out = ''; c.stdout.on('data', d => (out += d)); c.on('close', code => res({ code, out }));
    c.stdin.end(input);
  });
  const inits = await Promise.all(['a', 'b', 'c', 'd'].map(x => one(['init', '--doc', `notes/${x}.md`])));
  assert.ok(inits.every(r => r.code === 0), inits.map(r => r.out).join('\n'));
  assert.deepEqual(JSON.parse(read(p, 'lab-scribe.json')).docs.map(d => d.path).sort(), ['notes/a.md', 'notes/b.md', 'notes/c.md', 'notes/d.md']);
  const adds = await Promise.all(Array.from({ length: 20 }, (_, i) => one(['add', '--doc', 'notes/a.md', '--kind', 'note'], `entry ${i}`)));
  assert.ok(adds.every(r => r.code === 0), adds.map(r => r.out).join('\n'));
  for (let i = 0; i < 20; i++) assert.ok(read(p, 'notes/a.md').includes(`entry ${i} (`), `entry ${i}`);
});

test('no .lab-scribe folder without a config; links for .lab-scribe are refused', () => {
  const p = tmp();
  assert.throws(() => run(p, ['undo']), /nothing to undo/);
  assert.deepEqual(run(p, ['recent']).entries, []);
  assert.ok(!fs.existsSync(path.join(p, '.lab-scribe')));
  const q = tmp(), outside = tmp();
  fs.symlinkSync(outside, path.join(q, '.lab-scribe'), 'junction');
  assert.throws(() => run(q, ['init', '--doc', 'notes/x.md']), /link or not a folder/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('stdin is decoded once, and the helper runs through a linked folder', async () => {
  const p = setup();
  const r = await new Promise(res => {
    const c = spawn(process.execPath, [SCRIPT, 'add', '--doc', 'notes/log.md', '--kind', 'note', '--project', p]);
    let out = ''; c.stdout.on('data', d => (out += d)); c.on('close', () => res(out));
    const b = Buffer.from('Café ☕ result');
    c.stdin.write(b.subarray(0, 4)); // splits the é
    setTimeout(() => c.stdin.end(b.subarray(4)), 100);
  });
  assert.equal(JSON.parse(r).logged, true);
  assert.ok(read(p, 'notes/log.md').includes('Café ☕ result'));
  const d = tmp();
  fs.symlinkSync(path.dirname(SCRIPT), path.join(d, 'linked'), 'junction');
  const viaLink = spawnSync(process.execPath, [path.join(d, 'linked', 'scribe.mjs'), 'docs', '--project', p], { encoding: 'utf8' });
  assert.equal(JSON.parse(viaLink.stdout).active, true);
});

test('clean() keeps emoji, joiners, flags and RTL marks, and drops hidden runs', () => {
  const cp = String.fromCodePoint;
  const keep = `${cp(0x1f468, 0x200d, 0x1f469)} ${cp(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f)} שלום${cp(0x200f)} ${cp(0x2764, 0xfe0f)}`;
  assert.equal(clean(keep), keep);
  assert.equal(clean(`ok${cp(0xfe00).repeat(10)}`), `ok${cp(0xfe00)}`);
  assert.equal(clean(`a${cp(0xad)}b${cp(0x2062)}c${cp(0x2028)}d`), 'abc d');
});
