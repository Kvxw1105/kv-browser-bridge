export const CODEX_BLOCK_START = '# BEGIN KV COMPUTER USE';
export const CODEX_BLOCK_END = '# END KV COMPUTER USE';
const CODEX_TABLE = '[mcp_servers.kv-computer-use]';

export type ManagedConfigEdit = {
  content: string;
  changed: boolean;
  installed: boolean;
};

export function renderCodexBlock(serverPath: string, nodePath = process.execPath, newline = '\n'): string {
  return [
    CODEX_BLOCK_START,
    CODEX_TABLE,
    `command = "${escapeTomlString(nodePath)}"`,
    `args = ["${escapeTomlString(serverPath)}"]`,
    'env = { LOCAL_CHROME_REQUEST_TIMEOUT_MS = "30000" }',
    'startup_timeout_ms = 20000',
    CODEX_BLOCK_END,
  ].join(newline);
}

export function upsertCodexBlock(source: string, serverPath: string, nodePath = process.execPath): ManagedConfigEdit {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(source);
  const range = managedRange(lines);
  const blockLines = renderCodexBlock(serverPath, nodePath, newline).split(/\r?\n/);

  if (!range && lines.some((line) => line.trim() === CODEX_TABLE)) {
    throw new Error(`Refusing to replace unmanaged ${CODEX_TABLE} configuration.`);
  }

  let nextLines: string[];
  if (range) {
    nextLines = [...lines.slice(0, range.start), ...blockLines, ...lines.slice(range.end + 1)];
  } else {
    nextLines = [...lines];
    if (nextLines.length === 1 && nextLines[0] === '') nextLines.length = 0;
    while (nextLines.at(-1) === '') nextLines.pop();
    if (nextLines.length > 0) nextLines.push('');
    nextLines.push(...blockLines);
  }

  const content = `${nextLines.join(newline)}${newline}`;
  return { content, changed: content !== normalizeTrailingNewline(source, newline), installed: true };
}

export function removeCodexBlock(source: string): ManagedConfigEdit {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(source);
  const range = managedRange(lines);
  if (!range) return { content: source, changed: false, installed: false };

  const nextLines = [...lines.slice(0, range.start), ...lines.slice(range.end + 1)];
  while (nextLines.length > 1 && nextLines.at(-1) === '') nextLines.pop();
  const content = nextLines.length === 1 && nextLines[0] === '' ? '' : `${nextLines.join(newline)}${newline}`;
  return { content, changed: content !== source, installed: false };
}

export function hasCodexBlock(source: string): boolean {
  return Boolean(managedRange(splitLines(source)));
}

function managedRange(lines: string[]): { start: number; end: number } | undefined {
  const starts = lines.flatMap((line, index) => line.trim() === CODEX_BLOCK_START ? [index] : []);
  const ends = lines.flatMap((line, index) => line.trim() === CODEX_BLOCK_END ? [index] : []);
  if (starts.length === 0 && ends.length === 0) return undefined;
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) {
    throw new Error('Codex config contains malformed or duplicate KV Computer Use markers.');
  }
  return { start: starts[0], end: ends[0] };
}

function splitLines(source: string): string[] {
  const normalized = source.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

function normalizeTrailingNewline(source: string, newline: string): string {
  if (source.length === 0) return source;
  return `${source.replace(/(?:\r?\n)+$/, '')}${newline}`;
}

function escapeTomlString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}
