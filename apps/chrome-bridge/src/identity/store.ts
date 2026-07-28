import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IdentityManifest } from './model.js';
import { validateManifest } from './health.js';
import { writeJsonAtomic } from './atomic-json.js';

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
    writeJsonAtomic(this.pathFor(manifest.identityId), manifest);
  }
}
