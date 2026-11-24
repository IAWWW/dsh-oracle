'use strict';

const assert = require('node:assert/strict');
const { execFile: localExecFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { createOracleSsh, normalizeBrowseRoot } = require('./ssh.cjs');

const fixtureOverview = {
  hostname: 'fixture', platform: 'Linux', cpuCount: 3, cpuUsagePercent: 37.5, uptimeSeconds: 123.5,
  loadAverage: [1, 0.5, 0.3], memory: { totalBytes: 1000, availableBytes: 500 },
  disk: { totalBytes: 900, availableBytes: 700 }, scope: 'home',
};
const file = (name) => ({ name, type: 'file', sizeBytes: 4, modifiedAt: '2025-12-03T00:00:00.000Z' });
const success = (data) => JSON.stringify({ ok: true, data });
const requestOf = (args) => JSON.parse(Buffer.from(args.at(-1).split(' ').at(-1), 'base64').toString());

function fakeSsh(perform, config = {}) {
  const calls = [];
  const adapter = createOracleSsh({ ...config, execFileImpl(executable, args, options, callback) {
    calls.push({ executable, args, options });
    perform({ request: requestOf(args), executable, args, options, callback });
  } });
  return { adapter, calls };
}

test('uses fixed SSH alias and fail-closed transport options, with bounded signal-aware execFile', async () => {
  const signal = new AbortController().signal;
  const { adapter, calls } = fakeSsh(({ request, callback }) => {
    assert.deepEqual(request, { op: 'overview', root: null });
    callback(null, success(fixtureOverview), 'diagnostics not forwarded');
  });
  assert.deepEqual(await adapter.overview({ signal }), fixtureOverview);
  const [{ executable, args, options }] = calls;
  assert.equal(executable, '/usr/bin/ssh');
  assert.deepEqual(args.slice(0, 2), ['-T', '-n']);
  assert.deepEqual(args.slice(-3, -1), ['--', 'oracle']);
  assert.match(args.at(-1), /^\/usr\/bin\/python3 -I -B -S -c /);
  for (const flag of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'VerifyHostKeyDNS=no', 'UpdateHostKeys=no',
    'KnownHostsCommand=none', 'ClearAllForwardings=yes', 'ForwardAgent=no', 'ForwardX11=no',
    'GSSAPIDelegateCredentials=no', 'AddKeysToAgent=no', 'Tunnel=no',
    'ControlMaster=no', 'ControlPath=none', 'ControlPersist=no', 'ProxyJump=none', 'ProxyCommand=none',
    'PermitLocalCommand=no', 'RemoteCommand=none', 'ConnectionAttempts=1', 'ConnectTimeout=5',
    'SessionType=default', 'ForkAfterAuthentication=no', 'EscapeChar=none']) {
    assert.equal(args[args.indexOf(flag) - 1], '-o', flag);
  }
  assert.deepEqual(options, { encoding: 'utf8', shell: false, timeout: 10000, maxBuffer: 524288, killSignal: 'SIGKILL', signal });
});

test('installed OpenSSH accepts the hardened options in a config-only dry run', { skip: !fs.existsSync('/usr/bin/ssh') }, async () => {
  const { adapter } = fakeSsh(({ executable, args, callback }) => {
    // No alias config, Match rules, DNS canonicalization, or connection.
    const shown = execFileSync(executable, ['-G', '-F', '/dev/null', ...args.slice(0, -3), '--', 'fixture.invalid', 'true'], { encoding: 'utf8' });
    assert.match(shown, /^stricthostkeychecking (?:yes|true)$/m);
    assert.match(shown, /^clearallforwardings (?:yes|true)$/m);
    assert.match(shown, /^controlmaster (?:no|false)$/m);
    assert.match(shown, /^forwardagent no$/m);
    callback(null, success(fixtureOverview));
  });
  assert.deepEqual(await adapter.overview(), fixtureOverview);
});

test('supports cursor pagination with scope-relative validated paths', async () => {
  const { adapter, calls } = fakeSsh(({ request, callback }) => {
    assert.deepEqual(request, { op: 'list', path: 'sub dir', after: request.after ? 'a.txt' : null, limit: 1, root: '/srv/oracle' });
    callback(null, success(request.after === null ? { entries: [file('a.txt')], after: 'a.txt' } : { entries: [file('b.txt')], after: null }));
  }, { root: '/srv/oracle' });
  const first = await adapter.list({ path: 'sub dir', limit: 1 });
  assert.equal(first.path, 'sub dir');
  assert.deepEqual(first.entries, [file('a.txt')]);
  assert.equal(typeof first.nextCursor, 'string');
  const second = await adapter.list({ path: 'sub dir', limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second, { path: 'sub dir', entries: [file('b.txt')], nextCursor: null });
  await assert.rejects(adapter.list({ path: 'other', cursor: first.nextCursor }), /Invalid file page cursor/);
  await assert.rejects(adapter.list({ path: 'sub dir', cursor: first.nextCursor + '=' }), /Invalid file page cursor/);
  assert.equal(calls.length, 2);
});

test('canonicalizes explicit absolute roots without widening HOME or allowing traversal', async () => {
  for (const [input, canonical] of [['/', '/'], ['/home/ubuntu/', '/home/ubuntu'], ['/var/www//', '/var/www'], ['/srv/Proc photos', '/srv/Proc photos']]) {
    assert.equal(normalizeBrowseRoot(input), canonical);
    const { adapter } = fakeSsh(({ request, callback }) => {
      assert.equal(request.root, canonical);
      callback(null, success({ entries: [], after: null }));
    }, { root: input });
    await adapter.list();
  }
  for (const root of ['../../home', '//srv/oracle', '//', '/.hidden/path', '/srv//oracle', '/var/../www', '/srv/./x', '/srv/api-secret', '/srv/foo.pem', '/proc', '/sys/class', '/DEV/shm', '/run/user', '/var/run', '/var/lib/cloud', '/var/lib/kubelet/pods', '/etc', '/root', '/tmp/foo', '/var/tmp', '/srv/a\nb', null, undefined]) {
    assert.throws(() => normalizeBrowseRoot(root), /Scope root/);
    if (root !== undefined) assert.throws(() => createOracleSsh({ root }), /Scope root/);
  }
});

test('explicit root applies the blocked paths even under / and binds cursors to the canonical scope', async () => {
  const perform = ({ callback }) => callback(null, success({ entries: [file('a.txt')], after: 'a.txt' }));
  const a = fakeSsh(perform, { root: '/home/ubuntu/' });
  const equivalent = fakeSsh(perform, { root: '/home/ubuntu' });
  const parent = fakeSsh(perform, { root: '/' });
  const home = fakeSsh(perform);
  const {nextCursor} = await a.adapter.list({ limit: 1 });
  await equivalent.adapter.list({ limit: 1, cursor: nextCursor });
  for (const other of [home, parent]) {
    await assert.rejects(other.adapter.list({ limit: 1, cursor: nextCursor }), /Invalid file page cursor/);
    assert.equal(other.calls.length, 0);
  }
  for (const path of ['proc/self', 'sys', 'dev/shm', 'run/user', 'var/run', 'var/lib/cloud', 'var/lib/containers', 'etc', 'tmp', 'var/tmp']) {
    await assert.rejects(parent.adapter.list({ path }), { code: 'ORACLE_UNAVAILABLE' });
    await assert.rejects(parent.adapter.preview({ path: `${path}/notes.txt` }), { code: 'ORACLE_UNAVAILABLE' });
  }
  assert.equal(parent.calls.length, 0);
});

test('rejects invalid bounds, traversal and missing/null preview paths before SSH', async () => {
  const { adapter, calls } = fakeSsh(({ callback }) => callback(new Error('unexpected launch')));
  for (const path of [undefined, null, '', '.', '/', 'one/../two', '.ssh/id_rsa', 'folder/.', 'a//b', 'a\\b', 'nul\0name', 'a\nfile', 'a\u202efile', 'a\ud800', 'a'.repeat(256)]) {
    await assert.rejects(adapter.preview({ path }), /path|regular file/i);
  }
  await assert.rejects(adapter.list({ limit: 101 }), /limit/);
  await assert.rejects(adapter.list({ limit: 2.5 }), /limit/);
  await assert.rejects(adapter.list({ cursor: 'xyz' }), /cursor/);
  await assert.rejects(adapter.preview({ path: 'notes.txt', maxBytes: 32769 }), /maxBytes/);
  assert.equal(calls.length, 0);
});

test('cancellation before launch and during execution has a sanitized AbortError', async () => {
  const alreadyStopped = new AbortController();
  alreadyStopped.abort(new Error('private caller reason'));
  const during = new AbortController();
  const { adapter, calls } = fakeSsh(({ options, callback }) => {
    options.signal.addEventListener('abort', () => callback({ name: 'AbortError', message: 'private log', stdout: 'private output' }));
  });
  await assert.rejects(adapter.list({ signal: alreadyStopped.signal }), { name: 'AbortError', code: 'ABORT_ERR', message: 'Oracle SSH request cancelled.' });
  assert.equal(calls.length, 0);
  const pending = adapter.list({ signal: during.signal });
  during.abort();
  await assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR', message: 'Oracle SSH request cancelled.' });
  assert.equal(calls.length, 1);
});

test('returns only fixed errors for SSH and remote failures, and validates the protocol', async () => {
  const samples = [
    { err: { code: 255, message: 'credential', stdout: 'credential' }, code: 'ORACLE_SSH_FAILED' },
    { err: { killed: true, message: 'credential' }, code: 'ORACLE_TIMEOUT' },
    { err: { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stderr: 'credential' }, code: 'ORACLE_OUTPUT_LIMIT' },
    { data: '{"ok":false,"code":"unavailable","detail":"credential"}', code: 'ORACLE_UNAVAILABLE' },
    { data: '{"ok":false,"code":"sensitive_content"}', code: 'ORACLE_SENSITIVE_CONTENT' },
    { data: '{"ok":false,"code":"__proto__"}', code: 'ORACLE_PROTOCOL' },
    { data: 'malformed credential', code: 'ORACLE_PROTOCOL' },
    { data: 'a'.repeat(524289), code: 'ORACLE_PROTOCOL' },
    { data: success({ ...fixtureOverview, cpuCount: -1 }), code: 'ORACLE_PROTOCOL' },
    { data: success({ ...fixtureOverview, cpuUsagePercent: 'high' }), code: 'ORACLE_PROTOCOL' },
    { data: success({ ...fixtureOverview, cpuUsagePercent: undefined }), code: 'ORACLE_PROTOCOL' },
  ];
  for (const sample of samples) {
    const { adapter } = fakeSsh(({ callback }) => callback(sample.err, sample.data, 'credential'));
    await assert.rejects(adapter.overview(), (error) => error.code === sample.code && !/credential/i.test(error.message.replace('appears to contain credentials', '')) && !error.cause);
  }
});

test('reports CPU usage tolerantly: unavailable sample, exact bounds, saturated clamp', async () => {
  for (const [reported, expected] of [[null, null], [0, 0], [99.9, 99.9], [100, 100], [100.0000001, 100]]) {
    const { adapter } = fakeSsh(({ callback }) => callback(null, success({ ...fixtureOverview, cpuUsagePercent: reported })));
    assert.equal((await adapter.overview()).cpuUsagePercent, expected);
  }
});

test('bounds and sanitizes the returned fields for preview and list', async () => {
  const { adapter } = fakeSsh(({ request, callback }) => {
    assert.equal(request.op, 'preview');
    assert.equal(request.maxBytes, 4);
    callback(null, success({ text: '😀', truncated: true, sizeBytes: 5, extra: 'not exposed' }));
  });
  assert.deepEqual(await adapter.preview({ path: 'a.txt', maxBytes: 4 }), { path: 'a.txt', text: '😀', truncated: true, sizeBytes: 5 });
  for (const text of ['😀a', 'a\u001b']) {
    const bad = fakeSsh(({ callback }) => callback(null, success({ text, truncated: false, sizeBytes: 5 })));
    await assert.rejects(bad.adapter.preview({ path: 'a.txt', maxBytes: 4 }), { code: 'ORACLE_PROTOCOL' });
  }
  for (const data of [
    { entries: [file('a.txt'), file('b.txt')], after: null }, { entries: [file('../a.txt')], after: null },
    { entries: [file('a.txt')], after: 'z.txt' }, { entries: [file('a\u202efile')], after: null },
  ]) {
    const bad = fakeSsh(({ callback }) => callback(null, success(data)));
    await assert.rejects(bad.adapter.list({ limit: 1 }), { code: 'ORACLE_PROTOCOL' });
  }
});

test('remote shell parses one inert argument; embedded Python compiles offline', async () => {
  const path = `cmd '"$(printf BROKEN);\`printf BROKEN\`.txt`;
  const { adapter } = fakeSsh(({ args, request, callback }) => {
    assert.equal(request.path, path);
    assert.ok(!args.at(-1).includes(path));
    const command = args.at(-1).replace(/^\/usr\/bin\/python3 -I -B -S -c /, 'verify ');
    // This shell is only a test fixture. It checks shell tokenization and passes
    // the extracted Python through compile() without executing remote code.
    const harness = 'verify() { [ "$#" -eq 2 ] || exit 34; python3 -I -B -S -c \'import sys; compile(sys.argv[1], "<ssh>", "exec"); print(sys.argv[2])\' "$@"; }; ';
    const result = execFileSync('/bin/sh', ['-c', harness + command], { encoding: 'utf8' }).trim();
    assert.deepEqual(JSON.parse(Buffer.from(result, 'base64')), request);
    callback(null, success({ text: 'ok', truncated: false, sizeBytes: 2 }));
  });
  assert.equal((await adapter.preview({ path })).text, 'ok');
});

test('explicit mount policy accepts disk partitions and rejects pseudo and sensitive bind mounts', async () => {
  const { adapter } = fakeSsh(({ args, callback }) => {
    const command = args.at(-1).replace(/^\/usr\/bin\/python3 -I -B -S -c /, 'verify ');
    const policy = `
mounts = {
    b'1': (b'8:1', b'ext4', '/', '/'),
    b'2': (b'8:2', b'xfs', '/', '/home'),
    b'3': (b'0:7', b'proc', '/', '/srv/statistics'),
    b'4': (b'8:1', b'ext4', '/var/lib/cloud', '/srv/public'),
    b'5': (b'8:1', b'ext4', '/var/lib', '/srv/lib'),
    b'6': (b'0:8', b'tmpfs', '/', '/srv/volatile'),
    b'7': (b'8:1', b'ext4', '/home/user/.hidden', '/srv/hidden'),
    b'8': (b'8:1', b'ext4', '/root', '/srv/bind'),
    b'9': (b'8:3', b'ext4', '/', '/var/lib/docker'),
    b'10': (b'8:3', b'ext4', '/overlay', '/srv/engine'),
    b'11': (b'0:9', b'sysfs', '/', '/srv/settings'),
    b'12': (b'0:10', b'devtmpfs', '/', '/srv/nodes'),
    b'13': (b'8:4', b'btrfs', '/@home', '/srv/disk'),
}
assert explicit_origins(b'1', '/', mounts) == {'/'}
assert '/home/ubuntu' in explicit_origins(b'2', '/home/ubuntu', mounts)
assert '/srv/disk/ubuntu' in explicit_origins(b'13', '/srv/disk/ubuntu', mounts)
assert not listing_allowed({'/'}, 'proc')
assert not listing_allowed({'/var'}, 'run')
assert not listing_allowed(explicit_origins(b'5', '/srv/lib', mounts), 'cloud')
assert listing_allowed({'/'}, 'home')
for ident, visible in [(3, '/srv/statistics'), (4, '/srv/public'), (6, '/srv/volatile'), (7, '/srv/hidden'), (8, '/srv/bind'), (10, '/srv/engine'), (11, '/srv/settings'), (12, '/srv/nodes'), (20, '/srv/unseen')]:
    try:
        explicit_origins(str(ident).encode(), visible, mounts)
    except Refusal:
        pass
    else:
        raise AssertionError((ident, visible))
`;
    const check = 'import sys; exec(sys.argv[1].split("\\ntry:\\n    if sys.platform", 1)[0]); exec(sys.argv[2])';
    const shellQuote = (str) => `'${str.replaceAll("'", "'\"'\"'")}'`;
    const harness = `verify() { [ "$#" -eq 2 ] || exit 34; python3 -I -B -S -c ${shellQuote(check)} "$1" ${shellQuote(policy)}; }; `;
    execFileSync('/bin/sh', ['-c', harness + command], { encoding: 'utf8' });
    callback(null, success({ entries: [], after: null }));
  }, { root: '/' });
  await adapter.list();
});

// The CPU figure is the only overview value that needs two reads of /proc/stat.
// This executes the shipped helper against synthetic counters, so the tick math
// is checked without Linux: idle, iowait, and steal are elapsed but not busy.
test('reports an unreadable or missing scope in words the user can act on', async () => {
  const cases = [
    ['not_readable', 'ORACLE_NOT_READABLE', /SSH account cannot read that folder/],
    ['not_found', 'ORACLE_NOT_FOUND', /does not exist on Oracle/],
  ];
  for (const [code, expected, message] of cases) {
    const { adapter } = fakeSsh(({ callback }) => callback(null, JSON.stringify({ ok: false, code })));
    await assert.rejects(adapter.list(), (error) => error.code === expected && message.test(error.message));
  }
});

test('CPU usage helper treats iowait and steal as idle and rejects bad counters', async () => {
  const { adapter } = fakeSsh(({ args, callback }) => {
    const command = args.at(-1).replace(/^\/usr\/bin\/python3 -I -B -S -c /, 'verify ');
    const policy = `
import builtins, io
class Feed:
    def __init__(self, data):
        self.data = data
    def readline(self, count=-1):
        line, _, rest = self.data.partition(b'\\n')
        self.data = rest
        return line + b'\\n'
    def __enter__(self):
        return self
    def __exit__(self, *unused):
        return False
sequence = []
cursor = {'at': 0}
real_open = builtins.open
def feed_open(path, *unused, **ignored):
    if path != '/proc/stat':
        return real_open(path, *unused, **ignored)
    index = min(cursor['at'], len(sequence) - 1)
    cursor['at'] += 1
    return Feed(sequence[index])
builtins.open = feed_open
time.sleep = lambda seconds: None
def measure(before, after):
    sequence[:] = [before, after]
    cursor['at'] = 0
    return sample_cpu_usage()
normal = measure(b'cpu  100 0 100 100 0 0 0 0 0 0\\n', b'cpu  150 0 120 200 0 0 0 0 0 0\\n')
assert abs(normal - 100.0 * 70 / 170) < 1e-9, normal
# A backwards iowait is documented by Linux; it contributes zero wait, not a refusal.
assert measure(b'cpu  0 0 0 100 10 0 0 0\\n', b'cpu  50 0 0 100 5 0 0 0\\n') == 100.0
# Steal is elapsed time the guest did not execute: one tick of pure steal is 0% busy.
assert measure(b'cpu  0 0 0 100 0 0 0 0\\n', b'cpu  0 0 0 100 0 0 0 10\\n') == 0.0
assert measure(b'cpu  0 0 0 100 0 0 0 0\\n', b'cpu  0 0 0 90 0 0 0 0\\n') is None
assert measure(b'cpu  7 7 7 7 7 7 7 7\\n', b'cpu  7 7 7 7 7 7 7 7\\n') is None
assert measure(b'cpu  1 2\\n', b'cpu  1 2\\n') is None
`;
    const check = 'import sys; exec(sys.argv[1].split("\\ntry:\\n    if sys.platform", 1)[0]); exec(sys.argv[2])';
    const shellQuote = (str) => `'${str.replaceAll("'", "'\"'\"'")}'`;
    const harness = `verify() { [ "$#" -eq 2 ] || exit 34; python3 -I -B -S -c ${shellQuote(check)} "$1" ${shellQuote(policy)}; }; `;
    execFileSync('/bin/sh', ['-c', harness + command], { encoding: 'utf8' });
    callback(null, success(fixtureOverview));
  });
  assert.equal((await adapter.overview()).cpuUsagePercent, 37.5);
});

// Captured shape of an Oracle Cloud Ubuntu instance: the root ext4 filesystem
// carries /home, /var and /usr, so opening any of them must stay allowed, while
// the snap images, the lxd tmpfs and every pseudo filesystem must not.
test('a real cloud mount table keeps ordinary folders usable', async () => {
  const { adapter } = fakeSsh(({ args, callback }) => {
    const command = args.at(-1).replace(/^\/usr\/bin\/python3 -I -B -S -c /, 'verify ');
    const policy = `
mounts = {
    b'35': (b'8:1', b'ext4', '/', '/'),
    b'51': (b'259:0', b'ext4', '/', '/boot'),
    b'53': (b'8:15', b'vfat', '/', '/boot/efi'),
    b'28': (b'0:25', b'sysfs', '/', '/sys'),
    b'29': (b'0:26', b'proc', '/', '/proc'),
    b'32': (b'0:28', b'tmpfs', '/', '/run'),
    b'714': (b'0:54', b'tmpfs', '/', '/var/snap/lxd/common/ns'),
    b'730': (b'0:4', b'nsfs', 'mnt:[4026532624]', '/var/snap/lxd/common/ns/shmounts'),
    b'99': (b'7:2', b'squashfs', '/', '/snap/oracle-cloud-agent/107'),
}
root = explicit_origins(b'35', '/', mounts)
for visible, child in [('/home', 'ubuntu'), ('/var', 'www'), ('/usr', 'bin'), ('/srv', 'app'), ('/home/ubuntu', 'project')]:
    assert visible in explicit_origins(b'35', visible, mounts), visible
    assert listing_allowed(explicit_origins(b'35', visible, mounts), child), visible
assert '/boot' in explicit_origins(b'51', '/boot', mounts)
for ident, visible in [(b'29', '/proc'), (b'28', '/sys'), (b'32', '/run'), (b'714', '/var/snap/lxd/common/ns'), (b'730', '/var/snap/lxd/common/ns/shmounts'), (b'99', '/snap/oracle-cloud-agent/107')]:
    try:
        explicit_origins(ident, visible, mounts)
    except Refusal:
        pass
    else:
        raise AssertionError(visible)
`;
    const check = 'import sys; exec(sys.argv[1].split("\\ntry:\\n    if sys.platform", 1)[0]); exec(sys.argv[2])';
    const shellQuote = (str) => `'${str.replaceAll("'", "'\"'\"'")}'`;
    const harness = `verify() { [ "$#" -eq 2 ] || exit 34; python3 -I -B -S -c ${shellQuote(check)} "$1" ${shellQuote(policy)}; }; `;
    execFileSync('/bin/sh', ['-c', harness + command], { encoding: 'utf8' });
    callback(null, success({ entries: [], after: null }));
  }, { root: '/home' });
  await adapter.list();
});

// Exercising Linux /proc and O_PATH is not possible on macOS. On Linux this
// test invokes the actual static helper in a local shell, never the SSH binary.
test('Linux helper lists and previews only scoped regular files using real file descriptors', { skip: process.platform !== 'linux' }, async (t) => {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'oracle-ssh-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(join(root, 'docs'));
  const put = (name, value) => fs.writeFileSync(join(root, name), value);
  put('a.txt', 'A😀B');
  put('docs/README', 'docs text');
  put('credential.txt', 'skip');
  put('.env', 'skip');
  put('other.txt', 'passphrase = "test"');
  put('bad.txt', Buffer.from([0, 1, 255]));
  put('hard-source.txt', 'skip');
  fs.linkSync(join(root, 'hard-source.txt'), join(root, 'hard-copy.txt'));
  fs.symlinkSync(join(root, 'a.txt'), join(root, 'link.txt'));
  fs.symlinkSync('docs', join(root, 'docs-link'));
  execFileSync('mkfifo', [join(root, 'fifo.txt')]);
  const adapter = createOracleSsh({ execFileImpl(executable, args, options, cb) {
    assert.equal(executable, '/usr/bin/ssh');
    return localExecFile('/bin/sh', ['-c', args.at(-1)], { ...options, env: { ...process.env, HOME: root } }, cb);
  } });
  const first = await adapter.list({ limit: 2 });
  assert.deepEqual(first.entries.map((e) => e.name), ['a.txt', 'bad.txt']);
  const second = await adapter.list({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.entries.map((e) => [e.name, e.type]), [['docs', 'directory'], ['other.txt', 'file']]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(await adapter.preview({ path: 'a.txt', maxBytes: 3 }), { path: 'a.txt', text: 'A', truncated: true, sizeBytes: 6 });
  assert.equal((await adapter.preview({ path: 'docs/README' })).text, 'docs text');
  for (const path of ['credential.txt', 'link.txt', 'docs-link/README', 'hard-copy.txt', 'fifo.txt']) {
    await assert.rejects(adapter.preview({ path }), { code: 'ORACLE_UNAVAILABLE' });
  }
  await assert.rejects(adapter.preview({ path: 'other.txt', maxBytes: 1 }), { code: 'ORACLE_SENSITIVE_CONTENT' });
  await assert.rejects(adapter.preview({ path: 'bad.txt' }), { code: 'ORACLE_NOT_TEXT' });
  const overview = await adapter.overview();
  assert.equal(overview.platform, 'Linux');
  assert.equal(overview.scope, 'home');
  assert.ok(overview.memory.totalBytes > 0);
});
