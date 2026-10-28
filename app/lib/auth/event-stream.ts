import "server-only";

// Authorize each frame and heartbeat, not just the initial long-lived request.
export function guardedEventStream(
  signal: AbortSignal,
  authorized: () => boolean,
  subscribe: (send: (frame: string) => void) => () => void,
) {
  let cleanup = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let unsubscribe = () => {};
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        unsubscribe();
        signal.removeEventListener("abort", close);
        try { controller.close(); } catch { /* Already disconnected. */ }
      };
      cleanup = close;
      const send = (frame: string) => {
        if (closed) return;
        if (!authorized()) { close(); return; }
        try { controller.enqueue(encoder.encode(`data: ${frame}\n\n`)); } catch { close(); }
      };
      const keepalive = setInterval(() => {
        if (!authorized()) { close(); return; }
        try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { close(); }
      }, 15000);
      if (!authorized() || signal.aborted) { close(); return; }
      unsubscribe = subscribe(send);
      if (closed) { unsubscribe(); return; }
      signal.addEventListener("abort", close, { once: true });
    },
    cancel() { cleanup(); },
  });
}
