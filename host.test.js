import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setupOracle } from './index.js';

function fixture(ssh, openBrowse) {
  const disposers = [];
  let route;
  const setup = setupOracle({
    effect(fn) { disposers.push(fn()); },
    webServer: { register(entry) { route = entry; return () => {}; } },
    connection: { requestRejection({headers}) { return headers.cookie === 'fixture' ? undefined : 401; } },
  }, ssh, openBrowse);
  async function request({cookie = 'fixture', marker = '1', method = 'GET', url = '/_oracle-dsh/read?snapshot=bogus'} = {}) {
    const res = new EventEmitter();
    let status, body;
    res.setHeader = () => {};
    res.writeHead = (value) => { status = value; };
    res.end = (value) => { body = JSON.parse(value); };
    await route.handler({method, url, headers: {cookie, 'x-oracle-dsh': marker}}, res);
    return {status, body};
  }
  return {request, ...setup, dispose() { disposers.reverse().forEach(fn => fn()); }};
}

test('requires DSH authentication before dispatch', async () => {
  const f = fixture();
  try { assert.equal((await f.request({cookie: '', url: '/_oracle-dsh/read?snapshot=overview'})).status, 401); }
  finally { f.dispose(); }
});

test('rejects foreign initiators and non-read requests before SSH', async () => {
  const f = fixture();
  try {
    assert.equal((await f.request({marker: '', url: '/_oracle-dsh/read?snapshot=overview'})).status, 403);
    assert.equal((await f.request({method: 'POST', url: '/_oracle-dsh/read?snapshot=overview'})).status, 405);
    assert.deepEqual(await f.request(), {status: 400, body: {ok: false, error: 'Unknown Oracle operation.'}});
  } finally { f.dispose(); }
});

test('Files roots are independent of chat home; disposal aborts work', async () => {
  const seen = [];
  const f = fixture({
    async list({path, cursor, signal}) {
      signal.throwIfAborted();
      seen.push(['chat-home', path, cursor]);
      return {path, entries: [], nextCursor: null};
    },
  }, root => ({
    async list({path, cursor, signal}) {
      signal.throwIfAborted();
      seen.push([root, path, cursor]);
      return {path, entries: [], nextCursor: null};
    },
  }));
  const url = '/_oracle-dsh/read?snapshot=list&path=project%20files&cursor=next';
  try {
    const api = await f.request({url});
    const other = await f.request({url: `${url}&root=%2Fvar%2Fwww%2F`});
    const tool = await f.execute('list', {path: 'project files', cursor: 'next', root: '/var/www'});
    assert.deepEqual(api, {status: 200, body: {ok: true, value: {...tool, browseRoot: '/home/ubuntu'}}});
    assert.deepEqual(other, {status: 200, body: {ok: true, value: {...tool, browseRoot: '/var/www'}}});
    assert.deepEqual(seen, [['/home/ubuntu', 'project files', 'next'], ['/var/www', 'project files', 'next'], ['chat-home', 'project files', 'next']]);
  } finally { f.dispose(); }
  assert.equal(f.signal.aborted, true);
  await assert.rejects(f.execute('list'), {name: 'AbortError'});
});

test('Files passes the chosen root to previews without changing chat', async () => {
  const preview = root => async ({path}) => ({path, text: root, sizeBytes: root.length, truncated: false});
  const f = fixture({preview: preview('chat-home')}, root => ({preview: preview(root)}));
  try {
    const result = await f.request({url: '/_oracle-dsh/read?snapshot=preview&root=%2Fvar%2Fwww&path=index.txt'});
    assert.deepEqual(result.body.value, {path: 'index.txt', text: '/var/www', sizeBytes: 8, truncated: false, browseRoot: '/var/www'});
    assert.equal((await f.execute('preview', {path: 'index.txt'})).text, 'chat-home');
  } finally { f.dispose(); }
});

test('overview forwards CPU usage and rejects a browse root', async () => {
  const value = {
    hostname: 'fixture', platform: 'Linux', cpuCount: 2, cpuUsagePercent: 12.5, uptimeSeconds: 60,
    loadAverage: [0.1, 0.2, 0.3], memory: {totalBytes: 2, availableBytes: 1},
    disk: {totalBytes: 4, availableBytes: 2}, scope: 'home',
  };
  const f = fixture({async overview() { return value; }});
  try {
    assert.deepEqual((await f.request({url: '/_oracle-dsh/read?snapshot=overview'})).body, {ok: true, value});
    assert.deepEqual((await f.execute('overview')).cpuUsagePercent, 12.5);
  } finally { f.dispose(); }
});

test('invalid or non-Files roots are rejected without starting SSH', async () => {
  let opened = false;
  const f = fixture({async overview() { opened = true; }}, () => { opened = true; });
  try {
    for (const root of ['etc', '/var/../etc', '/proc', '/home/ubuntu/.env', '/home/ubuntu/keys.pem']) {
      const result = await f.request({url: `/_oracle-dsh/read?snapshot=list&root=${encodeURIComponent(root)}`});
      assert.equal(result.status, 400, root);
    }
    assert.equal((await f.request({url: '/_oracle-dsh/read?snapshot=overview&root=%2F'})).status, 400);
    assert.equal(opened, false);
  } finally { f.dispose(); }
});
