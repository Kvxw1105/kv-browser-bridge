import assert from 'node:assert/strict';
import test from 'node:test';

process.env.KV_BRIDGE_TEST = '1';
const { doctor, install, pathsForInstall, testInstall, testRestore, uninstall } = await import('../dist/install.js');
const { createKvWrapper, createNativeHostManifest } = await import('../dist/install-helpers.js');

function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    existsSync(path) { return files.has(path); },
    mkdirSync() {},
    readFileSync(path) { if (!files.has(path)) throw new Error(`missing ${path}`); return files.get(path); },
    writeFileSync(path, content) { files.set(path, String(content)); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    rmSync(path) { files.delete(path); },
    accessSync(path) { if (!files.has(path)) throw new Error('not writable'); },
  };
}

function registry(initial = { keyExists: false, value: undefined }, hooks = {}) {
  const state = { ...initial };
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    const hook = hooks[args[0]];
    const forced = hook?.(args, state, calls);
    if (forced) return forced;
    if (args[0] === 'query') {
      if (!state.keyExists) return { status: 1, stdout: '', stderr: '' };
      if (!args.includes('/ve')) return { status: 0, stdout: 'key exists\r\n', stderr: '' };
      return state.value === undefined
        ? { status: 1, stdout: '', stderr: '' }
        : { status: 0, stdout: `    (Default)    REG_SZ    ${state.value}\r\n`, stderr: '' };
    }
    if (args[0] === 'add') { state.keyExists = true; state.value = args[args.indexOf('/d') + 1]; return { status: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'delete') {
      if (args.includes('/ve')) state.value = undefined;
      else { state.keyExists = false; state.value = undefined; }
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected reg command ${args[0]}`);
  };
  return { state, calls, runner };
}

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const base = { appDataDir: 'C:\\kv-test-appdata', distDir: 'C:\\kv-test-dist', nodePath: 'C:\\node.exe' };

function expected(paths) {
  return {
    wrapper: createKvWrapper(paths.bridge, base.nodePath),
    manifest: `${JSON.stringify(createNativeHostManifest(EXTENSION_ID, paths.wrapper), null, 2)}\n`,
  };
}

test('installer uses injected stateful registry runner, atomic files, and consistency query', () => {
  const paths = pathsForInstall(base);
  const fs = fakeFs({ [paths.bridge]: 'bridge', 'C:\\node.exe': 'node' });
  const reg = registry();
  install(EXTENSION_ID, { ...base, fs, runner: reg.runner });
  const want = expected(paths);
  assert.equal(fs.files.get(paths.manifest), want.manifest);
  assert.equal(fs.files.get(paths.wrapper), want.wrapper);
  assert.deepEqual(reg.state, { keyExists: true, value: paths.manifest });
  assert.equal([...fs.files.keys()].some((path) => path.endsWith('.tmp')), false);
});

test('installation refuses spoofed markers and incomplete prior triads without modifying them', () => {
  const paths = pathsForInstall(base);
  const fs = fakeFs({ [paths.bridge]: 'bridge', [paths.wrapper]: 'REM Kv Browser Bridge wrapper - managed by Kv\r\n@echo spoof' });
  const reg = registry();
  assert.throws(() => install(EXTENSION_ID, { ...base, fs, runner: reg.runner }), /inconsistent or non-Kv/);
  assert.match(fs.files.get(paths.wrapper), /spoof/);
  assert.deepEqual(reg.state, { keyExists: false, value: undefined });
});

test('registry add failure restores a clean filesystem and leaves registry absent', () => {
  const paths = pathsForInstall(base);
  const fs = fakeFs({ [paths.bridge]: 'bridge' });
  const reg = registry(undefined, { add: () => ({ status: 1, stdout: '', stderr: 'add denied' }) });
  assert.throws(() => install(EXTENSION_ID, { ...base, fs, runner: reg.runner }), /Registry add failed/);
  assert.equal(fs.files.has(paths.wrapper), false);
  assert.equal(fs.files.has(paths.manifest), false);
  assert.deepEqual(reg.state, { keyExists: false, value: undefined });
});

test('query failure after add conditionally rolls back the registry key and artifacts', () => {
  const paths = pathsForInstall(base);
  const fs = fakeFs({ [paths.bridge]: 'bridge' });
  let added = false;
  let verificationFailed = false;
  const reg = registry(undefined, {
    add: () => { added = true; return undefined; },
    query: (args) => {
      if (added && args.includes('/ve') && !verificationFailed) {
        verificationFailed = true;
        return { status: 1, stdout: '', stderr: 'verification denied' };
      }
      return undefined;
    },
  });
  assert.throws(() => install(EXTENSION_ID, { ...base, fs, runner: reg.runner }), /verification query/);
  assert.deepEqual(reg.state, { keyExists: false, value: undefined });
  assert.equal(fs.files.has(paths.wrapper), false);
  assert.equal(fs.files.has(paths.manifest), false);
});

test('registry rollback preserves a concurrent registry value and artifact tampering', () => {
  const paths = pathsForInstall(base);
  const fs = fakeFs({ [paths.bridge]: 'bridge' });
  let added = false;
  const reg = registry(undefined, {
    add: () => { added = true; return undefined; },
    query: (args, state) => {
      if (added && args.includes('/ve')) {
        state.keyExists = true;
        state.value = 'C:\\foreign-manifest.json';
        fs.files.set(paths.wrapper, '@echo foreign concurrent writer');
        return { status: 0, stdout: `REG_SZ    ${state.value}\r\n`, stderr: '' };
      }
      return undefined;
    },
  });
  assert.throws(() => install(EXTENSION_ID, { ...base, fs, runner: reg.runner }), /consistency/);
  assert.equal(reg.state.value, 'C:\\foreign-manifest.json');
  assert.equal(fs.files.get(paths.wrapper), '@echo foreign concurrent writer');
  assert.equal(fs.files.has(paths.manifest), false);
});

test('uninstall removes only an exact generated triad and rejects spoofed marker bytes', () => {
  const paths = pathsForInstall(base);
  const want = expected(paths);
  const fs = fakeFs({ [paths.bridge]: 'bridge', [paths.wrapper]: want.wrapper, [paths.manifest]: want.manifest });
  const reg = registry({ keyExists: true, value: paths.manifest });
  uninstall({ ...base, fs, runner: reg.runner });
  assert.equal(fs.files.has(paths.wrapper), false);
  assert.equal(fs.files.has(paths.manifest), false);
  assert.deepEqual(reg.state, { keyExists: false, value: undefined });

  const spoofFs = fakeFs({ [paths.bridge]: 'bridge', [paths.wrapper]: `${want.wrapper}REM Kv Browser Bridge wrapper - managed by Kv\r\n`, [paths.manifest]: want.manifest });
  const spoofReg = registry({ keyExists: true, value: paths.manifest });
  uninstall({ ...base, fs: spoofFs, runner: spoofReg.runner });
  assert.equal(spoofFs.files.has(paths.wrapper), true);
  assert.equal(spoofFs.files.has(paths.manifest), true);
  assert.equal(spoofReg.state.value, paths.manifest);
});

test('doctor reports structured required failures without registry access', () => {
  const paths = pathsForInstall(base);
  const fs = fakeFs({ [paths.bridge]: 'bridge', 'C:\\node.exe': 'node' });
  const report = doctor({ ...base, fs, runner: () => ({ status: 1, stdout: '', stderr: 'missing' }) });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((item) => item.name === 'registry-hkcu').ok, false);
  assert.equal(report.checks.find((item) => item.name === 'bridge-pipe').required, false);
});

test('Shadow test install backs up and restores the existing Kv registration', () => {
  const paths = pathsForInstall(base);
  const want = expected(paths);
  const fs = fakeFs({ [paths.bridge]: 'bridge', [paths.wrapper]: want.wrapper, [paths.manifest]: want.manifest });
  const reg = registry({ keyExists: true, value: paths.manifest });
  testInstall(EXTENSION_ID, { ...base, fs, runner: reg.runner });
  assert.match(fs.files.get(paths.wrapper), /KBB_RUNTIME_MODE=shadow/);
  assert.equal(fs.files.has(paths.testBackup), true);
  testRestore({ ...base, fs, runner: reg.runner });
  assert.equal(fs.files.get(paths.wrapper), want.wrapper);
  assert.equal(fs.files.get(paths.manifest), want.manifest);
  assert.equal(reg.state.value, paths.manifest);
  assert.equal(fs.files.has(paths.testBackup), false);
});
