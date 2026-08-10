import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NativeAppError, NativeAppLauncher } from '../dist/native-app-launcher.js';

class FakeChild extends EventEmitter {
  pid;
  unrefCalled = false;
  constructor(pid) {
    super();
    this.pid = pid;
  }
  unref() { this.unrefCalled = true; }
}

const availableBuiltin = (options = {}) => new NativeAppLauncher({
  platform: 'win32',
  env: {},
  resolveCommand: async (candidate) => candidate === 'notepad.exe' ? 'C:\\resolved\\notepad.exe' : undefined,
  ...options,
});

test('lists four built-in apps without exposing resolved absolute paths', async () => {
  const launcher = availableBuiltin();
  const status = await launcher.status();
  assert.deepEqual(status.apps.map((app) => app.appId), ['notepad', 'calculator', 'file-explorer', 'chrome']);
  assert.equal(status.available, true);
  assert.equal(status.availableApps, 1);
  assert.equal(status.apps.find((app) => app.appId === 'notepad').executableName, 'notepad.exe');
  assert.equal(JSON.stringify(status).includes('C:\\resolved'), false);
});

test('loads configured apps once and launches with fixed command, fixed args, and shell false', async () => {
  const configuredCommand = 'C:\\Program Files\\Editor\\editor.exe';
  const calls = [];
  const child = new FakeChild(9182);
  const launcher = new NativeAppLauncher({
    platform: 'win32',
    env: {},
    allowlistJson: JSON.stringify({
      editor: {
        displayName: 'Safe Editor',
        command: configuredCommand,
        args: ['--safe-mode'],
      },
    }),
    resolveCommand: async (candidate) => candidate === configuredCommand ? candidate : undefined,
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });

  const listed = await launcher.listApps();
  const result = await launcher.launch('editor');
  assert.equal(listed.apps.find((app) => app.appId === 'editor').source, 'configured');
  assert.deepEqual(calls, [{
    command: configuredCommand,
    args: ['--safe-mode'],
    options: { shell: false, stdio: 'ignore', windowsHide: false },
  }]);
  assert.equal(result.pid, 9182);
  assert.equal(result.appId, 'editor');
  assert.equal(result.executableName, 'editor.exe');
  assert.equal(child.unrefCalled, true);
  assert.equal('command' in result, false);
});

test('reports non-Windows platforms without import-time or discovery failure', async () => {
  const launcher = new NativeAppLauncher({
    platform: 'linux',
    env: {},
    resolveCommand: async () => { throw new Error('must not be called'); },
  });
  const list = await launcher.listApps();
  assert.equal(list.available, false);
  assert.equal(list.error.code, 'PLATFORM_UNSUPPORTED');
  await assert.rejects(
    launcher.launch('notepad'),
    (error) => error instanceof NativeAppError && error.code === 'PLATFORM_UNSUPPORTED',
  );
});

test('reports invalid allowlist JSON without crashing startup', async () => {
  const launcher = availableBuiltin({ allowlistJson: '{not-json' });
  const status = await launcher.status();
  assert.equal(status.available, true);
  assert.equal(status.configurationErrors.length, 1);
  assert.equal(status.error.code, 'ALLOWLIST_CONFIGURATION_INVALID');
  assert.match(status.configurationErrors[0], /not valid JSON/);
});

test('keeps built-ins and rejects configured appId conflicts deterministically', async () => {
  const launcher = availableBuiltin({
    allowlistJson: JSON.stringify({
      notepad: {
        displayName: 'Shadow Notepad',
        command: 'C:\\unsafe\\replacement.exe',
        args: [],
      },
    }),
  });
  const status = await launcher.status();
  assert.equal(status.apps.filter((app) => app.appId === 'notepad').length, 1);
  assert.equal(status.apps.find((app) => app.appId === 'notepad').source, 'builtin');
  assert.match(status.configurationErrors[0], /conflicts with a built-in/);
  assert.equal(JSON.stringify(status).includes('C:\\unsafe'), false);
});

test('strictly rejects invalid ids, unknown fields, and non-string fixed args', async () => {
  const launcher = availableBuiltin({
    allowlistJson: JSON.stringify({
      'Bad App': { displayName: 'Bad', command: 'bad.exe', args: [] },
      withshell: { displayName: 'Shell', command: 'shell.exe', args: [], shell: true },
      withbadargs: { displayName: 'Args', command: 'args.exe', args: [1] },
      cmdlauncher: { displayName: 'Command Prompt', command: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'notepad'] },
      scriptlauncher: { displayName: 'Script', command: 'C:\\fixed\\launch.ps1', args: [] },
    }),
  });
  const status = await launcher.status();
  assert.equal(status.apps.length, 4);
  assert.equal(status.configurationErrors.length, 5);
  assert.equal(status.configurationErrors.some((message) => message.includes('unsupported fields: shell')), true);
  assert.equal(status.configurationErrors.filter((message) => message.includes('not a shell or script')).length, 2);
});

test('rejects unknown and unavailable applications with stable codes', async () => {
  const launcher = availableBuiltin();
  await assert.rejects(
    launcher.launch('unknown-app'),
    (error) => error instanceof NativeAppError && error.code === 'APP_NOT_ALLOWLISTED',
  );
  await assert.rejects(
    launcher.launch('calculator'),
    (error) => error instanceof NativeAppError && error.code === 'APP_UNAVAILABLE',
  );
});

test('maps asynchronous spawn failure to APP_LAUNCH_FAILED', async () => {
  const child = new FakeChild(undefined);
  const launcher = availableBuiltin({
    spawnProcess() {
      queueMicrotask(() => child.emit('error', new Error('denied')));
      return child;
    },
  });
  await assert.rejects(
    launcher.launch('notepad'),
    (error) => error instanceof NativeAppError && error.code === 'APP_LAUNCH_FAILED',
  );
});

test('waits for a spawn event and times out with APP_LAUNCH_TIMEOUT', async () => {
  const child = new FakeChild(1234);
  const launcher = availableBuiltin({
    launchTimeoutMs: 100,
    spawnProcess() { return child; },
  });
  await assert.rejects(
    launcher.launch('notepad'),
    (error) => error instanceof NativeAppError && error.code === 'APP_LAUNCH_TIMEOUT',
  );
  assert.equal(child.unrefCalled, true);
});
