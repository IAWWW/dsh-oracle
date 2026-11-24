import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {installOracleChat, MAX_SESSIONS} from './chat.js';

const req = {method: 'POST', headers: {'x-oracle-dsh': '1'}};
const newReq = {method: 'POST', url: '/api/oracle-dsh/chat?new=1', headers: {'x-oracle-dsh': '1'}};

class Response extends EventEmitter {
  text = '';
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }
  write(text) { this.text += text; return true; }
  end(text = '') { this.text += text; this.writableEnded = true; this.emit('close'); }
  setHeader(name, value) { this[name] = value; }
}

function fixture(runner, options = {}) {
  let clock = 1_000_000;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-state-'));
  const fx = {
    stateFile: path.join(stateDir, 'state.json'),
    resumed: [], resumeAttempts: 0, rejectResume: false,
    created: 0, disposed: 0, disposedIds: [], ids: [], calls: [], listeners: new Map(),
    toolsByName: new Map(), guards: new Map(), masks: [], cwds: [], registry: undefined,
  };
  const ctx = {
    effect(fn) { fx.dispose = fn(); },
    get(name) { return name === 'workspaceRegistry' ? fx.registry : undefined; },
    on(event, fn) { fx.listeners.set(event, fn); return () => fx.listeners.delete(event); },
    tools: {guard(fn) { fx.hostGuard = fn; return () => {}; }},
    connection: {requestRejection: input => input.denied ? 401 : undefined},
    webServer: {register(entry) { fx.route = entry; return () => {}; }},
    agentPresets: {
      mount: async (_agentCtx, preset) => { assert.equal(preset, 'oracle-dsh'); },
      presetForSession: () => 'standard',
    },
    agents: {
      async create(options) {
        fx.created++;
        fx.cwds.push(options.meta?.cwd);
        return await publish(options, options.sessionId);
      },
      async resume(options) {
        fx.resumeAttempts += 1;
        if (fx.rejectResume) throw new Error('transcript unavailable');
        fx.resumed.push(options.resumeSessionId);
        return await publish(options, options.resumeSessionId);
      },
    },
  };
  async function publish(options, sessionId) {
      const agentCtx = {tools: {
        restrict(mask) { fx.masks.push(mask); return () => {}; },
        guard(fn) { fx.guards.set(agent, fn); return () => {}; },
        register(tool) { fx.toolsByName.set(tool.name, tool); return () => {}; },
      }};
      const agent = {id: sessionId, ctx: agentCtx, session: {header: options.meta ?? {agentPreset: 'oracle-dsh'}}};
      await options.setup(agentCtx, agent);
      fx.listeners.get('agent/created')?.({agent});
      fx.agent = agent;
      fx.ids.push(sessionId);
      return {agent, async dispose() {
        fx.disposed++;
        fx.disposedIds.push(sessionId);
        fx.listeners.get('agent/disposed')?.({agent});
      }};
  }
  fx.advance = ms => { clock += ms; };
  installOracleChat(ctx, async (op, call) => {
    fx.calls.push({op, ...call});
    return {op};
  }, new AbortController().signal, runner, {...options, now: () => clock, stateFile: options.stateFile ?? fx.stateFile});
  const inner = fx.dispose;
  fx.dispose = async () => {
    try { await inner?.(); } finally { fs.rmSync(stateDir, {recursive: true, force: true}); }
  };
  return fx;
}

async function request(fx, input = req) {
  const response = new Response();
  await fx.route.handler(input, response);
  return response;
}

test('Oracle session starts only on a bodyless authenticated POST', async () => {
  const fx = fixture();
  try {
    assert.equal(fx.route.path, '/api/oracle-dsh/chat');
    assert.equal((await request(fx, {...req, denied: true})).status, 401);
    assert.equal((await request(fx, {...req, headers: {}})).status, 403);
    assert.equal((await request(fx, {...req, method: 'GET'})).status, 405);
    assert.equal((await request(fx, {...req, headers: {...req.headers, 'content-length': '1'}})).status, 400);
    assert.equal(fx.created, 0);
  } finally {
    await fx.dispose();
  }
});

test('concurrent pages share one Agent and the answer is a single small reply', async () => {
  const fx = fixture();
  try {
    const [one, two] = await Promise.all([request(fx), request(fx)]);
    assert.equal(one.status, 200);
    assert.match(one.headers['Content-Type'], /^application\/json/);
    assert.deepEqual(JSON.parse(one.text), {sessionId: fx.agent.id, tools: ['oracle_snapshot']});
    assert.equal(one.text, two.text);
    assert.equal(fx.created, 1);
    assert.deepEqual(fx.masks[0], {allow: []});
    const exec = {agent: fx.agent, name: 'oracle_snapshot', signal: new AbortController().signal};
    assert.equal(fx.guards.get(fx.agent)(exec), undefined);
    assert.match(fx.guards.get(fx.agent)({...exec, name: 'bash'}), /other tools/);
    assert.equal(fx.hostGuard(exec), undefined);
    assert.match(fx.hostGuard({...exec, name: 'bash'}), /other tools/);
    await assert.rejects(fx.toolsByName.get('oracle_snapshot').execute({snapshot: 'overview'}, {...exec, agent: {}}), /other tools/);
    await assert.rejects(fx.toolsByName.get('oracle_snapshot').execute({snapshot: 'preview'}, exec), /Use overview/);
    assert.equal(await fx.toolsByName.get('oracle_snapshot').execute({snapshot: 'overview'}, exec), '{"op":"overview"}');
    assert.equal(fx.calls.length, 1);
    // The tool set is the boundary, not a socket: there is nothing to keep open.
    assert.equal(fx.calls[0].signal.aborted, false);
    assert.equal(fx.guards.get(fx.agent)(exec), undefined);
    assert.equal(fx.hostGuard(exec), undefined);
    assert.equal(await fx.toolsByName.get('oracle_snapshot').execute({snapshot: 'overview'}, exec), '{"op":"overview"}');
    assert.deepEqual(JSON.parse((await request(fx)).text), {sessionId: fx.agent.id, tools: ['oracle_snapshot']});
    assert.equal(fx.created, 1);
  } finally {
    await fx.dispose();
  }
  assert.equal(fx.disposed, 1);
});

test('a new-chat request opens a fresh transcript without disturbing the current one', async () => {
  const fx = fixture();
  try {
    const first = await request(fx);
    const firstAgent = fx.agent;
    const second = await request(fx, newReq);
    const secondAgent = fx.agent;
    assert.equal(fx.created, 2);
    assert.notEqual(firstAgent.id, secondAgent.id);
    assert.deepEqual(JSON.parse(second.text), {sessionId: secondAgent.id, tools: ['oracle_snapshot']});
    // The first page keeps its own lease and its own tool gate.
    assert.equal(fx.guards.get(firstAgent)({agent: firstAgent, name: 'oracle_snapshot'}), undefined);
    assert.equal(fx.guards.get(secondAgent)({agent: secondAgent, name: 'oracle_snapshot'}), undefined);
    // A plain open now reuses the newer transcript.
    first.end();
    const third = await request(fx);
    assert.deepEqual(JSON.parse(third.text), {sessionId: secondAgent.id, tools: ['oracle_snapshot']});
    assert.equal(fx.created, 2);
    // The older transcript keeps its tools while it stays open.
    assert.equal(fx.guards.get(firstAgent)({agent: firstAgent, name: 'oracle_snapshot'}), undefined);
    second.end();
    third.end();
    assert.equal(fx.calls.length, 0);
  } finally {
    await fx.dispose();
  }
  assert.deepEqual(fx.disposedIds.sort(), [fx.ids[0], fx.ids[1]].sort());
});

test('idle transcripts are closed before the retained set overflows', async () => {
  const fx = fixture();
  try {
    for (let index = 0; index < MAX_SESSIONS; index += 1) {
      const response = await request(fx, newReq);
      assert.equal(response.status, 200);
      response.end();
    }
    assert.equal(fx.created, MAX_SESSIONS);
    assert.deepEqual(fx.disposedIds, []);
    const extra = await request(fx, newReq);
    assert.equal(extra.status, 200);
    assert.equal(fx.created, MAX_SESSIONS + 1);
    assert.deepEqual(fx.disposedIds, [fx.ids[0]]);
    assert.equal(fx.ids.length, MAX_SESSIONS + 1);
    extra.end();
  } finally {
    await fx.dispose();
  }
});

test('a page lease also authorizes shell commands, and only through its own tool', async () => {
  const seen = [];
  const fx = fixture(async ({command, timeoutMs, signal}) => {
    seen.push({command, timeoutMs, aborted: signal.aborted});
    return {
      command, exitCode: 0, stdout: 'ok\n', stderr: '', stdoutTruncated: false,
      stderrTruncated: false, durationMs: 1, timedOut: false,
    };
  });
  try {
    const page = await request(fx);
    assert.deepEqual(JSON.parse(page.text).tools, ['oracle_snapshot', 'oracle_exec']);
    const agent = fx.agent;
    const execTool = fx.toolsByName.get('oracle_exec');
    assert.ok(execTool, 'the command tool is registered');
    const exec = {agent, name: 'oracle_exec', signal: new AbortController().signal};
    assert.equal(fx.guards.get(agent)(exec), undefined);
    assert.equal(fx.hostGuard(exec), undefined);
    assert.match(fx.guards.get(agent)({...exec, name: 'bash'}), /other tools/);
    assert.match(fx.hostGuard({...exec, name: 'bash'}), /other tools/);

    const result = JSON.parse(await execTool.execute({command: 'uname -a', timeoutMs: 5000}, exec));
    assert.equal(result.exitCode, 0);
    assert.deepEqual(seen, [{command: 'uname -a', timeoutMs: 5000, aborted: false}]);

    await assert.rejects(execTool.execute({command: ''}, exec), /Provide the shell command/);
    await assert.rejects(execTool.execute({command: 'true', timeoutMs: 10}, exec), /timeoutMs/);
    await assert.rejects(execTool.execute({command: 'true', shell: 'zsh'}, exec), /Invalid Oracle command/);
    await assert.rejects(execTool.execute({command: 'true'}, {...exec, agent: {}}), /other tools/);
    assert.equal(seen.length, 1);

    page.end();
    // Closing the page neither cancels the work nor withdraws the tool.
    assert.equal(JSON.parse(await execTool.execute({command: 'true'}, exec)).exitCode, 0);
  } finally {
    await fx.dispose();
  }
});

test('without a command runner the chat exposes only the snapshot tool', async () => {
  const fx = fixture();
  try {
    await request(fx);
    assert.equal(fx.toolsByName.has('oracle_exec'), false);
    assert.match(fx.guards.get(fx.agent)({agent: fx.agent, name: 'oracle_exec'}), /other tools/);
  } finally {
    await fx.dispose();
  }
});

test('unloading the plugin, and only that, aborts a running command', async () => {
  let captured;
  const fx = fixture(async ({command, signal}) => {
    captured = signal;
    return {
      command, exitCode: 0, stdout: '', stderr: '', stdoutTruncated: false,
      stderrTruncated: false, durationMs: 1, timedOut: false,
    };
  });
  const page = await request(fx);
  const exec = {agent: fx.agent, name: 'oracle_exec', signal: new AbortController().signal};
  await fx.toolsByName.get('oracle_exec').execute({command: 'sleep 30'}, exec);
  assert.equal(captured.aborted, false);
  assert.equal(JSON.parse(page.text).sessionId, fx.agent.id);
  await fx.dispose();
  assert.equal(captured.aborted, true, 'unloading the plugin stops work in flight');
});

test('a restart continues the remembered transcript instead of starting over', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-persist-'));
  const stateFile = path.join(dir, 'state.json');
  const first = fixture(undefined, {stateFile});
  let id;
  try {
    const page = await request(first);
    id = JSON.parse(page.text).sessionId;
    page.end();
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessionId, id);
  } finally {
    await first.dispose();
  }
  const second = fixture(undefined, {stateFile});
  try {
    const page = await request(second);
    assert.deepEqual(second.resumed, [id]);
    assert.equal(second.created, 0, 'the remembered transcript is resumed, not recreated');
    assert.deepEqual(JSON.parse(page.text), {sessionId: id, tools: ['oracle_snapshot']});
    page.end();
  } finally {
    await second.dispose();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('an unusable pointer falls back to a fresh transcript and clears itself', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-persist-'));
  const stateFile = path.join(dir, 'state.json');
  const seed = fixture(undefined, {stateFile});
  let dead;
  try {
    const page = await request(seed);
    dead = JSON.parse(page.text).sessionId;
    page.end();
  } finally {
    await seed.dispose();
  }
  const next = fixture(undefined, {stateFile});
  next.rejectResume = true;
  try {
    const page = await request(next);
    assert.equal(next.resumeAttempts, 1, 'the pointer is tried first');
    assert.equal(next.created, 1, 'then a fresh transcript is started');
    const fresh = JSON.parse(page.text).sessionId;
    assert.notEqual(fresh, dead);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessionId, fresh, 'the pointer moves to the new chat');
    page.end();
  } finally {
    await next.dispose();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('a new chat replaces the remembered pointer', async () => {
  const fx = fixture();
  try {
    const first = await request(fx);
    const firstId = JSON.parse(first.text).sessionId;
    const second = await request(fx, newReq);
    const secondId = JSON.parse(second.text).sessionId;
    assert.notEqual(firstId, secondId);
    assert.equal(JSON.parse(fs.readFileSync(fx.stateFile, 'utf8')).sessionId, secondId);
    first.end();
    second.end();
  } finally {
    await fx.dispose();
  }
});

test('chats group under one Oracle workspace and record their session', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-workspace-'));
  const attaches = [];
  let created = 0;
  const fx = fixture(undefined, {workspaceDirectory: path.join(directory, 'oracle')});
  fx.registry = {
    async create(given, title) {
      assert.equal(title, 'Oracle');
      assert.ok(fs.statSync(given).isDirectory(), 'the group directory exists before registration');
      created += 1;
      return {id: 'workspace-oracle', path: path.resolve(given), async attachSession(id) { attaches.push(id); }};
    },
  };
  try {
    const first = await request(fx);
    const firstId = JSON.parse(first.text).sessionId;
    assert.equal(fx.created, 1);
    assert.equal(created, 1);
    assert.equal(fx.cwds[0], path.resolve(path.join(directory, 'oracle')));
    assert.deepEqual(attaches, [firstId]);

    const second = await request(fx, newReq);
    const secondId = JSON.parse(second.text).sessionId;
    assert.notEqual(firstId, secondId);
    assert.equal(fx.created, 2);
    assert.equal(created, 1, 'the workspace is reused, never duplicated');
    assert.deepEqual(attaches, [firstId, secondId]);
    assert.deepEqual(fx.cwds, [path.resolve(path.join(directory, 'oracle')), path.resolve(path.join(directory, 'oracle'))]);
    first.end();
    second.end();
  } finally {
    await fx.dispose();
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('without a workspace registry the chat still runs in some directory', async () => {
  const fx = fixture();
  try {
    await request(fx);
    assert.equal(fx.cwds[0], process.cwd());
  } finally {
    await fx.dispose();
  }
});

test('a transcript reopened from the sidebar list keeps Oracle tools and nothing else', async () => {
  const fx = fixture(async ({command}) => ({
    command, exitCode: 0, stdout: 'ok\n', stderr: '', stdoutTruncated: false,
    stderrTruncated: false, durationMs: 1, timedOut: false,
  }));
  try {
    const restrictions = [];
    const registered = [];
    const stock = {session: {header: {agentPreset: 'oracle-dsh'}}, ctx: {tools: {
      restrict(mask) { restrictions.push(mask); return () => { restrictions.push('disposed'); }; },
      guard() { return () => {}; },
      register(tool) { registered.push(tool.name); return () => {}; },
    }}};
    const ordinary = {session: {header: {agentPreset: 'standard'}}};
    fx.listeners.get('agent/created')({agent: stock});
    fx.listeners.get('agent/created')({agent: ordinary});
    assert.deepEqual(restrictions, [{allow: []}], 'inherited tools are masked for Oracle sessions');
    assert.deepEqual(registered, ['oracle_snapshot', 'oracle_exec'], 'and the Oracle tools are added back');
    assert.equal(fx.hostGuard({agent: stock, name: 'oracle_exec'}), undefined);
    assert.match(fx.hostGuard({agent: stock, name: 'bash'}), /other tools/);
    assert.equal(fx.hostGuard({agent: ordinary, name: 'bash'}), undefined);
    fx.listeners.get('agent/disposed')({agent: stock});
    assert.deepEqual(restrictions, [{allow: []}, 'disposed']);
  } finally {
    await fx.dispose();
  }
});
