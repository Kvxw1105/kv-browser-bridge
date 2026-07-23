import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const npm = process.platform === 'win32' ? process.env.ComSpec : 'npm';
for (const workspace of ['apps/chrome-bridge', 'apps/codex-mcp-server', 'packages/browser-protocol']) { const manifest = JSON.parse(await readFile(resolve(root, workspace, 'package.json'), 'utf8')); if (!manifest.private) throw new Error(`${workspace} is publishable; define an explicit publish/package policy before release.`); const args = process.platform === 'win32' ? ['/d', '/s', '/c', `npm pack --dry-run --json --workspace ${workspace}`] : ['pack', '--dry-run', '--json', '--workspace', workspace]; const result = JSON.parse(execFileSync(npm, args, { cwd: root, encoding: 'utf8' })); if (!Array.isArray(result) || result.length !== 1 || !result[0].files?.length) throw new Error(`npm pack dry-run produced no package contents for ${workspace}.`); console.log(`npm pack dry-run: ${workspace} (${result[0].files.length} files; private)`); }
