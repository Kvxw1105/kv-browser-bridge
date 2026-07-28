import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IdentityManifest } from './model.js';
import { validateManifest } from './health.js';

export class IdentityStore {
  constructor(private readonly rootDir: string) {}

  pathFor(identityId: string): string {
    return join(this.rootDir, identityId, 'identity-manifest.json');
  }

  load(identityId: string): IdentityManifest {
    return JSON.parse(readFileSync(this.pathFor(identityId), 'utf8')) as IdentityManifest;
  }

  save(manifest: IdentityManifest): void {
    const report = validateManifest(manifest);
    if (!report.healthy) {
      const codes = report.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.code);
      throw new Error(`Identity manifest rejected: ${codes.join(', ')}`);
    }
    const path = this.pathFor(manifest.identityId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, path);
  }
}
