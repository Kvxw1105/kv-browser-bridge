import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type WindowsUiaStatus = {
  available: boolean;
  executable?: string;
  error?: { code: string; message: string };
};

export type WindowsUiaObservation = {
  protocolVersion: number;
  observationId: string;
  capturedAt: string;
  driver: 'windows-uia';
  foregroundWindowHandle: number;
  windows: unknown[];
  targetWindow?: unknown;
  elements: unknown[];
  truncated: boolean;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type SidecarResponse = {
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string; retryable?: boolean };
};

export class WindowsUiaClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private readonly pending = new Map<string, Pending>();
  private executable: string | undefined;
  private lastError: WindowsUiaStatus['error'];

  constructor(private readonly timeoutMs = 15_000) {}

  async status(): Promise<WindowsUiaStatus> {
    try {
      await this.ensureStarted();
      await this.request('status', {});
      return { available: true, executable: this.executable };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = { code: 'WINDOWS_UIA_UNAVAILABLE', message };
      return { available: false, executable: this.executable, error: this.lastError };
    }
  }

  async observe(params: Record<string, unknown> = {}): Promise<WindowsUiaObservation> {
    return await this.request('observe', params) as WindowsUiaObservation;
  }

  async close(): Promise<void> {
    this.process?.kill();
    this.process = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Windows UIA sidecar closed.'));
    }
    this.pending.clear();
  }

  private async ensureStarted(): Promise<void> {
    if (this.process && !this.process.killed) return;
    const executable = await resolveExecutable();
    this.executable = executable;
    const isDll = executable.toLowerCase().endsWith('.dll');
    const child = isDll
      ? spawn('dotnet', [executable], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.process = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.readLines(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const message = chunk.trim();
      if (message) this.lastError = { code: 'WINDOWS_UIA_STDERR', message };
    });
    child.once('exit', (code, signal) => this.handleExit(code, signal));
    child.once('error', (error) => this.handleExit(null, null, error));
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.ensureStarted();
    if (!this.process || this.process.killed) throw new Error('Windows UIA sidecar is not running.');
    const id = crypto.randomUUID();
    return await new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`${method} exceeded ${this.timeoutMs}ms.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.process!.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private readLines(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let response: SidecarResponse;
      try {
        response = JSON.parse(line) as SidecarResponse;
      } catch {
        this.handleExit(null, null, new Error('Windows UIA sidecar returned invalid JSON.'));
        return;
      }
      if (!response.id) continue;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error?.message ?? 'Windows UIA request failed.'));
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    this.process = null;
    const message = error?.message ?? `Windows UIA sidecar exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`;
    this.lastError = { code: 'WINDOWS_UIA_EXITED', message };
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}

async function resolveExecutable(): Promise<string> {
  const explicit = process.env.KV_WINDOWS_UIA_DRIVER;
  if (explicit) {
    const candidate = resolve(explicit);
    await access(candidate);
    return candidate;
  }

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(moduleDir, '..', '..', '..');
  const candidates = [
    join(repoRoot, 'apps', 'windows-uia-driver', 'bin', 'Release', 'net8.0-windows', 'kv-windows-uia-driver.exe'),
    join(repoRoot, 'apps', 'windows-uia-driver', 'bin', 'Debug', 'net8.0-windows', 'kv-windows-uia-driver.exe'),
    join(repoRoot, 'apps', 'windows-uia-driver', 'bin', 'Release', 'net8.0-windows', 'kv-windows-uia-driver.dll'),
    join(repoRoot, 'apps', 'windows-uia-driver', 'bin', 'Debug', 'net8.0-windows', 'kv-windows-uia-driver.dll'),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next deterministic build output.
    }
  }
  throw new Error('Windows UIA driver is not built. Run dotnet build apps/windows-uia-driver/Kv.WindowsUia.Driver.csproj -c Release.');
}
