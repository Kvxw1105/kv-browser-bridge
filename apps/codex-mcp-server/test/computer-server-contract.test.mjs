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
  assert.match(builtServer, /type: z\.literal\('launch_app'\)/);
  assert.match(builtServer, /appId: z\.string\(\)\.regex\(NATIVE_APP_ID_PATTERN\)/);
  assert.match(builtServer, /'process_started'/);
  assert.doesNotMatch(builtServer, /server\.tool\('computer_(?:raw_command|launch_command|shell)'/);
});

test('registers the bounded serial sequence tool and persists both receipt levels', () => {
  assert.match(builtServer, /server\.tool\('computer_execute_sequence'/);
  assert.match(builtServer, /Execute a bounded sequence of policy-checked Computer Use actions serially, stop at the first blocked or failed step, and persist both step and sequence receipts\./);
  assert.match(builtServer, /steps: z\.array\(sequenceStepSchema\)\.min\(1\)\.max\(MAX_SEQUENCE_STEPS\)/);
  assert.match(builtServer, /stopOnFailure: z\.literal\(true\)\.optional\(\)/);
  assert.match(builtServer, /sequenceExecutor\.execute\(params\)/);
  assert.match(builtServer, /onStepReceipt: \(receipt\) => receipts\.append\(receipt\)/);
  assert.match(builtServer, /receipts\.appendSequence\(receipt\)/);
});

test('registers bounded sequence queries while preserving the original execute tool', () => {
  assert.match(builtServer, /server\.tool\('computer_execute'/);
  assert.match(builtServer, /server\.tool\('computer_recent_sequences'/);
  assert.match(builtServer, /limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.optional\(\)/);
  assert.match(builtServer, /server\.tool\('computer_get_sequence'/);
  assert.match(builtServer, /receipts\.findSequence\(sequenceId\)/);
});

test('does not register a workflow, expression, shell, loop, or background execution tool', () => {
  assert.doesNotMatch(
    builtServer,
    /server\.tool\('computer_(?:raw_workflow|workflow|expression|javascript|shell|loop|background|parallel)'/,
  );
});
