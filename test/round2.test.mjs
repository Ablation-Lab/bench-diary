// Regression tests for Lab Scribe recheck 1 (council round 2).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand, parseArgs, resolveDoc, insertEntry, removeEntry } from '../plugin/skills/lab-scribe/scripts/scribe.mjs';

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-scribe-r2-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const run = (p, argv, input = '') => runCommand({ ...parseArgs(argv), project: p }, input);
const cp = String.fromCodePoint;

test('N2: curly and other quotation marks are refused in doc names', () => {
  const p = tmp();
  for (const q of [0x2018, 0x2019, 0x201a, 0x201b, 0x201c, 0x201d, 0x201e, 0xab, 0xbb, 0x2039, 0x203a])
    assert.throws(() => resolveDoc(p, `notes/lab${cp(q)} (Set-Content x) ${cp(q)}notes.md`), /can't contain/, q.toString(16));
  fs.writeFileSync(path.join(p, 'lab-scribe.json'), JSON.stringify({ docs: [{ path: `notes/lab${cp(0x2019)} (Set-Content -Path PWNED.txt -Value ran) ${cp(0x2019)}notes.md` }] }));
  const d = run(p, ['docs']);
  assert.deepEqual(d.docs, []);
  assert.equal(d.invalid.length, 1);
});

test('N1/N4: a marker copied in with the project, or a changed doc list, needs the user\'s OK again', () => {
  const src = tmp();
  run(src, ['init', '--doc', 'notes/log.md']);
  const dst = tmp();
  fs.cpSync(src, dst, { recursive: true });
  assert.equal(run(dst, ['docs']).setUpHere, false, 'the copied marker is tied to the other folder');
  assert.throws(() => run(dst, ['add', '--doc', 'notes/log.md', '--kind', 'note'], 'x'), /confirmed/);
  run(dst, ['enable']);
  assert.equal(run(dst, ['add', '--doc', 'notes/log.md', '--kind', 'note'], 'x').logged, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(dst, 'lab-scribe.json'), 'utf8'));
  cfg.docs.push({ path: 'notes/new.md' });
  fs.writeFileSync(path.join(dst, 'lab-scribe.json'), JSON.stringify(cfg));
  assert.equal(run(dst, ['docs']).setUpHere, false, 'a new doc in the list needs a new OK');
});

test('N5: init on a config that came with the project is refused until enable', () => {
  const p = tmp();
  fs.writeFileSync(path.join(p, 'lab-scribe.json'), JSON.stringify({ docs: [{ path: 'docs/index.md' }] }));
  assert.throws(() => run(p, ['init', '--doc', 'notes/mine.md']), /came with a lab-scribe\.json listing docs\/index\.md/);
  run(p, ['enable']);
  run(p, ['init', '--doc', 'notes/mine.md']);
  assert.equal(run(p, ['docs']).setUpHere, true);
});

test('N3: init keeps the rest of lab-scribe.json as it was', () => {
  const p = setupRaw();
  const raw = { note: 'kept', docs: [{ path: "notes/Bob's notes.md", extra: 1 }, { path: 'notes/a.md', topics: ['x'], colour: 'blue' }], defaultDoc: 'notes/a.md' };
  fs.writeFileSync(path.join(p, 'lab-scribe.json'), JSON.stringify(raw));
  run(p, ['enable']);
  run(p, ['init', '--doc', 'notes/b.md', '--topics', 'y']);
  const out = JSON.parse(fs.readFileSync(path.join(p, 'lab-scribe.json'), 'utf8'));
  assert.equal(out.note, 'kept');
  assert.equal(out.defaultDoc, 'notes/a.md');
  assert.deepEqual(out.docs.slice(0, 2), raw.docs, 'existing entries, even refused ones, kept unchanged');
  assert.deepEqual(out.docs[2], { path: 'notes/b.md', topics: ['y'], description: '' });
});
function setupRaw() { const p = tmp(); fs.mkdirSync(path.join(p, 'notes')); return p; }

test('N6: an open fence is closed with its own marker; undo still finds an entry after an unclosed fence', () => {
  const out = insertEntry('# T\n\n```js\nx\n```\n\n~~~~\nopen code\n', ['- e']);
  assert.match(out, /open code\n~~~~\n\n## Research log\n\n- e\n$/);
  const doc = '# T\n\n```\nunclosed\n\n## Research log\n\n- **x · Note** · e (log id: abc123)\n';
  assert.equal(removeEntry(doc, 'abc123').includes('abc123'), false);
});

test('N7: joiners and ordinary tildes are fine in names; real short names are not', () => {
  const p = tmp();
  for (const good of [`notes/می${cp(0x200c)}خواهم.md`, 'notes/2026~1 recap.md', 'notes/v~2 draft notes.md', 'notes/~draft.md'])
    assert.equal(resolveDoc(p, good).rel, good, good);
  for (const bad of ['NOTES~1/x.md', 'notes/RESEAR~1.MD', 'CLAUDE~2.MD'])
    assert.throws(() => resolveDoc(p, bad), /short name/, bad);
});

test('N7: an old journal row whose doc is now refused is marked undone, not retried forever', () => {
  const p = tmp();
  run(p, ['init', '--doc', 'notes/log.md']);
  fs.appendFileSync(path.join(p, '.lab-scribe/journal.jsonl'), JSON.stringify({ id: 'abcdef', doc: "notes/it's.md", kind: 'note', time: new Date().toISOString() }) + '\n');
  const u = run(p, ['undo']);
  assert.equal(u.removed, false);
  assert.throws(() => run(p, ['undo']), /nothing to undo/);
});

test('N9: a project on a drive or folder that does not exist fails at once', () => {
  const t0 = Date.now();
  assert.throws(() => resolveDoc(path.join(tmp(), 'missing', 'project'), 'notes/a.md'), /doesn't exist/);
  if (process.platform === 'win32') assert.throws(() => resolveDoc('Q:/nowhere/project', 'notes/a.md'), /doesn't exist/);
  assert.ok(Date.now() - t0 < 2000);
});
