import "server-only";

// Bound both the number and total encoded size of frames waiting for the reader
// or an authorization check. Overflow closes the stream rather than dropping
// frames and silently breaking the agent event sequence.
const MAX_QUEUED_FRAMES = 1024;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const KEEPALIVE_MS = 15_000;

// Subscribe synchronously so callers can distinguish an unknown lease before
// returning a response. Delivery waits for an async authorization on every item.
export function guardedEventStream(
  signal: AbortSignal,
  authorized: () => boolean | Promise<boolean>,
  subscribe: (send: (frame: string) => void, onRelease: () => void) => (() => void) | null,
) {
  let cleanup = () => {};
  let pull = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const queue: Uint8Array[] = [];
      let queuedBytes = 0;
      let closed = false;
      let processing = false;
      let demand = false;
      let unsubscribe: (() => void) | undefined;
      let keepalive: ReturnType<typeof setInterval> | undefined;

      const close = () => {
        if (closed) return;
        closed = true;
        queue.length = 0;
        queuedBytes = 0;
        if (keepalive) clearInterval(keepalive);
        signal.removeEventListener("abort", close);
        try { unsubscribe?.(); } catch { /* Still close the stream. */ }
        try { controller.close(); } catch { /* Already disconnected. */ }
      };
      cleanup = close;

      const drain = async () => {
        if (closed || processing || !demand || queue.length === 0) return;
        processing = true;
        // Keep the item in the queue, and in the byte budget, while checking.
        const item = queue[0];
        try {
          if (!(await authorized()) || closed || signal.aborted) { close(); return; }
          queue.shift();
          queuedBytes -= item.byteLength;
          demand = false;
          controller.enqueue(item);
        } catch {
          close();
        } finally {
          processing = false;
          if (!closed && demand && queue.length) void drain();
        }
      };
      const enqueue = (frame: string) => {
        if (closed) return;
        // A string longer than the byte limit cannot fit even before encoding.
        if (frame.length > MAX_QUEUED_BYTES || queue.length >= MAX_QUEUED_FRAMES) { close(); return; }
        const item = encoder.encode(frame);
        if (queuedBytes + item.byteLength > MAX_QUEUED_BYTES) { close(); return; }
        queue.push(item);
        queuedBytes += item.byteLength;
        void drain();
      };
      // With a zero-sized stream buffer, frames remain in our bounded queue
      // until a reader requests them; close therefore discards undelivered data.
      pull = () => { demand = true; void drain(); };
      signal.addEventListener("abort", close, { once: true });
      if (signal.aborted) { close(); return; }
      try {
        const result = subscribe((frame) => enqueue(`data: ${frame}\n\n`), close);
        if (!result) { close(); return; }
        unsubscribe = result;
        // A release/abort/overflow can occur synchronously inside subscribe.
        if (closed) { try { unsubscribe(); } catch { /* Already closed. */ } return; }
        keepalive = setInterval(() => enqueue(": keepalive\n\n"), KEEPALIVE_MS);
      } catch {
        close();
      }
    },
    pull() { pull(); },
    cancel() { cleanup(); },
  }, { highWaterMark: 0 });
}
