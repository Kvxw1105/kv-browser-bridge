import assert from 'node:assert/strict';
import test from 'node:test';

process.env.KV_BRIDGE_TEST = '1';
const { doctor, install, pathsForInstall, uninstall } = await import('../dist/install.js');
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

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const base = { appDataDir: 'C:\\kv-test-appdata', distDir: 'C:\\kv-test-dist', nodePath: 'C:\\node.exe' };

test('installer uses injected registry runner, atomic files, and consistency query', () => {
  const paths = pathsForInstall(base);
  const fs = fakeFs({ [paths.bridge]: 'bridge', 'C:\\node.exe': 'node' });
  let registry;
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    if (args[0] === 'add') { registry = args[args.indexOf('/d') + 1]; return { status: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'query') return { status: 0, stdout: `    (Default)    REG_SZ    ${registry}\r\n`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  install(EXTENSION_ID, { ...base, fs, runner });
  assert.equal(JSON.parse(fs.files.get(paths.manifest)).path, paths.wrapper);
  assert.match(fs.files.get(paths.wrapper), /managed by Kv/);
  assert.equal(calls.filter((call) => call[0] === 'query').length, 1);
  assert.equal([...fs.files.keys()].some((path) => path.endsWith('.tmp')), false);
});

test('uninstall leaves foreign registry, manifest, and wrapper untouched', () => {
  const paths = pathsForInstall(base);
  const fs = fakeFs({ [paths.manifest]: JSON.stringify({ name: 'foreign' }), [paths.wrapper]: '@echo off' });
  const calls = [];
  const runner = (args) => { calls.push(args); return { status: 0, stdout: `REG_SZ    ${paths.manifest}\r\n`, stderr: '' }; };
  uninstall({ ...base, fs, runner });
  assert.equal(fs.files.has(paths.manifest), true);
  assert.equal(fs.files.has(paths.wrapper), true);
  assert.equal(calls.some((call) => call[0] === 'delete'), false);
});

test('installer restores prior Kv artifacts when registry add or verification fails', () => {
  const paths = pathsForInstall(base);
  const oldWrapper = createKvWrapper(paths.bridge, 'C:\\old-node.exe');
  const oldManifest = `${JSON.stringify(createNativeHostManifest('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', paths.wrapper), null, 2)}\n`;
  for (const failure of ['add', 'query']) {
    const fs = fakeFs({ [paths.bridge]: 'bridge', [paths.wrapper]: oldWrapper, [paths.manifest]: oldManifest });
    const runner = (args) => {
      if (args[0] === failure) return { status: 1, stdout: '', stderr: 'injected registry failure' };
      return { status: 0, stdout: '', stderr: '' };
    };
    assert.throws(() => install(EXTENSION_ID, { ...base, fs, runner }), /Registry/);
    assert.equal(fs.files.get(paths.wrapper), oldWrapper);
    assert.equal(fs.files.get(paths.manifest), oldManifest);
  }
});

test('installer refuses foreign artifacts and never overwrites a concurrent change', () => {
  const paths = pathsForInstall(base);
  const foreignFs = fakeFs({ [paths.bridge]: 'bridge', [paths.wrapper]: '@echo foreign' });
  assert.throws(() => install(EXTENSION_ID, { ...base, fs: foreignFs, runner: () => ({ status: 0, stdout: '', stderr: '' }) }), /non-Kv artifact/);
  assert.equal(foreignFs.files.get(paths.wrapper), '@echo foreign');

  const oldManifest = `${JSON.stringify(createNativeHostManifest('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', paths.wrapper), null, 2)}\n`;
  const fs = fakeFs({ [paths.bridge]: 'bridge', [paths.manifest]: oldManifest });
  const runner = (args) => {
    if (args[0] === 'add') return { status: 0, stdout: '', stderr: '' };
    // Simulate another writer changing the wrapper between our write and validation.
    fs.files.set(paths.wrapper, '@echo foreign concurrent writer');
    return { status: 0, stdout: `REG_SZ    ${paths.manifest}\r\n`, stderr: '' };
  };
  assert.throws(() => install(EXTENSION_ID, { ...base, fs, runner }), /consistency/);
  assert.equal(fs.files.get(paths.wrapper), '@echo foreign concurrent writer');
  assert.equal(fs.files.get(paths.manifest), oldManifest);
});

test('installer rejects a tampered manifest even when its schema remains Kv-shaped', () => {
  const paths = pathsForInstall(base);
  const fs = fakeFs({ [paths.bridge]: 'bridge' });
  const runner = (args) => {
    if (args[0] === 'add') {
      const tampered = JSON.parse(fs.files.get(paths.manifest));
      tampered.description = 'Kv Browser Bridge (tampered)';
      fs.files.set(paths.manifest, `${JSON.stringify(tampered, null, 2)}\n`);
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: `REG_SZ    ${paths.manifest}\r\n`, stderr: '' };
  };
  assert.throws(() => install(EXTENSION_ID, { ...base, fs, runner }), /exact manifest/);
  assert.match(fs.files.get(paths.manifest), /tampered/);
});

test('uninstall never deletes registry solely because a Kv wrapper exists', () => {
  const paths = pathsForInstall(base);
  const fs = fakeFs({
    [paths.manifest]: JSON.stringify({ name: 'foreign' }),
    [paths.wrapper]: createKvWrapper(paths.bridge, 'C:\\node.exe'),
  });
  const calls = [];
  const runner = (args) => { calls.push(args); return { status: 0, stdout: `REG_SZ    ${paths.manifest}\r\n`, stderr: '' }; };
  uninstall({ ...base, fs, runner });
  assert.equal(calls.some((call) => call[0] === 'delete'), false);
  assert.equal(fs.files.has(paths.manifest), true);
});

test('doctor reports structured required failures without registry access', () => {
  const paths = pathsForInstall(base);
  const fs = fakeFs({ [paths.bridge]: 'bridge', 'C:\\node.exe': 'node' });
  const report = doctor({ ...base, fs, runner: () => ({ status: 1, stdout: '', stderr: 'missing' }) });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((item) => item.name === 'registry-hkcu').ok, false);
  assert.equal(report.checks.find((item) => item.name === 'bridge-pipe').required, false);
});
