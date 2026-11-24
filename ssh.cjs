'use strict';

const { execFile } = require('node:child_process');

// Standalone CommonJS API; all methods return promises and accept an AbortSignal.
// createOracleSsh({root?, execFileImpl?}) uses the fixed macOS OpenSSH alias `oracle`.
// `root` is a trusted app setting: see normalizeBrowseRoot(); omit to use remote HOME.
// Explicit scopes accept ordinary local filesystem mounts at the selected root,
// but never cross another mount while listing or previewing below that root.
// overview({signal?}) -> {hostname,platform,cpuCount,cpuUsagePercent,uptimeSeconds,loadAverage,memory,disk,scope}
// cpuUsagePercent is the 0–100 share of aggregate CPU time spent executing during
// one on-demand 500 ms sample, or null if unavailable. Load averages are unchanged.
// list({path='.',cursor=null,limit=50,signal?}) -> {path,entries,nextCursor}
//   entries: {name,type:'directory'|'file',sizeBytes,modifiedAt}; directory size is null.
// preview({path,maxBytes=16384,signal?}) -> {path,text,truncated,sizeBytes}
// Paths are slash-separated and relative to scope, '.' denotes the root. Cursors are
// opaque and bound to the path; a live directory is not a transactional snapshot.
// Requires a POSIX-compatible login shell, Linux /proc, and /usr/bin/python3 (3.7+).
// Uses the existing trusted SSH configuration and known-hosts files; no remote
// install or temp files.
// All returned names and text are untrusted display data. The secret filters are
// conservative heuristics, not a DLP guarantee; configure the narrowest useful root.

const MAX_PAGE = 100;
const MAX_PREVIEW = 32768;
const MAX_PATH = 2048;
const MAX_CURSOR = 8192;
const MAX_BUFFER = 512 * 1024;
const TIMEOUT = 10_000;
// Applies only to explicit browsing. HOME and chat retain their previous scope.
const BLOCKED_ROOTS = Object.freeze([
  '/proc', '/sys', '/dev', '/run', '/var/run', '/var/lock', '/var/lib/cloud', '/var/lib/systemd',
  '/var/lib/docker', '/var/lib/containers', '/var/lib/kubelet', '/etc', '/root', '/tmp', '/var/tmp',
]);
const SENSITIVE_NAME = /password|passwd|passphrase|secret|credential|token|keyring|keystore|kubeconfig|shadow|authorized_keys|known_hosts|^id_(rsa|dsa|ecdsa|ed25519)|(^|[_.-])(auth|private|key|keys|env|environment)([_.-]|$)|\.(pem|p12|pfx|kdbx|jks|pgp|gpg|asc|netrc|npmrc)$/i;
const SSH_OPTIONS = Object.freeze([
  'BatchMode=yes', 'StrictHostKeyChecking=yes', 'VerifyHostKeyDNS=no',
  'UpdateHostKeys=no', 'KnownHostsCommand=none', 'ClearAllForwardings=yes',
  'ForwardAgent=no', 'ForwardX11=no', 'GSSAPIDelegateCredentials=no', 'Tunnel=no',
  'AddKeysToAgent=no', 'ControlMaster=no',
  'ControlPersist=no', 'ControlPath=none', 'ProxyCommand=none', 'ProxyJump=none',
  'PermitLocalCommand=no', 'RemoteCommand=none', 'RequestTTY=no',
  'SessionType=default', 'ForkAfterAuthentication=no', 'EscapeChar=none',
  'ConnectionAttempts=1', 'ConnectTimeout=5', 'ServerAliveInterval=3',
  'ServerAliveCountMax=2', 'LogLevel=ERROR',
]);

const REMOTE_SCRIPT = String.raw`
import base64, contextlib, datetime, json, os, re, signal, stat, sys, time, unicodedata

class Refusal(Exception):
    pass

DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
UNSAFE = {'Cc', 'Cf', 'Cs'}
BLOCKED_ROOTS = ${JSON.stringify(BLOCKED_ROOTS)}
# Prefer an allowlist for explicit browsing: unknown pseudo/remote filesystem
# types and unmanaged filesystem drivers must not gain access by default.
DISK_TYPES = {b'ext2', b'ext3', b'ext4', b'xfs', b'btrfs', b'f2fs', b'zfs', b'overlay', b'bcachefs', b'jfs', b'reiserfs', b'nilfs2', b'vfat', b'exfat', b'ntfs3', b'iso9660', b'udf'}
SENSITIVE = re.compile(${JSON.stringify(SENSITIVE_NAME.source)}, re.I)
TEXT_SUFFIX = {'.txt', '.md', '.rst', '.adoc', '.csv', '.tsv', '.py', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.css', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.rb', '.sql', '.sh', '.bash', '.zsh', '.fish'}
TEXT_NAME = {'readme', 'license', 'copying', 'notice', 'changelog', 'authors', 'makefile'}
CREDENTIAL_TEXT = re.compile(r'-----BEGIN [^\r\n-]*(PRIVATE KEY|PGP MESSAGE)-----|(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|\b(?:password|passwd|passphrase|(?:api|access|private)[_-]?key|(?:access|auth|refresh)[_-]?token|secret)\s*[\x22\x27]?\s*[:=]|\bBearer\s+[A-Za-z0-9_./+-]{8,}|://[^\s/:@]+:[^\s/@]+@', re.I)

def denied():
    raise Refusal('unavailable')

def name_ok(name):
    return (name != '' and not name.startswith('.') and '/' not in name and '\\' not in name
            and len(os.fsencode(name)) <= 255 and not SENSITIVE.search(name)
            and not any(unicodedata.category(c) in UNSAFE for c in name))

def blocked_path(path):
    path = path.lower()
    return any(path == prefix or path.startswith(prefix + '/') for prefix in BLOCKED_ROOTS)

def parts(path, absolute=False, explicit=False):
    if not isinstance(path, str) or len(path.encode('utf-8')) > 2048:
        denied()
    if absolute:
        if explicit and path == '/':
            return []
        if not path.startswith('/') or path == '/':
            denied()
        path = path[1:]
    elif path == '.':
        return []
    result = path.split('/')
    if len(result) > 64 or not all(name_ok(n) for n in result):
        denied()
    return result

def mount_id(fd):
    value = re.search(rb'^mnt_id:\s*(\d+)\s*$', read_small('/proc/self/fdinfo/' + str(fd), 2048), re.M)
    if value is None:
        denied()
    return value.group(1)

def guard_mount(fd, expected_mount):
    if mount_id(fd) != expected_mount:
        denied()

def mount_table():
    cap = 2 * 1024 * 1024
    data = read_small('/proc/self/mountinfo', cap + 1)
    if len(data) > cap:
        denied()
    records = {}
    for line in data.splitlines():
        left, right = line.split(b' - ', 1)
        fields = left.split()
        ident, device = fields[0], fields[2]
        fs_type = right.split()[0]
        if ident in records:
            denied()
        decode = lambda raw: os.fsdecode(re.sub(rb'\\([0-7]{3})', lambda m: bytes([int(m[1], 8)]), raw))
        records[ident] = (device, fs_type, decode(fields[3]), decode(fields[4]))
    return records

def child_path(parent, child):
    return parent.rstrip('/') + '/' + child

def relative_under(path, prefix):
    if path == prefix:
        return ''
    prefix = prefix.rstrip('/') + '/'
    return path[len(prefix):] if path.startswith(prefix) else None

def explicit_origins(mount, visible_path, records):
    entry = records.get(mount)
    if entry is None:
        denied()
    device, fs_type, source_root, target = entry
    relative = relative_under(visible_path, target)
    if fs_type not in DISK_TYPES or relative is None:
        denied()
    logical = child_path(source_root, relative) if relative else source_root
    origins = {visible_path, logical}
    # A bind mount uses a different mount ID but can expose a different subtree
    # of the same filesystem. Recover known aliases using the internal root and
    # the visible mount targets. This also handles Btrfs subvolumes; an ordinary
    # /home partition on a distinct device does not look like a root bind mount.
    for other_device, other_type, other_source, other_target in records.values():
        if (device, fs_type) != (other_device, other_type):
            continue
        branch = relative_under(logical, other_source)
        if branch is not None:
            origins.add(child_path(other_target, branch) if branch else other_target)
    for origin in origins:
        if blocked_path(origin) or (origin != '/' and not all(name_ok(n) for n in origin[1:].split('/'))):
            denied()
    return origins

def listing_allowed(origins, path):
    return not any(blocked_path(child_path(origin, path)) for origin in origins)

def open_explicit(stack, current, names):
    visible_path = '/'
    mount = mount_id(current)
    origins = explicit_origins(mount, visible_path, mount_table())
    for name in names:
        if not listing_allowed(origins, name):
            denied()
        visible_path = child_path(visible_path, name)
        current = os.open(name, DIR_FLAGS, dir_fd=current)
        stack.callback(os.close, current)
        next_mount = mount_id(current)
        if next_mount != mount:
            mount = next_mount
            origins = explicit_origins(mount, visible_path, mount_table())
        else:
            origins = {child_path(origin, name) for origin in origins}
    return current, mount, origins

def open_dirs(stack, current, names, expected_mount=None):
    for name in names:
        current = os.open(name, DIR_FLAGS, dir_fd=current)
        stack.callback(os.close, current)
        if expected_mount is not None:
            guard_mount(current, expected_mount)
    return current

def same_kind(st):
    if stat.S_ISDIR(st.st_mode):
        return 'directory'
    if stat.S_ISREG(st.st_mode) and st.st_nlink == 1:
        return 'file'
    return None

def list_dir(fd, after, limit, expected_mount, origins=None):
    found = []
    with os.scandir(fd) as iterator:
        for index, entry in enumerate(iterator):
            if index >= 10000:
                raise Refusal('too_many_entries')
            if (name_ok(entry.name) and (after is None or entry.name > after)
                and (origins is None or listing_allowed(origins, entry.name))):
                found.append(entry.name)
    found.sort()
    rows = []
    for name in found:
        try:
            child = os.open(name, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            try:
                st = os.fstat(child)
                kind = same_kind(st)
                if not kind or mount_id(child) != expected_mount:
                    continue
                modified = datetime.datetime.fromtimestamp(st.st_mtime, datetime.timezone.utc)
                rows.append({'name': name, 'type': kind, 'sizeBytes': min(st.st_size, 2**53-1) if kind == 'file' else None,
                             'modifiedAt': modified.isoformat(timespec='milliseconds').replace('+00:00', 'Z')})
            finally:
                os.close(child)
        except (OSError, ValueError, OverflowError):
            continue
        if len(rows) > limit:
            break
    return {'entries': rows[:limit], 'after': rows[limit-1]['name'] if len(rows) > limit else None}

def preview_file(fd, name, cap, expected_mount):
    if os.path.splitext(name.lower())[1] not in TEXT_SUFFIX and name.lower() not in TEXT_NAME:
        raise Refusal('not_text')
    with contextlib.ExitStack() as stack:
        # O_PATH never opens a device/FIFO for I/O. Then reopen the verified inode,
        # not its mutable directory entry. O_NOFOLLOW also rejects symlinks at fstat.
        probe = os.open(name, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
        stack.callback(os.close, probe)
        st = os.fstat(probe)
        guard_mount(probe, expected_mount)
        if same_kind(st) != 'file':
            denied()
        file_fd = os.open('/proc/self/fd/' + str(probe), os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
        stack.callback(os.close, file_fd)
        opened = os.fstat(file_fd)
        if (opened.st_dev, opened.st_ino) != (st.st_dev, st.st_ino) or same_kind(opened) != 'file':
            denied()
        # Screen a bounded prefix plus lookahead before returning any text. A
        # tiny requested cap must not trivially cut a credential marker in half.
        scan_cap = max(4096, cap + 1024)
        chunks = bytearray()
        while len(chunks) <= scan_cap:
            block = os.read(file_fd, scan_cap + 1 - len(chunks))
            if not block:
                break
            chunks.extend(block)
        scanned = text_prefix(chunks, scan_cap)
        if any(c not in '\t\n\r' and unicodedata.category(c) in UNSAFE for c in scanned):
            raise Refusal('not_text')
        if CREDENTIAL_TEXT.search(scanned):
            raise Refusal('sensitive_content')
        return {'text': text_prefix(chunks, cap), 'truncated': len(chunks) > cap,
                'sizeBytes': min(opened.st_size, 2**53-1)}

def text_prefix(chunks, cap):
    prefix = bytes(chunks[:cap])
    try:
        return prefix.decode('utf-8-sig')
    except UnicodeDecodeError as exc:
        if len(chunks) > cap and exc.reason == 'unexpected end of data' and exc.end == len(prefix):
            return prefix[:exc.start].decode('utf-8-sig')
        raise Refusal('not_text')

def read_small(path, count):
    with open(path, 'rb') as stream:
        return stream.read(count)

def cpu_counters():
    with open('/proc/stat', 'rb') as stream:
        line = stream.readline(1024)
    fields = line.split()
    if not line.endswith(b'\n') or len(fields) < 5 or fields[0] != b'cpu':
        return None
    # guest and guest_nice are already included in user and nice.
    counters = fields[1:9]
    if any(not counter.isdigit() for counter in counters):
        return None
    return tuple(int(counter) for counter in counters)

def sample_cpu_usage():
    try:
        before = cpu_counters()
        if before is None:
            return None
        time.sleep(0.5)
        after = cpu_counters()
    except OSError:
        return None
    if after is None or len(before) != len(after):
        return None
    deltas = [end - start for start, end in zip(before, after)]
    # Linux documents that iowait can go backwards. Treat such a change as
    # zero wait for the interval; any other regression invalidates the sample.
    if any(delta < 0 for index, delta in enumerate(deltas) if index != 4):
        return None
    if len(deltas) > 4:
        deltas[4] = max(0, deltas[4])
    total = sum(deltas)
    if not total:
        return None
    # Idle, iowait, and stolen ticks count in elapsed time, but not as CPU
    # execution. User, nice, system, irq and softirq are busy ticks.
    busy = sum(delta for index, delta in enumerate(deltas) if index not in (3, 4, 7))
    return 100 * busy / total

def overview(root_fd, configured):
    info = os.uname()
    mem = dict(re.findall(rb'^(MemTotal|MemAvailable):\s*(\d+)\s+kB$', read_small('/proc/meminfo', 8192), re.M))
    disk = os.fstatvfs(root_fd)
    ceiling = 2**53-1
    return {'hostname': ''.join(c for c in info.nodename[:255] if unicodedata.category(c) not in UNSAFE),
            'platform': info.sysname, 'cpuCount': os.cpu_count(),
            'cpuUsagePercent': sample_cpu_usage(),
            'uptimeSeconds': float(read_small('/proc/uptime', 128).split()[0]),
            'loadAverage': list(os.getloadavg()),
            'memory': {'totalBytes': min(int(mem[b'MemTotal']) * 1024, ceiling),
                       'availableBytes': min(int(mem[b'MemAvailable']) * 1024, ceiling)},
            'disk': {'totalBytes': min(disk.f_blocks * disk.f_frsize, ceiling),
                     'availableBytes': min(disk.f_bavail * disk.f_frsize, ceiling)},
            'scope': 'explicit' if configured else 'home'}

def dispatch(request):
    with contextlib.ExitStack() as stack:
        base = os.open('/', DIR_FLAGS)
        stack.callback(os.close, base)
        configured = request.get('root')
        origins = None
        if configured is None:
            root = open_dirs(stack, base, parts(os.environ.get('HOME'), absolute=True))
            expected_mount = None
        else:
            root, expected_mount, origins = open_explicit(stack, base, parts(configured, absolute=True, explicit=True))
        op = request['op']
        if op == 'overview':
            return overview(root, configured)
        names = parts(request['path'])
        path = '/'.join(names)
        if origins is not None and names and not listing_allowed(origins, path):
            denied()
        if expected_mount is None:
            expected_mount = mount_id(root)
        if op == 'list':
            after, limit = request['after'], request['limit']
            if (after is not None and not name_ok(after)) or not 1 <= limit <= 100:
                denied()
            sub_origins = ({child_path(origin, path) for origin in origins} if names else origins) if origins is not None else None
            return list_dir(open_dirs(stack, root, names, expected_mount), after, limit, expected_mount, sub_origins)
        if op == 'preview' and names and 1 <= request['maxBytes'] <= 32768:
            return preview_file(open_dirs(stack, root, names[:-1], expected_mount), names[-1], request['maxBytes'], expected_mount)
        denied()

try:
    if sys.platform != 'linux':
        raise Refusal('unsupported_os')
    signal.alarm(8)
    if len(sys.argv) != 2 or len(sys.argv[1]) > 16384:
        denied()
    request = json.loads(base64.urlsafe_b64decode(sys.argv[1]))
    response = {'ok': True, 'data': dispatch(request)}
except Refusal as exc:
    response = {'ok': False, 'code': str(exc)}
except PermissionError:
    response = {'ok': False, 'code': 'not_readable'}
except (FileNotFoundError, NotADirectoryError):
    response = {'ok': False, 'code': 'not_found'}
except (KeyError, TypeError, ValueError, OSError, IndexError, OverflowError):
    response = {'ok': False, 'code': 'unavailable'}
print(json.dumps(response, ensure_ascii=True, allow_nan=False, separators=(',', ':')))
`;

const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const SAFE_NAME = (name) => typeof name === 'string' && name.length > 0 &&
  !name.startsWith('.') && !name.includes('/') && !name.includes('\\') &&
  !CONTROL.test(name) && Buffer.byteLength(name) <= 255;

function isBlockedRoot(path) {
  const folded = path.toLowerCase();
  return BLOCKED_ROOTS.some(prefix => folded === prefix || folded.startsWith(`${prefix}/`));
}

function normalizeBrowseRoot(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_PATH || !value.startsWith('/') || value.startsWith('//')) {
    throw new Error('Scope root must be a bounded absolute Linux path.');
  }
  const root = value === '/' ? '/' : value.replace(/\/+$/, '');
  const names = root === '/' ? [] : root.slice(1).split('/');
  if (names.length > 64 || !names.every(name => SAFE_NAME(name) && !SENSITIVE_NAME.test(name)) || isBlockedRoot(root)) {
    throw new Error('Scope root contains a disallowed path component.');
  }
  return root;
}

function checkedPath(value, browseRoot = null) {
  if (value === '.') return value;
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_PATH || value.startsWith('/')) {
    throw new Error('Expected a scope-relative path.');
  }
  const names = value.split('/');
  if (names.length > 64 || !names.every(SAFE_NAME)) throw new Error('Path contains a disallowed component.');
  if (browseRoot !== null && (names.some(name => SENSITIVE_NAME.test(name)) ||
      isBlockedRoot(`${browseRoot === '/' ? '' : browseRoot}/${value}`))) throw failure('ORACLE_UNAVAILABLE', 'The remote scope or item is unavailable or disallowed.');
  return value;
}

function checkedCount(value, max, field) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${field} must be an integer from 1 to ${max}.`);
  return value;
}

function encodeCursor(path, name, root) {
  return Buffer.from(JSON.stringify(root === null ? [path, name] : [path, name, root])).toString('base64url');
}

function decodeCursor(path, cursor, root) {
  if (cursor === null) return null;
  try {
    if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR || !/^[\w-]+$/.test(cursor)) throw new Error();
    const fields = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(fields) || fields[0] !== path || !SAFE_NAME(fields[1]) ||
        encodeCursor(path, fields[1], root) !== cursor) throw new Error();
    return fields[1];
  } catch {
    throw new Error('Invalid file page cursor.');
  }
}

/** The one hardened OpenSSH invocation every Oracle channel shares. */
function sshArgs(command) {
  return ['-T', '-n', ...SSH_OPTIONS.flatMap((option) => ['-o', option]), '--', 'oracle', command];
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function failure(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function aborted() {
  const err = failure('ABORT_ERR', 'Oracle SSH request cancelled.');
  err.name = 'AbortError';
  return err;
}

const REMOTE_ERRORS = Object.freeze({
  unavailable: 'The remote scope or item is unavailable or disallowed.',
  not_readable: 'The SSH account cannot read that folder.',
  not_found: 'That folder or file does not exist on Oracle.',
  too_many_entries: 'The directory exceeds the 10,000-entry scan limit.',
  not_text: 'Only recognized UTF-8 text files can be previewed.',
  sensitive_content: 'Preview blocked because the text appears to contain credentials.',
  unsupported_os: 'The Oracle SSH helper requires a Linux server.',
});

function invalidResponse() {
  return failure('ORACLE_PROTOCOL', 'Unexpected response from the Oracle SSH helper.');
}

function isBytes(n) {
  return Number.isSafeInteger(n) && n >= 0;
}

function isNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function metricGroup(group) {
  if (!group || !isBytes(group.totalBytes) || !isBytes(group.availableBytes)) throw invalidResponse();
  return { totalBytes: group.totalBytes, availableBytes: group.availableBytes };
}

function createOracleSsh({ root, execFileImpl = execFile } = {}) {
  const configured = root === undefined ? null : normalizeBrowseRoot(root);
  if (typeof execFileImpl !== 'function') throw new TypeError('Expected an execFile implementation.');

  async function request(payload, signal) {
    if (signal?.aborted) throw aborted();
    // OpenSSH joins remote command arguments before passing to the remote login
    // shell. The only variable input is JSON encoded as one base64 ASCII word;
    // neither path strings nor other input can become remote shell syntax.
    const encoded = Buffer.from(JSON.stringify({ ...payload, root: configured })).toString('base64');
    if (encoded.length > 16384) throw new Error('Oracle SSH request is too large.');
    const command = `/usr/bin/python3 -I -B -S -c ${shellQuote(REMOTE_SCRIPT)} ${encoded}`;
    const args = sshArgs(command);
    const raw = await new Promise((resolve, reject) => {
      try {
        execFileImpl('/usr/bin/ssh', args, {
          encoding: 'utf8', shell: false, timeout: TIMEOUT, maxBuffer: MAX_BUFFER,
          killSignal: 'SIGKILL', signal,
        }, (err, stdout) => {
          if (signal?.aborted || err?.name === 'AbortError') return reject(aborted());
          if (err) {
            // execFile errors can contain command arguments, stdout and stderr.
            // Return only a fixed error; never attach raw diagnostics as a cause.
            if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(failure('ORACLE_OUTPUT_LIMIT', 'Oracle SSH exceeded the output limit.'));
            if (err.killed) return reject(failure('ORACLE_TIMEOUT', 'Oracle SSH did not complete within the request timeout.'));
            return reject(failure('ORACLE_SSH_FAILED', 'Oracle SSH failed. Verify the oracle alias, trusted host key, key authentication, and remote Python 3.'));
          }
          return resolve(stdout);
        });
      } catch {
        reject(signal?.aborted ? aborted() : failure('ORACLE_SSH_FAILED', 'Could not start Oracle SSH.'));
      }
    });
    if (signal?.aborted) throw aborted();
    let reply;
    try {
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BUFFER) throw new Error();
      reply = JSON.parse(raw);
    } catch {
      throw invalidResponse();
    }
    if (reply?.ok === false && typeof reply.code === 'string' && Object.hasOwn(REMOTE_ERRORS, reply.code)) {
      throw failure(`ORACLE_${reply.code.toUpperCase()}`, REMOTE_ERRORS[reply.code]);
    }
    if (reply?.ok !== true || !reply.data || typeof reply.data !== 'object' || Array.isArray(reply.data)) throw invalidResponse();
    return reply.data;
  }

  return Object.freeze({
    async overview({ signal } = {}) {
      const obj = await request({ op: 'overview' }, signal);
      const { hostname, platform, cpuCount, uptimeSeconds, loadAverage, scope } = obj;
      if (typeof hostname !== 'string' || Array.from(hostname).length > 255 || CONTROL.test(hostname) || platform !== 'Linux' ||
          (cpuCount !== null && (!Number.isSafeInteger(cpuCount) || cpuCount < 1)) ||
          (obj.cpuUsagePercent !== null && !isNumber(obj.cpuUsagePercent)) ||
          !isNumber(uptimeSeconds) || !Array.isArray(loadAverage) || loadAverage.length !== 3 || !loadAverage.every(isNumber) ||
          scope !== (configured === null ? 'home' : 'explicit')) throw invalidResponse();
      // Ticks straddling the sample boundary can round a saturated CPU just past
      // 100. Clamp that protocol-level artifact; UI-level precision is unchanged.
      const cpuUsagePercent = obj.cpuUsagePercent === null ? null : Math.min(100, obj.cpuUsagePercent);
      return { hostname, platform, cpuCount, cpuUsagePercent, uptimeSeconds, loadAverage, memory: metricGroup(obj.memory), disk: metricGroup(obj.disk), scope };
    },
    async list({ path = '.', cursor = null, limit = 50, signal } = {}) {
      checkedPath(path, configured);
      checkedCount(limit, MAX_PAGE, 'limit');
      const after = decodeCursor(path, cursor, configured);
      const obj = await request({ op: 'list', path, after, limit }, signal);
      if (!Array.isArray(obj.entries) || obj.entries.length > limit || (obj.after !== null && !SAFE_NAME(obj.after))) throw invalidResponse();
      const entries = obj.entries.map((entry) => {
        if (!entry || !SAFE_NAME(entry.name) || !['directory', 'file'].includes(entry.type) ||
            (entry.type === 'file' ? !isBytes(entry.sizeBytes) : entry.sizeBytes !== null) ||
            typeof entry.modifiedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.modifiedAt)) throw invalidResponse();
        return { name: entry.name, type: entry.type, sizeBytes: entry.sizeBytes, modifiedAt: entry.modifiedAt };
      });
      if (obj.after !== null && (entries.length !== limit || obj.after !== entries[limit - 1].name)) throw invalidResponse();
      return { path, entries, nextCursor: obj.after === null ? null : encodeCursor(path, obj.after, configured) };
    },
    async preview({ path, maxBytes = 16384, signal } = {}) {
      checkedPath(path, configured);
      if (path === '.') throw new Error('Choose a regular file to preview.');
      checkedCount(maxBytes, MAX_PREVIEW, 'maxBytes');
      const obj = await request({ op: 'preview', path, maxBytes }, signal);
      if (typeof obj.text !== 'string' || Buffer.byteLength(obj.text) > maxBytes ||
          CONTROL.test(obj.text.replace(/[\t\n\r]/g, '')) || typeof obj.truncated !== 'boolean' || !isBytes(obj.sizeBytes)) throw invalidResponse();
      return { path, text: obj.text, truncated: obj.truncated, sizeBytes: obj.sizeBytes };
    },
  });
}

module.exports = { createOracleSsh, normalizeBrowseRoot, sshArgs };
