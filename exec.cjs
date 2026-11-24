'use strict';

const { execFile } = require('node:child_process');
const { sshArgs } = require('./ssh.cjs');

// Remote command execution over the same fixed, hardened SSH alias as the
// read-only helper. The local side never uses a shell: the command string is
// one argv entry that OpenSSH hands to the remote login shell, so only the
// remote side interprets it — deliberately, because that is the capability.
//
// run({command, timeoutMs?, signal?}) -> {
//   command, exitCode, stdout, stderr, stdoutTruncated, stderrTruncated,
//   durationMs, timedOut }
// A non-zero exit is a normal result, not a failure; only transport problems
// (SSH itself failing, abort, timeout, oversized output) reject.

const DEFAULT_TIMEOUT = 60_000;
const MAX_TIMEOUT = 300_000;
const MAX_COMMAND = 8 * 1024;
const MAX_STREAM = 32 * 1024;
// execFile's own ceiling: past this the child is killed rather than buffered.
const MAX_BUFFER = 2 * 1024 * 1024;

// An accident brake, not a security boundary: a shell can express these in
// countless ways, so the list stays small and only covers irreversible
// machine-destroying mistakes. Everything else — installing, editing,
// deleting files, restarting services — is allowed.
const CATASTROPHIC = Object.freeze([
  { reason: 'erase the root filesystem', test: /\brm\b[^\n]*\s--no-preserve-root\b/i },
  { reason: 'erase the root filesystem', test: /\brm\s+(?:-[a-zA-Z]+\s+)*(\/|\/\*)(?:\s|$|[;|&])/ },
  { reason: 'reformat a filesystem', test: /\bmkfs(\.[a-z0-9]+)?\s/i },
  { reason: 'wipe a disk or partition table', test: /\bwipefs\b|\bparted\b[^\n]*\bmklabel\b/i },
  { reason: 'overwrite a block device', test: /\bdd\b[^\n]*\bof=\/dev\//i },
  { reason: 'start a fork bomb', test: /:\(\)\s*\{[^}]*\}\s*;\s*:/ },
]);

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function aborted() {
  const error = failure('ABORT_ERR', 'Oracle command cancelled.');
  error.name = 'AbortError';
  return error;
}

/** Keep the head of a stream and report whether anything was dropped. */
function clip(value) {
  const text = typeof value === 'string' ? value : '';
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= MAX_STREAM) return { text, truncated: false };
  return { text: bytes.subarray(0, MAX_STREAM).toString('utf8'), truncated: true };
}

function createOracleExec({ execFileImpl = execFile } = {}) {
  if (typeof execFileImpl !== 'function') throw new TypeError('Expected an execFile implementation.');

  async function run({ command, timeoutMs = DEFAULT_TIMEOUT, signal } = {}) {
    if (typeof command !== 'string' || command.trim() === '') {
      throw failure('ORACLE_EXEC_EMPTY', 'Provide a command to run.');
    }
    if (Buffer.byteLength(command) > MAX_COMMAND) {
      throw failure('ORACLE_EXEC_TOO_LONG', 'The command is longer than 8 KiB; write it to a script first.');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT) {
      throw failure('ORACLE_EXEC_TIMEOUT_RANGE', 'timeoutMs must be an integer from 1000 to 300000.');
    }
    for (const rule of CATASTROPHIC) {
      if (rule.test.test(command)) {
        throw failure('ORACLE_EXEC_REFUSED', `Refused: this command would ${rule.reason}. Run it yourself if that is really intended.`);
      }
    }
    if (signal?.aborted) throw aborted();

    const started = Date.now();
    return await new Promise((resolve, reject) => {
      const callback = (error, stdout, stderr) => {
        if (signal?.aborted || error?.name === 'AbortError') return reject(aborted());
        if (error?.killed) {
          return reject(failure('ORACLE_EXEC_TIMED_OUT', `The command did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped.`));
        }
        if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return reject(failure('ORACLE_EXEC_OUTPUT_LIMIT', 'The command produced more output than Oracle will buffer; redirect it to a file and read it in parts.'));
        }
        // A numeric code is the remote exit status: a normal, reportable result.
        if (typeof error?.code === 'number') {
          if (error.code === 255) {
            return reject(failure('ORACLE_SSH_FAILED', 'Oracle SSH failed. Verify the oracle alias, host key, and key authentication.'));
          }
          const out = clip(stdout);
          const err = clip(stderr);
          return resolve({
            command,
            exitCode: error.code,
            stdout: out.text,
            stderr: err.text,
            stdoutTruncated: out.truncated,
            stderrTruncated: err.truncated,
            durationMs: Date.now() - started,
            timedOut: false,
          });
        }
        if (error) {
          return reject(failure('ORACLE_SSH_FAILED', 'Oracle SSH failed. Verify the oracle alias, host key, and key authentication.'));
        }
        const out = clip(stdout);
        const err = clip(stderr);
        resolve({
          command,
          exitCode: 0,
          stdout: out.text,
          stderr: err.text,
          stdoutTruncated: out.truncated,
          stderrTruncated: err.truncated,
          durationMs: Date.now() - started,
          timedOut: false,
        });
      };
      try {
        execFileImpl('/usr/bin/ssh', sshArgs(command), {
          encoding: 'utf8',
          shell: false,
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER,
          killSignal: 'SIGKILL',
          signal,
        }, callback);
      } catch (error) {
        reject(signal?.aborted ? aborted() : failure('ORACLE_SSH_FAILED', 'Could not start Oracle SSH.'));
      }
    });
  }

  return Object.freeze({ run });
}

module.exports = { createOracleExec };
