import WebSocket from 'ws';

/**
 * Minimal CDP client over WebSocket for the browser endpoint
 * (http://127.0.0.1:<port>/json/version). Used for managed extension
 * provisioning when the identity browser runs in port (DevToolsActivePort)
 * mode instead of the CDP pipe mode.
 */
export class ChromeWsTransport {
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly socket: WebSocket;
  private nextId = 1;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: { message?: string } };
      } catch {
        return;
      }
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? 'CDP request failed.'));
      else pending.resolve(message.result);
    });
  }

  static async connect(port: number, timeoutMs = 10_000): Promise<ChromeWsTransport> {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!response.ok) throw new Error(`Chrome DevTools endpoint returned ${response.status}.`);
    const version = (await response.json()) as { webSocketDebuggerUrl?: string };
    if (!version.webSocketDebuggerUrl) throw new Error('Chrome DevTools version did not expose a browser WebSocket URL.');
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('Chrome DevTools WebSocket connect timed out.'));
      }, timeoutMs);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    return new ChromeWsTransport(socket);
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000, sessionId?: string): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP request ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value as T); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify(message));
    });
  }

  close(): void {
    for (const pending of this.pending.values()) pending.reject(new Error('Chrome DevTools WebSocket closed.'));
    this.pending.clear();
    this.socket.close();
  }
}
