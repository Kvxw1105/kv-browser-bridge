import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access as nodeAccess } from 'node:fs/promises';
import { win32 } from 'node:path';
import { isValidNativeAppId } from './computer-contracts.js';

export type NativeAppSource = 'builtin' | 'configured';

export type NativeAppInfo = {
  appId: string;
  displayName: string;
  available: boolean;
  source: NativeAppSource;
  executableName: string;
  unavailableReason?: string;
};

export type NativeAppListResult = {
  platform: string;
  available: boolean;
  configuredApps: number;
  availableApps: number;
  apps: NativeAppInfo[];
  configurationErrors: string[];
  error?: { code: string; message: string };
};

export type NativeAppLaunchResult = {
  action: 'launch_app';
  appId: string;
  displayName: string;
  pid: number;
  executableName: string;
  source: NativeAppSource;
  startedAt: string;
};

export type NativeAppErrorCode =
  | 'PLATFORM_UNSUPPORTED'
  | 'APP_NOT_ALLOWLISTED'
  | 'APP_UNAVAILABLE'
  | 'APP_LAUNCH_FAILED'
  | 'APP_LAUNCH_TIMEOUT';

export class NativeAppError extends Error {
  constructor(
    public readonly code: NativeAppErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'NativeAppError';
  }
}

type NativeAppDefinition = {
  appId: string;
  displayName: string;
  commandCandidates: string[];
  args: string[];
  source: NativeAppSource;
  executableName: string;
};

type SpawnOptions = {
  shell: false;
  stdio: 'ignore';
  windowsHide: boolean;
};

export type NativeAppLauncherOptions = {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  allowlistJson?: string;
  launchTimeoutMs?: number;
  resolveCommand?: (candidate: string) => Promise<string | undefined>;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
};

export interface NativeAppPort {
  status(): Promise<NativeAppListResult>;
  listApps(): Promise<NativeAppListResult>;
  launch(appId: string): Promise<NativeAppLaunchResult>;
}

export class NativeAppLauncher implements NativeAppPort {
  private readonly platform: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly definitions: NativeAppDefinition[];
  private readonly configurationErrors: string[];
  private readonly launchTimeoutMs: number;
  private readonly resolveCommand: (candidate: string) => Promise<string | undefined>;
  private readonly spawnProcess: (command: string, args: string[], options: SpawnOptions) => ChildProcess;

  constructor(options: NativeAppLauncherOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.environment = { ...(options.env ?? process.env) };
    this.launchTimeoutMs = clampTimeout(options.launchTimeoutMs ?? 3_000);
    this.resolveCommand = options.resolveCommand
      ?? ((candidate) => defaultResolveCommand(candidate, this.environment, this.platform));
    this.spawnProcess = options.spawnProcess
      ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions));

    const builtins = builtInDefinitions(this.environment);
    const configured = parseConfiguredDefinitions(
      options.allowlistJson ?? this.environment.KV_COMPUTER_APP_ALLOWLIST_JSON,
      new Set(builtins.map((item) => item.appId)),
    );
    this.definitions = [...builtins, ...configured.definitions];
    this.configurationErrors = configured.errors;
  }

  async status(): Promise<NativeAppListResult> {
    return await this.listApps();
  }

  async listApps(): Promise<NativeAppListResult> {
    const apps = await Promise.all(this.definitions.map(async (definition): Promise<NativeAppInfo> => {
      if (this.platform !== 'win32') {
        return publicAppInfo(definition, false, `Native application launch is unsupported on ${this.platform}.`);
      }
      const command = await this.resolveDefinition(definition);
      return command
        ? publicAppInfo(definition, true)
        : publicAppInfo(definition, false, `${definition.displayName} executable was not found.`);
    }));
    const availableApps = apps.filter((app) => app.available).length;
    const available = this.platform === 'win32' && availableApps > 0;
    let error: NativeAppListResult['error'];
    if (this.platform !== 'win32') {
      error = { code: 'PLATFORM_UNSUPPORTED', message: `Native application launch is unsupported on ${this.platform}.` };
    } else if (availableApps === 0) {
      error = { code: 'APP_UNAVAILABLE', message: 'No allowlisted native application is currently available.' };
    } else if (this.configurationErrors.length > 0) {
      error = { code: 'ALLOWLIST_CONFIGURATION_INVALID', message: 'One or more configured allowlist entries were rejected.' };
    }
    return {
      platform: this.platform,
      available,
      configuredApps: this.definitions.length,
      availableApps,
      apps,
      configurationErrors: [...this.configurationErrors],
      ...(error ? { error } : {}),
    };
  }

  async launch(appId: string): Promise<NativeAppLaunchResult> {
    if (!isValidNativeAppId(appId)) {
      throw new NativeAppError('APP_NOT_ALLOWLISTED', 'The requested appId is not allowlisted.');
    }
    const definition = this.definitions.find((item) => item.appId === appId);
    if (!definition) {
      throw new NativeAppError('APP_NOT_ALLOWLISTED', `Application ${appId} is not allowlisted.`);
    }
    if (this.platform !== 'win32') {
      throw new NativeAppError('PLATFORM_UNSUPPORTED', `Native application launch is unsupported on ${this.platform}.`);
    }
    const command = await this.resolveDefinition(definition);
    if (!command) {
      throw new NativeAppError('APP_UNAVAILABLE', `${definition.displayName} is allowlisted but unavailable.`);
    }

    let child: ChildProcess;
    try {
      child = this.spawnProcess(command, [...definition.args], {
        shell: false,
        stdio: 'ignore',
        windowsHide: false,
      });
    } catch {
      throw new NativeAppError('APP_LAUNCH_FAILED', `Failed to launch allowlisted application ${appId}.`, true);
    }

    return await new Promise<NativeAppLaunchResult>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener('spawn', onSpawn);
        child.removeListener('error', onError);
        callback();
      };
      const onError = () => finish(() => {
        reject(new NativeAppError('APP_LAUNCH_FAILED', `Failed to launch allowlisted application ${appId}.`, true));
      });
      const onSpawn = () => finish(() => {
        if (!Number.isInteger(child.pid) || (child.pid ?? 0) <= 0) {
          reject(new NativeAppError('APP_LAUNCH_FAILED', `Allowlisted application ${appId} started without a valid process id.`, true));
          return;
        }
        child.unref();
        resolve({
          action: 'launch_app',
          appId: definition.appId,
          displayName: definition.displayName,
          pid: child.pid!,
          executableName: definition.executableName,
          source: definition.source,
          startedAt: new Date().toISOString(),
        });
      });
      const timer = setTimeout(() => finish(() => {
        child.unref();
        reject(new NativeAppError('APP_LAUNCH_TIMEOUT', `Timed out while confirming launch of allowlisted application ${appId}.`, true));
      }), this.launchTimeoutMs);
      child.once('error', onError);
      child.once('spawn', onSpawn);
    });
  }

  private async resolveDefinition(definition: NativeAppDefinition): Promise<string | undefined> {
    for (const candidate of definition.commandCandidates) {
      try {
        const resolved = await this.resolveCommand(candidate);
        if (resolved) return resolved;
      } catch {
        // Treat discovery failures as unavailable without exposing local paths.
      }
    }
    return undefined;
  }
}

function builtInDefinitions(env: NodeJS.ProcessEnv): NativeAppDefinition[] {
  // Node exposes process.env keys case-insensitively, but `{ ...process.env }`
  // snapshots (NativeAppLauncher.environment) keep only the canonical casing
  // (e.g. PROGRAMFILES). Read both spellings so built-in discovery works
  // regardless of how the environment object was constructed.
  const windowsRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR;
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES;
  const programFilesX86 = env['ProgramFiles(x86)'] ?? env['PROGRAMFILES(X86)'];
  return [
    {
      appId: 'notepad',
      displayName: 'Notepad',
      commandCandidates: compact(['notepad.exe', windowsRoot ? win32.join(windowsRoot, 'System32', 'notepad.exe') : undefined]),
      args: [],
      source: 'builtin',
      executableName: 'notepad.exe',
    },
    {
      appId: 'calculator',
      displayName: 'Calculator',
      commandCandidates: compact(['calc.exe', windowsRoot ? win32.join(windowsRoot, 'System32', 'calc.exe') : undefined]),
      args: [],
      source: 'builtin',
      executableName: 'calc.exe',
    },
    {
      appId: 'file-explorer',
      displayName: 'File Explorer',
      commandCandidates: compact(['explorer.exe', windowsRoot ? win32.join(windowsRoot, 'explorer.exe') : undefined]),
      args: [],
      source: 'builtin',
      executableName: 'explorer.exe',
    },
    {
      appId: 'chrome',
      displayName: 'Google Chrome',
      commandCandidates: compact([
        'chrome.exe',
        env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
        programFiles ? win32.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
        programFilesX86 ? win32.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
      ]),
      args: [],
      source: 'builtin',
      executableName: 'chrome.exe',
    },
  ];
}

function parseConfiguredDefinitions(
  raw: string | undefined,
  reservedIds: Set<string>,
): { definitions: NativeAppDefinition[]; errors: string[] } {
  if (raw === undefined || raw.trim() === '') return { definitions: [], errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { definitions: [], errors: ['KV_COMPUTER_APP_ALLOWLIST_JSON is not valid JSON.'] };
  }
  if (!isPlainObject(parsed)) {
    return { definitions: [], errors: ['KV_COMPUTER_APP_ALLOWLIST_JSON must be a JSON object.'] };
  }

  const definitions: NativeAppDefinition[] = [];
  const errors: string[] = [];
  for (const [appId, value] of Object.entries(parsed)) {
    if (!isValidNativeAppId(appId)) {
      errors.push(`Configured appId ${safeIdentifier(appId)} is invalid.`);
      continue;
    }
    if (reservedIds.has(appId)) {
      errors.push(`Configured appId ${appId} conflicts with a built-in application and was ignored.`);
      continue;
    }
    if (!isPlainObject(value)) {
      errors.push(`Configured appId ${appId} must be an object.`);
      continue;
    }
    const unknownFields = Object.keys(value).filter((key) => !['displayName', 'command', 'args'].includes(key));
    if (unknownFields.length > 0) {
      errors.push(`Configured appId ${appId} contains unsupported fields: ${unknownFields.sort().join(', ')}.`);
      continue;
    }
    const displayName = value.displayName;
    const command = value.command;
    const args = value.args ?? [];
    if (typeof displayName !== 'string' || displayName.trim().length === 0 || displayName.length > 128) {
      errors.push(`Configured appId ${appId} requires a displayName between 1 and 128 characters.`);
      continue;
    }
    if (typeof command !== 'string' || command.trim().length === 0 || command.length > 32_768) {
      errors.push(`Configured appId ${appId} requires a non-empty command string.`);
      continue;
    }
    if (!Array.isArray(args) || args.length > 32 || args.some((arg) => typeof arg !== 'string' || arg.length > 4_096)) {
      errors.push(`Configured appId ${appId} args must be an array of at most 32 fixed strings.`);
      continue;
    }
    if (isForbiddenShellCommand(command)) {
      errors.push(`Configured appId ${appId} must launch a native executable directly, not a shell or script.`);
      continue;
    }
    definitions.push({
      appId,
      displayName: displayName.trim(),
      commandCandidates: [command],
      args: [...args],
      source: 'configured',
      executableName: win32.basename(command),
    });
  }
  return { definitions, errors };
}

async function defaultResolveCommand(
  candidate: string,
  env: NodeJS.ProcessEnv,
  platform: string,
): Promise<string | undefined> {
  if (platform !== 'win32') return undefined;
  if (win32.isAbsolute(candidate)) {
    try {
      await nodeAccess(candidate, constants.F_OK);
      return candidate;
    } catch {
      return undefined;
    }
  }
  const directories = (env.PATH ?? env.Path ?? '').split(win32.delimiter).filter(Boolean);
  const extensions = win32.extname(candidate)
    ? ['']
    : (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const path = win32.join(directory, `${candidate}${extension}`);
      try {
        await nodeAccess(path, constants.F_OK);
        return path;
      } catch {
        // Try the next deterministic PATH candidate.
      }
    }
  }
  return undefined;
}

function publicAppInfo(
  definition: NativeAppDefinition,
  available: boolean,
  unavailableReason?: string,
): NativeAppInfo {
  return {
    appId: definition.appId,
    displayName: definition.displayName,
    available,
    source: definition.source,
    executableName: definition.executableName,
    ...(!available && unavailableReason ? { unavailableReason } : {}),
  };
}

function compact(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeIdentifier(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 64);
  return sanitized || '<empty>';
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return 3_000;
  return Math.max(100, Math.min(Math.trunc(value), 5_000));
}

function isForbiddenShellCommand(command: string): boolean {
  const name = win32.basename(command).toLowerCase();
  return ['cmd', 'cmd.exe', 'command.com', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(name)
    || ['.bat', '.cmd', '.ps1'].some((extension) => name.endsWith(extension));
}
