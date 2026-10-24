import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { run, observePage } from '../src/runner.mjs';
import { KnowledgeStore } from '../src/knowledge.mjs';

const executablePath = process.env.IDENTIFICADOR_BROWSER_PATH || chromium.executablePath();
const hasBrowser = await access(executablePath).then(() => true, () => false);
const browserOptions = { headless: true, executablePath };
const browserTest = { skip: !hasBrowser && !process.env.IDENTIFICADOR_BROWSER_PATH && 'Install Chromium with npx playwright install chromium or set IDENTIFICADOR_BROWSER_PATH' };

async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'identificador-runner-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function fixture(t) {
  let clicks = 0;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url.startsWith('/clicked')) {
      clicks++;
      response.end('clicked');
    } else if (request.url.startsWith('/frame')) {
      response.end('<!doctype html><button id="other">Secondary</button>');
    } else {
      response.end(`<!doctype html><html><body>
        <button id="first" onclick="fetch('/clicked')">Arbitrary A</button>
        <button id="hidden" hidden>Invisible</button>
        <iframe src="/frame?token=private-frame-token"></iframe>
        <script>setTimeout(() => {
          const button = document.createElement('button');
          button.id = 'dynamic'; button.textContent = 'Arbitrary B';
          document.body.appendChild(button);
        }, 50);</script>
      </body></html>`);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/game?token=private-main-token#private-fragment`, clicks: () => clicks };
}

test('run exports separate frames, sanitizes URLs, and never clicks detected buttons', browserTest, async t => {
  const output = await temporary(t);
  const site = await fixture(t);
  const result = await run({ url: site.url, headless: true, seconds: 0.35, intervalMs: 50, output, executablePath });
  const snapshot = JSON.parse(await readFile(join(output, 'all.json'), 'utf8'));
  const unknown = JSON.parse(await readFile(join(output, 'unknown.json'), 'utf8'));

  assert.equal(snapshot.frames.length, 2);
  assert.equal(snapshot.totals.buttons, 3);
  assert.equal(snapshot.totals.known, 0);
  assert.equal(snapshot.totals.unknown, 3);
  assert.deepEqual(snapshot.frames.map(frame => frame.id), ['0', '0.0']);
  assert.notEqual(snapshot.frames[0].scope, snapshot.frames[1].scope);
  assert.ok(snapshot.frames.every(frame => frame.buttons.every(button => button.kind === 'button')));
  assert.doesNotMatch(JSON.stringify(snapshot), /private-main-token|private-frame-token|private-fragment/);
  assert.equal(unknown.frames.reduce((sum, frame) => sum + frame.buttons.length, 0), 3);
  assert.ok(unknown.frames.every(frame => !('known' in frame)));
  assert.equal(site.clicks(), 0);
  assert.equal(result.snapshot.totals.buttons, 3);
  await access(join(output, 'overlay.png'));
});

test('explicit remember makes a later capture in the same game known', browserTest, async t => {
  const output = await temporary(t);
  const site = await fixture(t);
  const options = { url: site.url, headless: true, seconds: 0.2, output, executablePath, screenshot: false };
  await run({ ...options, remember: true, scope: 'test-game' });
  const repeated = await run({ ...options, scope: 'test-game' });
  assert.equal(repeated.snapshot.totals.unknown, 0);
  assert.equal(repeated.snapshot.totals.known, 3);
  const otherGame = await run({ ...options, scope: 'different-game' });
  assert.equal(otherGame.snapshot.totals.unknown, 3);
});

test('observePage preserves the last successful capture when the user closes the window', browserTest, async t => {
  const output = await temporary(t);
  const browser = await chromium.launch(browserOptions);
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<button>Still captured</button>');
  const store = await KnowledgeStore.open(join(output, 'knowledge.json'));
  let captured = false;
  const snapshot = await observePage(page, store, {
    intervalMs: 30,
    onSnapshot: async current => {
      if (!captured && current.totals.buttons === 1) {
        captured = true;
        await page.close();
      }
    },
  });
  assert.equal(captured, true);
  assert.equal(snapshot.totals.buttons, 1);
  assert.equal(snapshot.frames.length, 1);
});

test('observePage tolerates a window closed before observation can start', browserTest, async t => {
  const output = await temporary(t);
  const browser = await chromium.launch(browserOptions);
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.close();
  const store = await KnowledgeStore.open(join(output, 'knowledge.json'));
  const snapshot = await observePage(page, store);
  assert.equal(snapshot.totals.buttons, 0);
  assert.deepEqual(snapshot.frames, []);
});

test('learning accepts exported frame scopes without starting a browser', async t => {
  const output = await temporary(t);
  const input = join(output, 'confirmed.json');
  await writeFile(input, JSON.stringify({ frames: [{ scope: 'game-a', buttons: [{ signature: 'first', kind: 'button' }] }] }));
  const result = await run({ learn: input, output });
  const store = await KnowledgeStore.open(join(output, 'knowledge.json'));
  assert.equal(store.partition([{ signature: 'first' }], 'game-a').known.length, 1);
  assert.equal(store.partition([{ signature: 'first' }], 'game-b').unknown.length, 1);
  assert.equal(result.learned, 1);
});

test('learning rejects bare signatures without a game scope', async t => {
  const output = await temporary(t);
  const input = join(output, 'ambiguous.json');
  await writeFile(input, JSON.stringify([{ signature: 'first', kind: 'button' }]));
  await assert.rejects(run({ learn: input, output }), /scope|contexto/i);
});

test('HAR replay serves captured documents and aborts uncaptured network requests', browserTest, async t => {
  const output = await temporary(t);
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('unexpected network'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const har = join(output, 'fixture.har');
  await writeFile(har, JSON.stringify({ log: {
    version: '1.2', creator: { name: 'test', version: '1' },
    entries: [{ startedDateTime: new Date().toISOString(), time: 1,
      _resourceType: 'document',
      request: { method: 'GET', url: `${origin}/captured`, httpVersion: 'HTTP/1.1', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
      response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [{ name: 'Content-Type', value: 'text/html' }], cookies: [], redirectURL: '', headersSize: -1, bodySize: -1,
        content: { mimeType: 'text/html', size: 100, text: `<button>Offline button</button><script src="${origin}/missing.js"></script>` } },
      cache: {}, timings: { send: 0, wait: 1, receive: 0 },
    }],
  } }));
  const result = await run({ har, output, headless: true, seconds: 0.15, executablePath, screenshot: false });
  assert.equal(result.snapshot.totals.buttons, 1);
  assert.equal(requests, 0);
  assert.ok(result.warnings.some(warning => /HAR|offline/i.test(warning)), 'Missing resources must be reported');
  assert.ok(result.snapshot.warnings.length, 'Diagnostics should survive in exported JSON');
});

test('run follows a newly opened game window without clicking its launcher', browserTest, async t => {
  const output = await temporary(t);
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url.startsWith('/opened')
      ? '<button>Game control A</button><button>Game control B</button>'
      : '<button>Launcher</button><script>setTimeout(() => window.open("/opened?token=private-popup-token"), 80)</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const result = await run({ url: `${origin}/launcher`, output, headless: true, seconds: 0.4, intervalMs: 30, executablePath, screenshot: false });
  assert.equal(result.snapshot.totals.buttons, 2);
  assert.equal(result.snapshot.frames[0].url, `${origin}/opened`);
  assert.doesNotMatch(JSON.stringify(result.snapshot), /private-popup-token/);
});

test('game symbols separate identical controls on a shared launcher path', browserTest, async t => {
  const output = await temporary(t);
  const site = await fixture(t);
  const sharedPath = site.url.replace('/game?token=private-main-token#private-fragment', '/html5Game.do');
  const options = { headless: true, seconds: 0.12, output, executablePath, screenshot: false };
  await run({ ...options, url: `${sharedPath}?symbol=game_alpha&token=secret-alpha`, remember: true });
  const same = await run({ ...options, url: `${sharedPath}?symbol=game_alpha&token=another-token` });
  assert.equal(same.snapshot.totals.unknown, 0);
  const different = await run({ ...options, url: `${sharedPath}?symbol=game_beta&token=secret-beta` });
  assert.equal(different.snapshot.totals.unknown, 3);
  assert.notEqual(same.snapshot.frames[0].scope, different.snapshot.frames[0].scope);
  assert.doesNotMatch(JSON.stringify(different.snapshot), /secret-beta|token=/);
});

test('does not export or remember controls hidden by an ancestor frame or parent overlay',browserTest,async t=>{
 const output=await temporary(t);const browser=await chromium.launch(browserOptions);t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1000,height:700}});
 await page.setContent(`<button>Main</button>
 <iframe style="position:absolute;left:0;top:80px;opacity:0" srcdoc="<button>Transparent</button>"></iframe>
 <iframe style="position:absolute;left:350px;top:80px" srcdoc="<button>Covered</button>"></iframe>
 <div style="position:absolute;left:350px;top:80px;width:310px;height:160px;background:black;z-index:5"></div>
 <iframe style="position:absolute;left:0;top:300px;transform:scale(.75);transform-origin:top left" srcdoc="<button>Visible</button>"></iframe>`);
 const store=await KnowledgeStore.open(join(output,'knowledge.json'));
 const result=await observePage(page,store,{seconds:.1,intervalMs:30});
 assert.equal(result.totals.buttons,2);
 assert.equal(result.frames[1].buttons.length,0);assert.equal(result.frames[2].buttons.length,0);assert.equal(result.frames[3].buttons.length,1);
 for(const frame of result.frames)store.learn(frame.buttons,frame.scope);
 await store.save();const saved=JSON.parse(await readFile(join(output,'knowledge.json'),'utf8'));assert.equal(saved.entries.length,2);
});
