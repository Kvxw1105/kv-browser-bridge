import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const legacyHost = 'com.claude_code_browser';
const oldStoreId = 'mnibceaaapcppokpnnljohdlmojjgbkf';

// This is deliberately a release-path gate, not a claim that historic source
// files or attribution documents are free of their upstream identifiers.
const releaseFiles = [
  'README.md',
  'PRIVACY.md',
  'docs/codex-local-chrome.md',
  'apps/codex-mcp-server/README.md',
  'apps/extension/manifest.json',
  'apps/extension/src/sidepanel/components/SetupScreen.tsx',
  'apps/extension/src/sidepanel/components/LocalBridgePanel.tsx',
  'apps/extension/src/sidepanel/hooks/useReviewPrompt.ts',
];

test('Kv release-path copy has no old native-host or Chrome Web Store identifier', () => {
  for (const relativePath of releaseFiles) {
    const text = readFileSync(resolve(root, relativePath), 'utf8');
    assert.equal(text.includes(legacyHost), false, `${relativePath} contains the legacy native host`);
    assert.equal(text.includes(oldStoreId), false, `${relativePath} contains the old Chrome Web Store ID`);
  }
});
