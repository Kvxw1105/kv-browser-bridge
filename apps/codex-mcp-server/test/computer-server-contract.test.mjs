import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const builtServer = await readFile(new URL('../dist/computer-server.js', import.meta.url), 'utf8');

test('registers computer_list_apps with the bounded availability contract', () => {
  assert.match(builtServer, /server\.tool\('computer_list_apps'/);
  assert.match(builtServer, /Return allowlisted native applications and their current availability without exposing arbitrary executable control\./);
  assert.match(builtServer, /runtime\.listApps\(\)/);
});

test('computer_execute exposes appId and process_started without a raw command tool', () => {
  assert.match(builtServer, /appId: z\.string\(\)\.regex\(NATIVE_APP_ID_PATTERN\)\.optional\(\)/);
  assert.match(builtServer, /'process_started'/);
  assert.doesNotMatch(builtServer, /server\.tool\('computer_(?:raw_command|launch_command|shell)'/);
});
