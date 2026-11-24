(() => {
  const script = document.currentScript;
  if (!script?.src || window.parent === window) return;

  let parentOrigin;
  try {
    parentOrigin = new URL(script.src).searchParams.get("parentOrigin");
    const parsed = new URL(parentOrigin);
    if (!parentOrigin || parsed.origin !== parentOrigin || !["http:", "https:"].includes(parsed.protocol)) return;
  } catch {
    return;
  }

  const marker = Symbol.for("webcontainer-preview-console-v1");
  const send = (level, text, nonce) => {
    try {
      window.parent.postMessage({ type: "webcontainer-preview-console", version: 1, level, ...(text === undefined ? {} : { text }), ...(nonce === undefined ? {} : { nonce }) }, parentOrigin);
    } catch {
      // Diagnostics must never change the preview application's behavior.
    }
  };
  if (window[marker]) { send("ready"); return; }
  window[marker] = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== parentOrigin) return;
    const data = event.data;
    if (!data || data.type !== "webcontainer-preview-probe" || data.version !== 1 ||
        typeof data.nonce !== "string" || !data.nonce || data.nonce.length > 128) return;
    send("ready", undefined, data.nonce);
  });

  const clean = (text) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  function format(value, depth, seen) {
    try {
      if (typeof value === "string") return value.slice(0, 2000);
      if (value === null || value === undefined || ["number", "boolean", "bigint"].includes(typeof value)) return String(value);
      if (typeof value === "symbol" || typeof value === "function") return String(value).slice(0, 200);
      if (value instanceof Error) return `${value.name}: ${value.message}`.slice(0, 2000);
      if (seen.has(value)) return "[Circular]";
      if (depth >= 2) return Array.isArray(value) ? "[Array]" : "[Object]";
      seen.add(value);
      const keys = Object.keys(value);
      const parts = keys.slice(0, 12).map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const result = descriptor && "value" in descriptor ? format(descriptor.value, depth + 1, seen) : "[Getter]";
        return Array.isArray(value) ? result : `${key.slice(0, 100)}: ${result}`;
      });
      seen.delete(value);
      if (keys.length > 12) parts.push("…");
      return Array.isArray(value) ? `[${parts.join(", ")}]` : `{${parts.join(", ")}}`;
    } catch {
      return "[无法显示]";
    }
  }

  let windowStart = Date.now();
  let count = 0;
  let errorCount = 0;
  function withinLimit(isError = false) {
    const now = Date.now();
    if (now - windowStart >= 1000 || now < windowStart) { windowStart = now; count = 0; errorCount = 0; }
    return (isError ? errorCount++ : count++) < 50;
  }
  window.addEventListener("error", (event) => {
    try {
      if (!event.filename) return;
      const url = new URL(event.filename, window.location.href);
      if (!["http:", "https:"].includes(url.protocol)) return;
      if (url.origin === window.location.origin && url.pathname === "/.webcontainer@wc-api-script.js" &&
          /^(?:Uncaught )?SyntaxError: Unexpected end of input$/.test(event.message || "")) return;
      if (!withinLimit(true)) return;
      const line = Number.isSafeInteger(event.lineno) && event.lineno > 0 ? `:${event.lineno}` : "";
      const column = line && Number.isSafeInteger(event.colno) && event.colno > 0 ? `:${event.colno}` : "";
      send("error-location", clean(`${url.origin}${url.pathname}${line}${column}`).slice(0, 4000));
    } catch {
      // Diagnostics must never change the preview application's behavior.
    }
  });
  for (const level of ["log", "info", "warn"]) {
    const original = console[level];
    if (typeof original !== "function") continue;
    console[level] = function (...args) {
      const result = Reflect.apply(original, this, args);
      try {
        if (withinLimit()) {
          const text = clean(args.slice(0, 10).map((value) => format(value, 0, new WeakSet())).join(" ")).slice(0, 4000);
          send(level, text);
        }
      } catch {
        // Keep application logging functional even for unusual values.
      }
      return result;
    };
  }
  send("ready");
})();
