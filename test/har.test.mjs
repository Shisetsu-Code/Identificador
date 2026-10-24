import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHar } from '../src/har.mjs';

function entry(url, { type = 'document', mimeType = 'text/html', status = 200, method = 'GET' } = {}) {
  return {
    _resourceType: type,
    request: {
      url, method, headers: [{ name: 'Cookie', value: 'PRIVATE-COOKIE' }],
      cookies: [{ name: 'session', value: 'PRIVATE-SESSION' }],
      postData: { text: 'PRIVATE-POST-BODY' },
    },
    response: {
      status, headers: [{ name: 'Set-Cookie', value: 'PRIVATE-SET-COOKIE' }],
      content: { mimeType, text: 'PRIVATE-RESPONSE-BODY' },
    },
  };
}

async function fixture(t, entries) {
  const directory = await mkdtemp(join(tmpdir(), 'identificador-har-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.har');
  await writeFile(path, JSON.stringify({ log: { version: '1.2', entries } }));
  return path;
}

test('selects the successful game document ahead of marketing and launcher redirects', async (t) => {
  const gameUrl = 'https://demo.test/gs2c/html5Game.do?token=PRIVATE-TOKEN#state';
  const path = await fixture(t, [
    entry('https://marketing.test/games/'),
    entry('https://demo.test/gs2c/openGame.do?token=PRIVATE-LAUNCHER', { status: 302 }),
    entry(gameUrl),
    entry('https://demo.test/game.js?cache=PRIVATE-CACHE', { type: 'script', mimeType: 'application/javascript' }),
  ]);
  const result = await readHar(path);
  assert.equal(result.entryUrl, gameUrl);
  assert.equal(result.summary.entries, 4);
  assert.equal(result.summary.documents, 3);
  assert.deepEqual(result.summary.entry, { host: 'demo.test', path: '/gs2c/html5Game.do' });
  assert.deepEqual(result.summary.hosts, [
    { host: 'demo.test', requests: 3 }, { host: 'marketing.test', requests: 1 },
  ]);
});

test('safe summary groups query variants without copying credentials, headers or bodies', async (t) => {
  const path = await fixture(t, [
    entry('https://user:PRIVATE-PASSWORD@game.test:8443/launcher/index.html?token=PRIVATE-A'),
    entry('https://game.test:8443/asset.js?token=PRIVATE-B', { type: 'script', mimeType: 'text/javascript' }),
    entry('https://game.test:8443/asset.js?token=PRIVATE-C', { type: 'script', mimeType: 'text/javascript' }),
  ]);
  const { summary } = await readHar(path);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE|user:|Cookie|postData|content|\?/);
  assert.deepEqual(summary.paths, [
    { host: 'game.test:8443', path: '/asset.js', requests: 2 },
    { host: 'game.test:8443', path: '/launcher/index.html', requests: 1 },
  ]);
});

test('uses HTML MIME information when a HAR has no browser resource type', async (t) => {
  const html = entry('https://game.test/start?token=PRIVATE', { mimeType: 'text/html; charset=utf-8' });
  delete html._resourceType;
  const path = await fixture(t, [
    entry('https://game.test/api', { type: 'xhr', mimeType: 'application/json' }), html,
  ]);
  assert.equal((await readHar(path)).entryUrl, 'https://game.test/start?token=PRIVATE');
});

test('prefers a launcher document and ignores a failing game response', async (t) => {
  const path = await fixture(t, [
    entry('https://marketing.test/'),
    entry('https://game.test/launcher/index.html?token=PRIVATE'),
    entry('https://game.test/gs2c/html5Game.do?token=PRIVATE', { status: 404 }),
  ]);
  assert.equal((await readHar(path)).entryUrl, 'https://game.test/launcher/index.html?token=PRIVATE');
});

test('does not expose data URL content in metadata', async (t) => {
  const path = await fixture(t, [
    entry('https://game.test/index.html'),
    entry('data:text/plain,PRIVATE-DATA', { type: 'other', mimeType: 'text/plain' }),
  ]);
  const { summary } = await readHar(path);
  assert.equal(summary.entries, 2);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE-DATA|text\/plain/);
  assert.deepEqual(summary.hosts, [{ host: 'game.test', requests: 1 }]);
});

test('rejects HARs without a replayable document instead of navigating to an asset or POST', async (t) => {
  for (const entries of [
    [],
    [entry('https://game.test/asset.js', { type: 'script', mimeType: 'text/javascript' })],
    [entry('https://game.test/start', { method: 'POST' })],
  ]) {
    const path = await fixture(t, entries);
    await assert.rejects(readHar(path), /HAR.*document|document.*HAR/i);
  }
});

test('rejects malformed HAR structures without leaking or changing their data', async (t) => {
  const path = await fixture(t, []);
  for (const content of [
    '{PRIVATE-BROKEN',
    JSON.stringify({ log: {} }),
    JSON.stringify({ log: { entries: [entry('invalid PRIVATE url')] } }),
    JSON.stringify({ log: { entries: [{ request: { url: 'https://game.test/' } }] } }),
  ]) {
    await writeFile(path, content);
    await assert.rejects(readHar(path), (error) => {
      assert.match(error.message, /HAR/);
      assert.doesNotMatch(error.message, /PRIVATE/);
      return true;
    });
    assert.equal(await readFile(path, 'utf8'), content);
  }
});
