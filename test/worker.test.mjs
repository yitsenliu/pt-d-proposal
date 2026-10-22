import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../cloudflare-worker/worker.js', import.meta.url), 'utf8');
const worker = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
const env = { ALLOWED_ORIGIN: 'https://yitsenliu.github.io', TURNSTILE_SECRET: 'private-bot-secret', GITHUB_TOKEN: 'private-github-token', GITHUB_OWNER: 'yitsenliu', GITHUB_REPO: 'pt-d-proposal' };
const valid = { editor: '劉羿岑 Yitsen', primary: '劉羿岑 Yitsen', partners: ['陳向柔 Naomi'], note: '完成', turnstileToken: 'widget-token' };
const botUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
function request(body = JSON.stringify(valid), options = {}) {
  return new Request(`https://worker.example${options.path || '/api/update'}`, {
    method: 'POST', headers: { Origin: env.ALLOWED_ORIGIN, 'Content-Type': 'application/json', ...options.headers }, body, ...options.init
  });
}
function upstream(t, { bot = { success: true, hostname: 'yitsenliu.github.io' }, githubStatus = 200 } = {}) {
  return t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.redirect, 'error');
    if (url === botUrl) return Response.json(bot);
    assert.equal(init.headers.Authorization, `Bearer ${env.GITHUB_TOKEN}`);
    if (githubStatus !== 200) return new Response('private-github-token upstream-internal-body', { status: githubStatus });
    if (init.method === 'PUT') return Response.json({ commit: {} });
    return Response.json({ sha: 'a'.repeat(40), content: Buffer.from('# D 組 121 完成紀錄\n\n| 日期 | 修改人 | 成員 A | 成員 B | 狀態 | 備註 |\n| --- | --- | --- | --- | --- | --- |\n').toString('base64') });
  });
}

test('existing public reads remain static GitHub Pages files and update URL matches frontend', async () => {
  const frontend = await readFile(new URL('../assets/121.js', import.meta.url), 'utf8');
  assert.match(frontend, /fetch\(`data\/121-log\.md/);
  assert.match(frontend, /fetch\("data\/members\.json/);
  const response = await worker.fetch(new Request('https://worker.example/api/records'), env);
  assert.equal(response.status, 404);
  assert.equal((await worker.fetch(new Request('https://worker.example/api/update'), env)).status, 403);
});

test('normal public update preserves GitHub storage, SHA and member record format without bearer login', async t => {
  const mock = upstream(t);
  const result = await worker.fetch(request(), env);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ok: true, updated: 1 });
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), env.ALLOWED_ORIGIN);
  const put = mock.mock.calls.find(call => call.arguments[1].method === 'PUT');
  assert.ok(put.arguments[0].includes('/repos/yitsenliu/pt-d-proposal/contents/data/121-log.md'));
  const payload = JSON.parse(put.arguments[1].body);
  assert.equal(payload.sha, 'a'.repeat(40));
  assert.match(Buffer.from(payload.content, 'base64').toString(), /劉羿岑 Yitsen \| 陳向柔 Naomi \| 完成 \| 完成/);
});

test('invalid JSON, schema, origin and actual oversized bytes never call upstream', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not call'); });
  for (const [body, options, status] of [
    ['{', {}, 400], ['null', {}, 400], ['[]', {}, 400], ['{}', {}, 400],
    [JSON.stringify({ ...valid, partners: [valid.primary] }), {}, 400],
    [JSON.stringify(valid), { headers: { Origin: 'https://evil.example' } }, 403],
    [JSON.stringify(valid), { headers: { 'Content-Type': 'text/plain' } }, 415],
    [' '.repeat(16385), { headers: { 'Content-Length': '1' } }, 413]
  ]) assert.equal((await worker.fetch(request(body, options), env)).status, status);
  assert.equal(mock.mock.callCount(), 0);
  const exact = JSON.stringify(valid) + ' '.repeat(16384 - Buffer.byteLength(JSON.stringify(valid)));
  mock.mock.restore();
  upstream(t);
  assert.equal((await worker.fetch(request(exact), env)).status, 200);
});

test('Turnstile requires strict success and expected hostname, but no action absent from existing frontend', async t => {
  for (const bot of [{ success: 'true', hostname: 'yitsenliu.github.io' }, { success: true, hostname: 'evil.example' }, { success: false }]) {
    const mock = upstream(t, { bot });
    assert.equal((await worker.fetch(request(), env)).status, 400);
    assert.equal(mock.mock.callCount(), 1);
    mock.mock.restore();
  }
});

test('upstream failures and missing settings conceal tokens, response bodies and configuration names', async t => {
  const mock = upstream(t, { githubStatus: 403 });
  const failed = await worker.fetch(request(), env);
  assert.equal(failed.status, 500);
  assert.doesNotMatch(await failed.text(), /private|upstream|token|GitHub HTTP/i);
  mock.mock.restore();
  const unset = await worker.fetch(request(), { ...env, TURNSTILE_SECRET: undefined });
  assert.equal(unset.status, 503);
  assert.doesNotMatch(await unset.text(), /TURNSTILE|GITHUB|secret/);
});

test('five-second deadline includes bot response body, Github headers and incoming stalled streams', async t => {
  const original = setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { assert.equal(ms, 5000); return original(fn, 1); });
  const stalled = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }));
  let mock = t.mock.method(globalThis, 'fetch', async () => stalled());
  assert.equal((await worker.fetch(request(), env)).status, 400);
  mock.mock.restore();
  mock = t.mock.method(globalThis, 'fetch', async url => url === botUrl ? Response.json({ success: true, hostname: 'yitsenliu.github.io' }) : new Promise(() => {}));
  assert.equal((await worker.fetch(request(), env)).status, 500);
  mock.mock.restore();
  const input = request(new ReadableStream({}), { init: { duplex: 'half' } });
  assert.equal((await worker.fetch(input, env)).status, 408);
});

test('GitHub race retries preserve storage; bad upstream JSON or oversized body returns concealed server error', async t => {
  let puts = 0;
  let mock = t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === botUrl) return Response.json({ success: true, hostname: 'yitsenliu.github.io' });
    if (init.method === 'PUT') return ++puts === 1 ? new Response('private conflict', { status: 409 }) : Response.json({ commit: {} });
    return Response.json({ sha: 'b'.repeat(40), content: Buffer.from('# log').toString('base64') });
  });
  assert.equal((await worker.fetch(request(), env)).status, 200);
  assert.equal(puts, 2);
  mock.mock.restore();
  for (const body of ['private-not-json', ' '.repeat(2 * 1024 * 1024 + 1)]) {
    mock = t.mock.method(globalThis, 'fetch', async url => url === botUrl
      ? Response.json({ success: true, hostname: 'yitsenliu.github.io' })
      : new Response(body, { headers: { 'Content-Length': '1' } }));
    const failed = await worker.fetch(request(), env);
    assert.equal(failed.status, 500);
    assert.doesNotMatch(await failed.text(), /private|16 KiB|token/i);
    mock.mock.restore();
  }
});
