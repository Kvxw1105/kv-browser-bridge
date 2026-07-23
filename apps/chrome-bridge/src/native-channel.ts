import { randomUUID } from 'node:crypto';
import {
  NATIVE_CHUNK_MAX_BYTES,
  NATIVE_MESSAGE_MAX_BYTES,
  type NativeChunk,
  type NativeMessage,
  isNativeChunk,
} from '@claude-code-browser/browser-protocol';

type MessageListener = (message: NativeMessage) => void;
type ErrorListener = (error: Error) => void;
interface IncompleteTransfer {
  pieces: Array<NativeChunk | undefined>;
  expiresAt: number;
}

/**
 * Chrome Native Messaging transport. This module is the only code permitted to
 * read stdin or write stdout in the bridge process.
 */
export class NativeMessagingChannel {
  private readonly listeners = new Set<MessageListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly chunks = new Map<string, IncompleteTransfer>();
  private buffer = Buffer.alloc(0);
  private closed = false;

  start(): void {
    process.stdin.on('data', (chunk: Buffer) => this.consume(chunk));
    process.stdin.on('end', () => this.close(new Error('Native Messaging stdin closed')));
    process.stdin.on('error', (error) => this.close(error));
    process.stdin.resume();
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  send(message: NativeMessage): void {
    if (this.closed) throw new Error('Native Messaging channel is closed');
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    if (body.length <= NATIVE_MESSAGE_MAX_BYTES) {
      this.writeFrame(body);
      return;
    }

    const encoded = body.toString('base64');
    const total = Math.ceil(Buffer.byteLength(encoded, 'utf8') / NATIVE_CHUNK_MAX_BYTES);
    const transferId = randomUUID();
    for (let index = 0; index < total; index += 1) {
      const start = index * NATIVE_CHUNK_MAX_BYTES;
      const chunk: NativeChunk = {
        type: 'bridge:chunk',
        transferId,
        index,
        total,
        encoding: 'base64-json',
        data: encoded.slice(start, start + NATIVE_CHUNK_MAX_BYTES),
      };
      const chunkBody = Buffer.from(JSON.stringify(chunk), 'utf8');
      if (chunkBody.length > NATIVE_MESSAGE_MAX_BYTES) {
        throw new Error('Native chunk exceeds Chrome Native Messaging limit');
      }
      this.writeFrame(chunkBody);
    }
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > NATIVE_MESSAGE_MAX_BYTES) {
        this.close(new Error(`Invalid Native Messaging frame size: ${length}`));
        return;
      }
      if (this.buffer.length < 4 + length) return;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      try {
        this.dispatch(JSON.parse(body.toString('utf8')) as NativeMessage);
      } catch (error) {
        this.emitError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private dispatch(message: NativeMessage): void {
    if (!isNativeChunk(message)) {
      for (const listener of this.listeners) listener(message);
      return;
    }
    this.acceptChunk(message);
  }

  private acceptChunk(chunk: NativeChunk): void {
    this.removeExpiredChunks();
    if (chunk.total < 1 || chunk.total > 128 || chunk.index < 0 || chunk.index >= chunk.total) {
      this.emitError(new Error('Invalid Native Messaging chunk metadata'));
      return;
    }
    const transfer = this.chunks.get(chunk.transferId) ?? {
      pieces: new Array<NativeChunk | undefined>(chunk.total),
      expiresAt: Date.now() + 30_000,
    };
    const { pieces } = transfer;
    if (pieces[chunk.index] || (pieces[0] !== undefined && pieces[0].total !== chunk.total)) {
      this.chunks.delete(chunk.transferId);
      this.emitError(new Error('Duplicate or inconsistent Native Messaging chunk'));
      return;
    }
    pieces[chunk.index] = chunk;
    this.chunks.set(chunk.transferId, transfer);
    if (pieces.filter((piece) => piece !== undefined).length !== chunk.total) return;

    this.chunks.delete(chunk.transferId);
    try {
      const joined = pieces.map((piece) => piece!.data).join('');
      const message = JSON.parse(Buffer.from(joined, 'base64').toString('utf8')) as NativeMessage;
      for (const listener of this.listeners) listener(message);
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private writeFrame(body: Buffer): void {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(body.length, 0);
    process.stdout.write(header);
    process.stdout.write(body);
  }

  private removeExpiredChunks(): void {
    const now = Date.now();
    for (const [transferId, transfer] of this.chunks) {
      if (transfer.expiresAt < now) this.chunks.delete(transferId);
    }
  }

  private close(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.emitError(error);
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}
