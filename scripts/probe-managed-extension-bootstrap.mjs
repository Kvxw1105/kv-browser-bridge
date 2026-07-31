import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const chromePath = process.argv[2] ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const extensionPath = resolve(process.argv[3] ?? 'apps/extension/dist');
const profilePath = resolve(process.argv[4] ?? 'local/e2e-managed-extension-bootstrap/profile');
if (!existsSync(chromePath)) fail('CHROME_MISSING', `Chrome executable does not exist: ${chromePath}`);
if (!existsSync(`${extensionPath}/manifest.json`)) fail('EXTENSION_MANIFEST_MISSING', `Extension manifest does not exist: ${extensionPath}`);

const child = spawn(chromePath, [
  `--user-data-dir=${profilePath}`,
  '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging',
  '--no-first-run',
  '--no-default-browser-check',
  ...(process.env.KV_PROBE_VERBOSE_LOGGING === '1' ? ['--enable-logging=stderr', '--v=1'] : []),
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: false });
const stderr = [];
child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
const readPipe = child.stdio[4];
const writePipe = child.stdio[3];
if (!readPipe || !writePipe) fail('CDP_PIPE_UNAVAILABLE', 'Chrome did not expose the expected remote-debugging pipe handles.');

let buffer = '';
let nextId = 1;
const pending = new Map();
const cdpEvents = [];
readPipe.on('data', (chunk) => {
  buffer += String(chunk);
  let delimiter = buffer.indexOf('\0');
  while (delimiter >= 0) {
    const payload = buffer.slice(0, delimiter);
    buffer = buffer.slice(delimiter + 1);
    let message;
    try { message = JSON.parse(payload); } catch { continue; }
    if (typeof message.method === 'string') {
      cdpEvents.push({ method: message.method, params: sanitizeEventParams(message.params) });
      if (cdpEvents.length > 100) cdpEvents.shift();
    }
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(Object.assign(new Error(message.error.message ?? 'CDP request failed.'), { code: message.error.code }));
    else waiter.resolve(message.result ?? {});
    delimiter = buffer.indexOf('\0');
  }
});

try {
  const version = await request('Browser.getVersion');
  const loaded = await request('Extensions.loadUnpacked', { path: extensionPath });
  const extensions = await request('Extensions.getExtensions');
  const extensionId = loaded.id ?? loaded.extensionId;
  const found = (extensions.extensions ?? []).find((item) => item.id === extensionId || item.path === extensionPath);
  let extensionPage;
  if (extensionId && process.env.KV_PROBE_OPEN_EXTENSION_PAGE === '1') {
    extensionPage = await request('Target.createTarget', { url: `chrome-extension://${extensionId}/sidepanel.html` });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const targets = await request('Target.getTargets');
  const targetSummaries = (targets.targetInfos ?? []).map((item) => ({
    targetId: item.targetId,
    type: item.type,
    url: typeof item.url === 'string' ? item.url.slice(0, 300) : undefined,
    title: typeof item.title === 'string' ? item.title.slice(0, 120) : undefined,
  }));
  const serviceWorkerTarget = (targets.targetInfos ?? []).find((item) => item.type === 'service_worker' && typeof item.url === 'string' && (item.url.includes(extensionId ?? '') || item.url.includes('privacy-service-worker')));
  let workerRuntime;
  if (serviceWorkerTarget?.targetId && process.env.KV_PROBE_ATTACH_WORKER === '1') {
    try {
      const attached = await withDeadline(request('Target.attachToTarget', { targetId: serviceWorkerTarget.targetId, flatten: true }), 20_000, 'TARGET_ATTACH_TIMEOUT');
      const sessionId = attached.sessionId;
      await withDeadline(request('Runtime.enable', {}, 15_000, sessionId), 20_000, 'RUNTIME_ENABLE_TIMEOUT');
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const evaluation = await withDeadline(request('Runtime.evaluate', {
        expression: `(() => ({ runtimeId: chrome.runtime.id, manifestVersion: chrome.runtime.getManifest().version, nativeMessagingPermission: chrome.runtime.getManifest().permissions?.includes('nativeMessaging') === true }))()`,
        returnByValue: true,
        awaitPromise: true,
      }, 15_000, sessionId), 20_000, 'RUNTIME_EVALUATE_TIMEOUT');
      workerRuntime = evaluation.result?.value;
    } catch (error) {
      workerRuntime = { error: { code: error.code ?? 'WORKER_DIAGNOSTIC_FAILED', message: error.message } };
    }
  }
  const report = {
    schemaVersion: 1,
    chromeVersion: version.product,
    chromeFlavor: 'official',
    profilePath,
    extensionPath,
    extensionId,
    installed: Boolean(found),
    enabled: found?.enabled === true,
    extension: found ? { id: found.id, path: found.path, enabled: found.enabled } : undefined,
    extensionPage: extensionPage ? { targetId: extensionPage.targetId } : undefined,
    targets: targetSummaries,
    serviceWorker: serviceWorkerTarget ? { targetId: serviceWorkerTarget.targetId, url: serviceWorkerTarget.url, state: serviceWorkerTarget.targetId ? 'present' : 'missing' } : undefined,
    workerRuntime,
    runtimeEvents: cdpEvents.filter((event) => event.method.startsWith('Runtime.')).slice(-30),
    chromeStderr: stderr.join('').slice(-6000),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.extensionId) fail('EXTENSION_LOAD_FAILED', 'Extensions.loadUnpacked returned no extension ID.');
  if (!found) fail('EXTENSION_NOT_LISTED', 'Extensions.getExtensions did not return the loaded extension.');
  if (found.enabled !== true) fail('EXTENSION_DISABLED', 'Loaded extension is not enabled.');
} catch (error) {
  const value = { ok: false, error: { code: error.code ?? 'CDP_REQUEST_FAILED', message: error.message }, stderr: stderr.join('').slice(-4000) };
  process.stderr.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  if (process.env.KV_PROBE_STDERR_PATH) {
    try { writeFileSync(process.env.KV_PROBE_STDERR_PATH, stderr.join(''), 'utf8'); } catch { /* local diagnostics are best effort */ }
  }
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('CDP transport closing.')); }
  pending.clear();
  try { writePipe.end(); } catch { /* already closed */ }
  try { readPipe.destroy(); } catch { /* already closed */ }
  if (!child.killed) child.kill();
}

function request(method, params = {}, timeoutMs = 15_000, sessionId) {
  const id = nextId++;
  const frame = `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error(`CDP request ${method} timed out.`), { code: 'CDP_TIMEOUT' })); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    writePipe.write(frame, 'utf8');
  });
}

function withDeadline(promise, timeoutMs, code) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error(`${code}.`), { code })), timeoutMs)),
  ]);
}

function sanitizeEventParams(params) {
  if (!params || typeof params !== 'object') return undefined;
  const value = params;
  if (value.exceptionDetails) return { exceptionDetails: { text: value.exceptionDetails.text, exception: value.exceptionDetails.exception ? { description: value.exceptionDetails.exception.description } : undefined } };
  if (Array.isArray(value.args)) return { type: value.type, args: value.args.map((arg) => ({ type: arg.type, value: typeof arg.value === 'string' ? arg.value.slice(0, 300) : undefined })) };
  return undefined;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
