import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** stderr is intentionally left for diagnostics; the JSONL file is the audit log. */
export class JsonlLogger {
  readonly filePath: string;

  constructor(appDataDir = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')) {
    const logDir = join(appDataDir, 'KvBrowserBridge', 'logs');
    mkdirSync(logDir, { recursive: true });
    this.filePath = join(logDir, `chrome-bridge-${dateStamp()}.jsonl`);
  }

  write(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      component: 'chrome-bridge',
      event,
      ...redact(data),
    });
    try {
      appendFileSync(this.filePath, `${entry}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      process.stderr.write(`[chrome-bridge] failed to write audit log: ${String(error)}\n`);
    }
    if (level !== 'debug') process.stderr.write(`[chrome-bridge] ${level} ${event}\n`);
  }
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function redact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/token|cookie|authorization|password|secret/i.test(key)) return [key, '[redacted]'];
    return [key, item];
  }));
}
