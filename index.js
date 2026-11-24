import execModule from './exec.cjs';
import sshModule from './ssh.cjs';
import { chatInject, installOracleChat } from './chat.js';

export const name = 'oracle-dsh';
export const inject = ['connection', 'webServer', ...chatInject];

const endpoint = '/_oracle-dsh/read';
const defaultBrowseRoot = '/home/ubuntu';
const allowed = new Set(['overview', 'list', 'preview']);

function send(res, status, payload) {
  if (res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  res.end(JSON.stringify(payload));
}

// Optional backend injections are local test seams; the loader calls apply(ctx).
export function setupOracle(ctx, ssh = sshModule.createOracleSsh(), openBrowse = root => sshModule.createOracleSsh({root})) {
  const lifetime = new AbortController();
  let inFlight = 0;

  // Alternate roots are accepted only by the authenticated Files route. The
  // chat-facing executor never passes a selected root into this dispatcher.
  const dispatch = async (snapshot, {path, cursor, signal, root} = {}) => {
    if (!allowed.has(snapshot)) throw new Error('Unknown Oracle operation.');
    if (inFlight >= 4) throw new Error('Oracle is busy. Try again in a moment.');
    signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    signal.throwIfAborted();
    inFlight++;
    try {
      if (snapshot === 'overview') return await ssh.overview({signal});
      const backend = root === undefined ? ssh : openBrowse(root);
      if (snapshot === 'list') return await backend.list({path: path ?? '.', cursor: cursor ?? null, signal});
      return await backend.preview({path, signal});
    } finally {
      inFlight--;
    }
  };

  ctx.effect(() => {
    const dispose = ctx.webServer.register({kind: 'exact', path: endpoint, async handler(req, res) {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) return send(res, rejection, {ok: false, error: 'Oracle requires an authenticated Harness connection.'});
      if (req.headers['x-oracle-dsh'] !== '1') return send(res, 403, {ok: false, error: 'Open Oracle in Harness to connect.'});
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return send(res, 405, {ok: false, error: 'Read-only endpoint.'});
      }
      if (!req.url || req.url.length > 16_000) return send(res, 400, {ok: false, error: 'Invalid Oracle request.'});
      const params = new URL(req.url, 'http://localhost').searchParams;
      const snapshot = params.get('snapshot');
      if (!allowed.has(snapshot)) return send(res, 400, {ok: false, error: 'Unknown Oracle operation.'});
      let root;
      if (snapshot !== 'overview') {
        try { root = sshModule.normalizeBrowseRoot(params.get('root') ?? defaultBrowseRoot); }
        catch (error) { return send(res, 400, {ok: false, error: error.message}); }
      } else if (params.has('root')) {
        return send(res, 400, {ok: false, error: 'Choose a browse root in Files.'});
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once('close', abort);
      try {
        const value = await dispatch(snapshot, {path: params.get('path'), cursor: params.get('cursor'), signal: controller.signal, root});
        if (!controller.signal.aborted) send(res, 200, {ok: true, value: root === undefined ? value : {...value, browseRoot: root}});
      } catch (error) {
        if (!controller.signal.aborted) send(res, 502, {ok: false, error: error instanceof Error ? error.message : 'Oracle request failed.'});
      } finally {
        res.off('close', abort);
      }
    }});
    return () => { lifetime.abort(); dispose(); };
  });
  const execute = (snapshot, {path, cursor, signal} = {}) => dispatch(snapshot, {path, cursor, signal});
  return {execute, signal: lifetime.signal};
}

export function apply(ctx) {
  const {execute, signal} = setupOracle(ctx);
  const {run} = execModule.createOracleExec();
  installOracleChat(ctx, execute, signal, run);
}
