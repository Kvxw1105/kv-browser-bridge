// Type declarations for scripts/identity-console-dir.mjs (consumed by desktop main).
export interface ConsoleDirFs {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void;
  copyFileSync(src: string, dest: string): void;
}

export function resolveIdentityConsoleDir(
  env?: NodeJS.ProcessEnv,
  cwd?: string,
  defaultDir?: string,
): string;

export function migrateLegacyConsoleDir(
  localDir: string,
  userDataDir: string,
  fs?: ConsoleDirFs,
): boolean;
