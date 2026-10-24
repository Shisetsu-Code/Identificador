import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/identificador.mjs', import.meta.url));

function invoke(args) {
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 10_000, env,
  });
  assert.ifError(result.error);
  return result;
}

test('CLI help describes URL, offline HAR, observation, and explicit learning', () => {
  const result = invoke(['--help']);
  assert.equal(result.status, 0, result.stderr);
  for (const option of ['--url', '--har', '--demo', '--headless', '--seconds', '--output', '--learn', '--remember', '--scope', '--executable-path']) {
    assert.ok(result.stdout.includes(option), `Help should describe ${option}`);
  }
  assert.match(result.stdout, /clics|clicks/i);
});

test('CLI rejects invalid arguments before opening a browser', () => {
  for (const args of [
    ['--mystery'],
    ['--url'],
    ['--url', 'ftp://example.invalid/game'],
    ['--url', 'https://example.invalid', '--demo'],
    ['--har', 'game.har', '--url', 'https://example.invalid'],
    ['--seconds', '0'],
    ['--seconds', '-1'],
    ['--seconds', 'Infinity'],
    ['--seconds', 'no'],
    ['--scope', ''],
  ]) {
    const result = invoke(args);
    assert.equal(result.status, 1, `Expected rejection for ${args.join(' ')}; stderr=${result.stderr}`);
    assert.match(result.stderr, /error/i);
    assert.doesNotMatch(result.stderr, /at file:|node:internal|executable doesn't exist/i);
  }
});

test('CLI errors do not echo credentials or query values from a supplied URL', () => {
  const secret = 'session-secret-should-not-appear';
  const result = invoke(['--url', `https://user:${secret}@example.invalid/game?token=${secret}`]);
  assert.equal(result.status, 1);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
});
