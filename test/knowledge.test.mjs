import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore, scopeForUrl } from '../src/knowledge.mjs';

async function temporaryStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'identificador-knowledge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'knowledge.json') };
}

test('only explicitly learned signatures become known, preserving input objects and order', async (t) => {
  const { path } = await temporaryStore(t);
  const store = await KnowledgeStore.open(path);
  const first = { id: 'b1', signature: 'signature-a', kind: 'button' };
  const second = { id: 'b2', signature: 'signature-b', kind: 'button' };
  const changed = { id: 'b1', signature: 'signature-c', kind: 'button' };

  assert.deepEqual(store.partition([first, second], 'game-a'), { known: [], unknown: [first, second] });
  store.learn([first], 'game-a');
  const partition = store.partition([second, first, changed], 'game-a');
  assert.deepEqual(partition, { known: [first], unknown: [second, changed] });
  assert.equal(partition.known[0], first);
  assert.equal(partition.unknown[0], second);
});

test('persistence contains only confirmed signature, scope and button kind', async (t) => {
  const { directory, path } = await temporaryStore(t);
  const store = await KnowledgeStore.open(path);
  const button = {
    id: 'ephemeral-id', signature: 'signature-a', kind: 'button',
    box: { x: 12, y: 5, width: 40, height: 30 },
    evidence: { url: 'https://game.test/play?token=PRIVATE', cookie: 'PRIVATE-COOKIE' },
  };
  store.learn([button, button], 'https://game.test/play#frame=0');
  await store.save();

  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    version: 1,
    entries: [{ scope: 'https://game.test/play#frame=0', signature: 'signature-a', kind: 'button' }],
  });
  assert.deepEqual(await readdir(directory), ['knowledge.json']);
  const reopened = await KnowledgeStore.open(path);
  const rediscovered = { id: 'new-id', signature: 'signature-a' };
  assert.deepEqual(reopened.partition([rediscovered], 'https://game.test/play#frame=0'), {
    known: [rediscovered], unknown: [],
  });
});

test('signatures remain isolated by scope without delimiter collisions', async (t) => {
  const { path } = await temporaryStore(t);
  const store = await KnowledgeStore.open(path);
  const button = { id: 'b1', signature: 'tail:signature', kind: 'button' };
  store.learn([button], 'https://game.test/play');
  assert.deepEqual(store.partition([button], 'https://other.test/play').unknown, [button]);
  const collision = { id: 'b2', signature: 'signature', kind: 'button' };
  assert.deepEqual(store.partition([collision], 'https://game.test/play:tail').unknown, [collision]);
  await store.save();
  const reopened = await KnowledgeStore.open(path);
  assert.deepEqual(reopened.partition([button], 'https://other.test/play').unknown, [button]);
});

test('a malformed confirmation batch learns nothing and invalid scopes are rejected', async (t) => {
  const { path } = await temporaryStore(t);
  const store = await KnowledgeStore.open(path);
  const button = { id: 'b1', signature: 'signature-a', kind: 'button' };
  assert.throws(() => store.learn([button, { id: 'b2', signature: '' }], 'game-a'), /signature/i);
  assert.deepEqual(store.partition([button], 'game-a').unknown, [button]);
  assert.throws(() => store.partition([button], ''), /scope/i);
  assert.throws(() => store.learn([button], null), /scope/i);
  assert.throws(() => store.partition({}, 'game-a'), /array/i);
  assert.throws(() => store.learn([{ signature: 's', kind: 'purchase' }], 'game-a'), /kind/i);
});

test('corrupt JSON produces a clear error and preserves the original bytes', async (t) => {
  const { path } = await temporaryStore(t);
  const content = '{"version":1,"entries":[BROKEN-PRIVATE-DATA';
  await writeFile(path, content);
  await assert.rejects(KnowledgeStore.open(path), (error) => {
    assert.match(error.message, /knowledge.*JSON|JSON.*knowledge/i);
    assert.doesNotMatch(error.message, /BROKEN-PRIVATE-DATA/);
    return true;
  });
  assert.equal(await readFile(path, 'utf8'), content);
});

test('invalid persisted schemas are rejected without replacing the file', async (t) => {
  const { path } = await temporaryStore(t);
  for (const content of [
    null,
    { version: 2, entries: [] },
    { version: 1, entries: {} },
    { version: 1, entries: [{ scope: 'game-a', signature: 17, kind: 'button' }] },
    { version: 1, entries: [{ scope: 'game-a', signature: 's', kind: 'purchase' }] },
    { version: 1, entries: [{ scope: 'game-a', signature: 's', kind: 'button', raw: 'private' }] },
  ]) {
    const original = JSON.stringify(content);
    await writeFile(path, original);
    await assert.rejects(KnowledgeStore.open(path), /knowledge|version|entries|scope|signature|kind|field/i);
    assert.equal(await readFile(path, 'utf8'), original);
  }
});

test('scopeForUrl strips credentials and URL session data while retaining game paths', () => {
  assert.equal(
    scopeForUrl('https://user:password@game.test:8443/gs2c/html5Game.do?token=PRIVATE#state'),
    'https://game.test:8443/gs2c/html5Game.do',
  );
  assert.notEqual(scopeForUrl('https://game.test/game-a'), scopeForUrl('https://game.test/game-b'));
  assert.equal(scopeForUrl('file:///tmp/demo.html?token=PRIVATE#menu'), 'file:///tmp/demo.html');
  assert.equal(scopeForUrl('about:blank#PRIVATE'), 'about:blank');
  assert.equal(scopeForUrl('data:text/html,PRIVATE'), 'data:');
  assert.throws(() => scopeForUrl('invalid PRIVATE url'), (error) => {
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
});
