'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createOracleExec } = require('./exec.cjs');

function fake(perform, config = {}) {
  const calls = [];
  const runner = createOracleExec({ ...config, execFileImpl(executable, args, options, callback) {
    calls.push({ executable, args, options });
    perform({ executable, args, options, callback });
  } });
  return { runner, calls };
}

test('runs through the fixed hardened alias without any local shell', async () => {
  const command = "ps aux --sort=-rss | head -3; echo \"$HOME\"";
  const { runner, calls } = fake(({ callback }) => callback(null, 'ok\n', ''));
  const result = await runner.run({ command });
  const [{ executable, args, options }] = calls;
  assert.equal(executable, '/usr/bin/ssh');
  assert.deepEqual(args.slice(0, 2), ['-T', '-n']);
  assert.deepEqual(args.slice(-3, -1), ['--', 'oracle']);
  // The command is one argv entry, never interpolated into a local shell.
  assert.equal(args.at(-1), command);
  assert.equal(options.shell, false);
  for (const flag of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ClearAllForwardings=yes',
    'ForwardAgent=no', 'ControlMaster=no', 'ProxyCommand=none', 'ProxyJump=none']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'ok\n');
  assert.equal(result.stdoutTruncated, false);
});

test('reports a non-zero exit as a result, including stderr', async () => {
  const { runner } = fake(({ callback }) => {
    const error = new Error('exit 3');
    error.code = 3;
    callback(error, 'partial\n', 'boom\n');
  });
  const result = await runner.run({ command: 'systemctl restart nope' });
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, 'partial\n');
  assert.equal(result.stderr, 'boom\n');
  assert.equal(result.timedOut, false);
});

test('rejects transport, timeout, abort and oversized output as failures', async () => {
  const failed = fake(({ callback }) => {
    const error = new Error('connection');
    error.code = 255;
    callback(error, '', 'ssh: connect to host port 22: Connection refused');
  });
  await assert.rejects(failed.runner.run({ command: 'true' }), { code: 'ORACLE_SSH_FAILED' });

  const timedOut = fake(({ callback }) => {
    const error = new Error('killed');
    error.killed = true;
    callback(error, '', '');
  });
  await assert.rejects(timedOut.runner.run({ command: 'sleep 999', timeoutMs: 2000 }), {
    code: 'ORACLE_EXEC_TIMED_OUT', message: /within 2s/,
  });

  const oversized = fake(({ callback }) => {
    const error = new Error('too much');
    error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    callback(error, '', '');
  });
  await assert.rejects(oversized.runner.run({ command: 'yes' }), { code: 'ORACLE_EXEC_OUTPUT_LIMIT' });

  const stopped = new AbortController();
  stopped.abort(new Error('caller reason'));
  const abortedCall = fake(({ callback }) => callback(null, '', ''));
  await assert.rejects(abortedCall.runner.run({ command: 'true', signal: stopped.signal }), { name: 'AbortError' });
  assert.equal(abortedCall.calls.length, 0);
});

test('bounds the command, the deadline and the captured streams', async () => {
  const { runner, calls } = fake(({ callback }) => callback(null, 'x'.repeat(40 * 1024), 'y'.repeat(40 * 1024)));
  const result = await runner.run({ command: 'cat big' });
  assert.equal(result.stdout.length, 32 * 1024);
  assert.equal(result.stderr.length, 32 * 1024);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
  assert.equal(calls.length, 1);

  for (const timeoutMs of [0, 999, 300_001, 1.5]) {
    await assert.rejects(runner.run({ command: 'true', timeoutMs }), { code: 'ORACLE_EXEC_TIMEOUT_RANGE' });
  }
  await assert.rejects(runner.run({ command: '   ' }), { code: 'ORACLE_EXEC_EMPTY' });
  await assert.rejects(runner.run({ command: 'x'.repeat(9000) }), { code: 'ORACLE_EXEC_TOO_LONG' });
  assert.equal(calls.length, 1);
});

test('refuses only machine-destroying commands, not ordinary administration', async () => {
  const { runner, calls } = fake(({ callback }) => callback(null, '', ''));
  const refused = [
    'rm -rf /',
    'rm -rf --no-preserve-root /',
    'sudo rm -rf /*',
    'mkfs.ext4 /dev/sdb1',
    'wipefs -a /dev/sdb',
    'dd if=/dev/zero of=/dev/sda bs=1M',
    ':(){ :|:& };:',
  ];
  for (const command of refused) {
    await assert.rejects(runner.run({ command }), { code: 'ORACLE_EXEC_REFUSED' }, command);
  }
  assert.equal(calls.length, 0);

  const allowed = [
    'sudo apt-get update -y',
    'rm -rf /home/ubuntu/build',
    'sudo systemctl restart nginx',
    'echo hi > /home/ubuntu/notes.txt',
    'sudo rm -rf /var/log/journal/old',
    'df -h && free -h',
  ];
  for (const command of allowed) await runner.run({ command });
  assert.equal(calls.length, allowed.length);
});
