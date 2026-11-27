"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { authenticatedFetch } from "@/app/lib/auth/client";
import { useMessages } from "@/app/lib/i18n/context";
import type { Messages } from "@/app/lib/i18n/messages";
import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import IconTooltip from "./IconTooltip";

type PreviewKey = keyof Messages["preview"];

// Localized loading fallback for the lazily loaded code editor.
function CodeEditorLoading() {
  const pv = useMessages().preview;
  return (
    <div className="flex h-full items-center justify-center text-sm text-neutral-500">
      {pv.loadingFallback}
    </div>
  );
}

// Monaco is large — only load the code editor when the Code tab is opened.
const CodeEditor = dynamic(() => import("@/app/components/CodeEditor"), {
  ssr: false,
  loading: () => <CodeEditorLoading />,
});

type View = "preview" | "code";
type ConsoleSize = "hidden" | "compact" | "expanded";

type Status = "booting" | "loading" | "installing" | "starting" | "ready" | "stopped" | "error";

const WORKSPACE_ID_FALLBACK = "workspace";
const PACKAGE_MANAGER_ENV = { npm_config_registry: "https://mirrors.cloud.tencent.com/npm/" };

type BridgeProbe = {
  nonce: string; origin: string; connected: boolean; lastSent: number;
  retry: ReturnType<typeof setInterval> | null; timeout: ReturnType<typeof setTimeout> | null;
};

function clearBridgeProbe(ref: { current: BridgeProbe | null }) {
  const probe = ref.current;
  if (probe?.retry != null) clearInterval(probe.retry);
  if (probe?.timeout != null) clearTimeout(probe.timeout);
  ref.current = null;
}

function sendBridgeProbe(probe: BridgeProbe, iframe: HTMLIFrameElement | null) {
  const now = Date.now();
  if (now >= probe.lastSent && now - probe.lastSent < 500) return;
  probe.lastSent = now;
  try {
    iframe?.contentWindow?.postMessage({ type: "webcontainer-preview-probe", version: 1, nonce: probe.nonce }, probe.origin);
  } catch { /* The iframe may be navigating. */ }
}

function safePreviewText(value: unknown): string {
  let text: string;
  try { text = typeof value === "string" ? value : String(value); } catch { text = "[无法显示]"; }
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").slice(0, 4000);
}

function safePreviewStack(value: string): string {
  return safePreviewText(value).replace(/https?:\/\/[^\s)]+/g, (source) => {
    try { const url = new URL(source); return url.origin + url.pathname; } catch { return "[无效地址]"; }
  });
}

// WebContainer is a strict singleton per page. Booting twice throws
// "Only a single WebContainer instance can be booted", so keep the instance
// (and its one-time boot) outside the component.
let bootPromise: Promise<WebContainer> | null = null;
let bootQueue: Promise<void> = Promise.resolve();
function getWebContainer(): Promise<WebContainer> {
  if (!bootPromise) {
    bootPromise = import("@webcontainer/api").then(({ WebContainer }) =>
      WebContainer.boot({ forwardPreviewErrors: true }),
    );
  }
  return bootPromise;
}

type Props = { workspaceId: string | null };

// A stored preview error: stable catalog key plus interpolation vars, rendered
// via the dictionary at display time so locale switches re-render it.
type PreviewError = { key: PreviewKey; vars?: Record<string, string> };

function renderPreviewError(pv: Messages["preview"], error: PreviewError): string {
  const leaf = pv[error.key];
  // Keys are stored with the exact vars their template needs; the union of
  // leaf signatures can't express that, so dispatch through a loose callable.
  return typeof leaf === "function" ? (leaf as (vars: Record<string, string>) => string)(error.vars ?? {}) : leaf;
}

export default function WebContainerPreview({ workspaceId: workspaceIdProp }: Props) {
  const pv = useMessages().preview;
  // The boot effect must not re-run on locale switch (it would remount the
  // workspace), so localized terminal/status writes read the catalog via ref.
  const pvRef = useRef(pv);
  useEffect(() => {
    pvRef.current = pv;
  }, [pv]);
  const terminalRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const terminalWriteRef = useRef<((message: string) => void) | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const previewPortRef = useRef<number | null>(null);
  const bridgeProbeRef = useRef<BridgeProbe | null>(null);
  const bridgeInstalledRef = useRef(false);
  const [consoleSize, setConsoleSize] = useState<ConsoleSize>("compact");
  const [status, setStatus] = useState<Status>("booting");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<PreviewError | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [view, setView] = useState<View>("preview");
  // Keep a handle on the running dev server so Stop can kill it without
  // tearing down the whole effect (WebContainer stays alive).
  const devRef = useRef<WebContainerProcess | null>(null);
  // Marks a dev-server kill as intentional (Stop button), so the exit handler
  // doesn't flag it as an error.
  const stoppedRef = useRef(false);

  useEffect(() => {
    let windowStart = 0;
    let count = 0;
    let errorCount = 0;
    const onMessage = (event: MessageEvent) => {
      if (!previewUrlRef.current || event.source !== iframeRef.current?.contentWindow) return;
      let origin: string;
      try { origin = new URL(previewUrlRef.current).origin; } catch { return; }
      if (event.origin !== origin || !event.data || typeof event.data !== "object") return;
      const data = event.data as { type?: unknown; version?: unknown; level?: unknown; text?: unknown; nonce?: unknown };
      if (data.type !== "webcontainer-preview-console" || data.version !== 1) return;
      if (data.level === "ready") {
        const probe = bridgeProbeRef.current;
        if (!probe || event.origin !== probe.origin) return;
        if (data.nonce === undefined && !probe.connected) {
          sendBridgeProbe(probe, iframeRef.current);
          return;
        }
        if (data.nonce !== probe.nonce) return;
        if (probe.retry !== null) clearInterval(probe.retry);
        if (probe.timeout !== null) clearTimeout(probe.timeout);
        probe.retry = null;
        probe.timeout = null;
        probe.connected = true;
        return;
      }
      if ((data.level !== "log" && data.level !== "info" && data.level !== "warn" && data.level !== "error-location") || typeof data.text !== "string" || data.text.length > 4000) return;
      const now = Date.now();
      if (now - windowStart >= 1000 || now < windowStart) { windowStart = now; count = 0; errorCount = 0; }
      if ((data.level === "error-location" ? errorCount++ : count++) >= 50) return;
      const label = data.level === "error-location" ? pvRef.current.previewLabelErrorLocation : data.level;
      terminalWriteRef.current?.(`${pvRef.current.termPreviewConsoleTag({ label })} ${safePreviewText(data.text)}\r\n`);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      clearBridgeProbe(bridgeProbeRef);
    };
  }, []);

  useEffect(() => {
    // Wait until a workspace has been selected before booting/mounting.
    if (!workspaceIdProp) return;
    const workspaceId = workspaceIdProp ?? WORKSPACE_ID_FALLBACK;
    let cancelled = false;
    let shell: WebContainerProcess | null = null;
    let dev: WebContainerProcess | null = null;
    let startingServer = false;
    let previewGeneration = 0;
    let terminal: { write(data: string): void; dispose(): void } | null = null;
    let observer: ResizeObserver | null = null;
    let writer: ((message: string) => void) | null = null;
    const processes = new Set<WebContainerProcess>();
    const unsubscribe: Array<() => void> = [];
    const controller = new AbortController();
    const addLog = (message: string) => {
      if (!cancelled) setLogs((previous) => [...previous, message.slice(-4000)].slice(-100));
    };
    const own = async (pending: Promise<WebContainerProcess>) => {
      const process = await pending;
      if (cancelled) { process.kill(); return null; }
      processes.add(process);
      void process.exit.then(() => processes.delete(process), () => processes.delete(process));
      return process;
    };

    async function fetchSnapshot(url: string): Promise<Response> {
      const response = await authenticatedFetch(url, { signal: controller.signal, cache: "no-store" });
      if (response.status === 404) {
        // No cached snapshot yet — trigger generation, then retry once.
        const gen = await authenticatedFetch(url, { method: "POST", signal: controller.signal });
        if (!gen.ok) {
          throw new Error(`snapshot generation failed (${gen.status})`);
        }
        return gen;
      }
      if (!response.ok) {
        throw new Error(`snapshot load failed (${response.status})`);
      }
      return response;
    }

    async function mountWorkspace(wc: WebContainer): Promise<void> {
      const url = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/snapshot`;
      const response = await fetchSnapshot(url);
      if (cancelled) return;
      if (response.headers.get("x-webcontainer-snapshot-format") !== "webcontainer-snapshot-v1") {
        throw new Error("unsupported webcontainer snapshot format");
      }
      await wc.mount(new Uint8Array(await response.arrayBuffer()));
    }

    async function boot() {
      try {
        stoppedRef.current = false;
        previewUrlRef.current = null;
        previewPortRef.current = null;
        bridgeInstalledRef.current = false;
        clearBridgeProbe(bridgeProbeRef);
        setStatus("booting");
        setPreviewUrl(null);
        setError(null);
        setLogs([]);
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
        ]);
        await import("@xterm/xterm/css/xterm.css");
        if (cancelled || !terminalRef.current) return;

        const host = terminalRef.current;
        const xterm = new Terminal({
          convertEol: true,
          fontSize: 13,
          scrollback: 1000,
          fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace",
          theme: {
            background: "#ffffff",
            foreground: "#000000",
            cursor: "#000000",
            selectionBackground: "#00000033",
          },
        });
        terminal = xterm;
        const fitAddon = new FitAddon();
        xterm.loadAddon(fitAddon);
        xterm.open(host);
        writer = (message) => {
          if (cancelled) return;
          xterm.write(message);
          addLog(message);
        };
        terminalWriteRef.current = writer;
        const fit = () => {
          if (cancelled || !host.clientWidth || !host.clientHeight) return;
          fitAddon.fit();
          try { shell?.resize({ cols: xterm.cols, rows: xterm.rows }); } catch { /* shell may have exited */ }
        };
        observer = new ResizeObserver(fit);
        observer.observe(host);
        fit();
        writer(pvRef.current.termBooting);

        // Singleton boot — safe to call on every effect run (refresh).
        const container = await getWebContainer();
        if (cancelled) return;
        unsubscribe.push(container.on("error", ({ message }) => {
          writer?.(`[WebContainer] ${safePreviewText(message)}\r\n`);
          if (!cancelled) { setStatus("error"); setError({ key: "errorWebcontainerRuntime" }); }
        }));
        unsubscribe.push(container.on("preview-message", (message) => {
          if (message.port !== previewPortRef.current) return;
          const detail = "message" in message ? safePreviewText(message.message) : message.args.slice(0, 10).map(safePreviewText).join(" ");
          if (message.type === "PREVIEW_UNCAUGHT_EXCEPTION" && detail === "Uncaught SyntaxError: Unexpected end of input") {
            const firstFrame = message.stack?.split(/\r?\n/).find((line) => line.trimStart().startsWith("at "));
            const frameUrl = firstFrame?.match(/https?:\/\/[^\s)]+/)?.[0].replace(/:\d+(?::\d+)?$/, "");
            try {
              if (frameUrl && previewUrlRef.current) {
                const source = new URL(frameUrl);
                if (source.origin === new URL(previewUrlRef.current).origin && source.pathname === "/.webcontainer@wc-api-script.js") return;
              }
            } catch { /* Unknown sources remain visible. */ }
          }
          writer?.(`${pvRef.current.termPreviewErrorTag} ${detail.slice(0, 4000)}\r\n`);
          if (message.stack) {
            const stack = safePreviewStack(message.stack);
            if (stack && stack !== detail) writer?.(`${pvRef.current.termPreviewStackTag} ${stack}\r\n`);
          }
        }));
        unsubscribe.push(container.on("server-ready", (port, url) => {
          if (cancelled || stoppedRef.current || !startingServer) return;
          const generation = ++previewGeneration;
          const showPreview = () => {
            if (cancelled || stoppedRef.current || generation !== previewGeneration) return;
            if (previewUrlRef.current !== url) clearBridgeProbe(bridgeProbeRef);
            previewPortRef.current = port;
            previewUrlRef.current = url;
            setPreviewUrl(url);
            setStatus("ready");
          };
          // Wait briefly for the listener before rendering the iframe.
          void (async () => {
            for (let attempt = 0; attempt < 20; attempt++) {
              if (cancelled || stoppedRef.current || generation !== previewGeneration) return;
              try {
                const probe = await fetch(url, { mode: "no-cors", cache: "no-store", signal: controller.signal });
                if (probe) {
                  showPreview();
                  return;
                }
              } catch {
                // Listener not ready yet — retry.
              }
              await new Promise((resolve) => setTimeout(resolve, 400));
            }
            showPreview();
          })();
        }));
        try {
          const script = new URL("/preview-console.js", window.location.origin);
          script.searchParams.set("parentOrigin", window.location.origin);
          await container.setPreviewScript(script.href, { async: false, defer: false });
          if (cancelled) return;
          bridgeInstalledRef.current = true;
        } catch {
          // The optional preview log bridge must not interrupt the app or process logs.
        }
        if (cancelled) return;

        setStatus("loading");
        writer?.(pvRef.current.termLoadingSnapshot);
        await mountWorkspace(container);
        if (cancelled) return;

        const pipeOutput = (process: WebContainerProcess) => {
          void process.output.pipeTo(new WritableStream({ write(data: string) { writer?.(data); } })).catch(() => {
            if (!cancelled && !stoppedRef.current) writer?.(pvRef.current.termOutputLost);
          });
        };
        shell = await own(container.spawn("jsh", { terminal: { cols: xterm.cols, rows: xterm.rows }, env: PACKAGE_MANAGER_ENV }));
        if (!shell) return;
        pipeOutput(shell);
        fit();

        setStatus("installing");
        writer?.(pvRef.current.termInstalling);
        // Use the browser container's mirror and force the portable CSS binding.
        const install = await own(container.spawn("pnpm", ["install", "--prefer-offline"], {
          env: { ...PACKAGE_MANAGER_ENV, LIGHTNINGCSS_FORCE_WASM: "1" },
        }));
        if (!install) return;
        pipeOutput(install);
        if ((await install.exit) !== 0) throw new Error("`pnpm install` failed inside the WebContainer");
        if (cancelled) return;

        setStatus("starting");
        writer?.(pvRef.current.termStarting);
        // Clear potentially stale WebContainer build output before starting.
        const clean = await own(container.spawn("rm", ["-rf", ".next"]));
        if (!clean) return;
        await clean.exit;
        if (cancelled) return;
        startingServer = true;
        dev = await own(container.spawn("pnpm", ["run", "dev"], { env: PACKAGE_MANAGER_ENV }));
        if (!dev) return;
        const runningDev = dev;
        devRef.current = runningDev;
        pipeOutput(runningDev);
        void runningDev.exit.then((code) => {
          if (devRef.current === runningDev) devRef.current = null;
          if (!cancelled && code !== 0 && !stoppedRef.current) {
            writer?.(pvRef.current.termDevExited({ code: String(code) }));
            setStatus("error");
            setError({ key: "errorDevServerExited", vars: { code: String(code) } });
          }
        }).catch(() => {
          if (!cancelled && !stoppedRef.current) {
            writer?.(pvRef.current.termDevStateUnknown);
            setStatus("error");
            setError({ key: "errorDevServerState" });
          }
        });
      } catch (reason) {
        if (!cancelled) {
          console.error("WebContainer startup failed", reason);
          writer?.(pvRef.current.termBootFailed);
          setStatus("error");
          setError({ key: "errorBootFailed" });
        }
      }
    }

    // A stale mount must finish or cancel before the singleton mounts another workspace.
    bootQueue = bootQueue.catch(() => {}).then(async () => { if (!cancelled) await boot(); });
    return () => {
      cancelled = true;
      controller.abort();
      clearBridgeProbe(bridgeProbeRef);
      observer?.disconnect();
      for (const off of unsubscribe) off();
      for (const process of processes) {
        try { process.kill(); } catch { /* process already exited */ }
      }
      if (devRef.current === dev) devRef.current = null;
      if (terminalWriteRef.current === writer) terminalWriteRef.current = null;
      terminal?.dispose();
    };
  }, [refreshKey, workspaceIdProp]);

  // SSO popup relay: the preview iframe is cross-origin to this page, so the
  // browser blocks window.open called from inside it. When the workspace app
  // asks us to open the Azure login popup (sso:open), we open it here at the
  // top level (where window.open is allowed), listen for the relay page to
  // postMessage the auth code back to window.opener, then forward { code, state }
  // to the iframe so it can complete the PKCE token exchange. No secrets pass
  // through us — the PKCE verifier stays in the iframe.
  useEffect(() => {
    type OpenRequest = { type: "sso:open"; requestId: string; url: string; relayOrigin: string };
    type RelayCode = { type: "sso:code"; code: string; state: string };
    type RelayError = { type: "sso:error"; error: string };

    let popup: Window | null = null;
    let closedWatcher: number | undefined;
    let pendingRequestId: string | null = null;
    let pendingSource: Window | null = null;

    function onMessage(event: MessageEvent) {
      const data = event.data as OpenRequest | RelayCode | RelayError | null;
      if (!data || typeof data !== "object") return;

      if (data.type === "sso:open") {
        // Request from the iframe to open the popup at the top level.
        pendingRequestId = data.requestId;
        pendingSource = event.source as Window | null;
        popup = window.open(data.url, "azure-login", "width=600,height=700");
        if (!popup) {
          forward({ error: pvRef.current.ssoPopupBlocked });
          return;
        }
        closedWatcher = window.setInterval(() => {
          if (popup?.closed) {
            window.clearInterval(closedWatcher);
            forward({ error: pvRef.current.ssoPopupClosed });
          }
        }, 500);
      } else if (data.type === "sso:code") {
        // Relay page posted the auth code to window.opener (us). Forward it to
        // the iframe that originated the request.
        forward({ code: data.code, state: data.state });
      } else if (data.type === "sso:error") {
        forward({ error: data.error });
      }
    }

    function forward(payload: { code?: string; state?: string; error?: string }) {
      if (closedWatcher) window.clearInterval(closedWatcher);
      pendingSource?.postMessage(
        { type: "sso:code-relay", requestId: pendingRequestId, ...payload },
        "*",
      );
      popup?.close();
      pendingRequestId = null;
      pendingSource = null;
    }

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      if (closedWatcher) window.clearInterval(closedWatcher);
      popup?.close();
    };
  }, []);

  function refresh() {
    if (status !== "ready" && status !== "error" && status !== "stopped") return;
    clearBridgeProbe(bridgeProbeRef);
    setRefreshKey((k) => k + 1);
  }

  function stop() {
    // Kill the dev server only — the WebContainer and its installed packages
    // stay alive, so Start (refresh) is fast.
    stoppedRef.current = true;
    devRef.current?.kill();
    devRef.current = null;
    previewUrlRef.current = null;
    previewPortRef.current = null;
    clearBridgeProbe(bridgeProbeRef);
    terminalWriteRef.current?.(pvRef.current.termStopped);
    setPreviewUrl(null);
    setStatus("stopped");
  }

  const statusLabel: Record<Status, string> = { booting: pv.statusBooting, loading: pv.statusLoading, installing: pv.statusInstalling, starting: pv.statusStarting, ready: pv.statusReady, stopped: pv.statusStopped, error: pv.statusError };

  const terminalHeight = consoleSize === "expanded" ? "50%" : "clamp(80px, 25%, 150px)";

  function onPreviewLoad() {
    clearBridgeProbe(bridgeProbeRef);
    if (!bridgeInstalledRef.current || !previewUrlRef.current || !iframeRef.current?.contentWindow) return;
    let origin: string;
    try { origin = new URL(previewUrlRef.current).origin; } catch { return; }
    const probe: BridgeProbe = { nonce: crypto.randomUUID(), origin, connected: false, lastSent: -Infinity, retry: null, timeout: null };
    bridgeProbeRef.current = probe;
    const send = () => {
      if (bridgeProbeRef.current === probe && !probe.connected && probe.retry !== null) sendBridgeProbe(probe, iframeRef.current);
    };
    probe.retry = setInterval(send, 500);
    probe.timeout = setTimeout(() => {
      if (bridgeProbeRef.current !== probe || probe.connected) return;
      if (probe.retry !== null) clearInterval(probe.retry);
      probe.retry = null;
      probe.timeout = null;
      probe.lastSent = -Infinity;
    }, 5000);
    send();
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-white">
      <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--brand-line)] bg-[var(--brand-paper)] px-3 py-2">
        {/* Preview / Code tab toggle */}
        <div className="flex shrink-0 rounded-md border border-[#cbd1c0] bg-white p-0.5">
          {(["preview", "code"] as const).map((candidate) => (
            <IconTooltip key={candidate} align="left" label={candidate === "preview" ? pv.tabPreview : pv.tabCode}>
              <button
                type="button"
                onClick={() => setView(candidate)}
                aria-label={candidate === "preview" ? pv.tabPreview : pv.tabCode}
                aria-pressed={view === candidate}
                className={`flex h-10 w-10 items-center justify-center rounded ${
                  view === candidate ? "bg-[var(--brand-ink)] text-white" : "text-[var(--brand-muted)] hover:bg-[#eff5d9]"
                }`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                  {candidate === "preview" ? (
                    <><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M8 21h8M12 18v3" /></>
                  ) : (
                    <><path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" /></>
                  )}
                </svg>
              </button>
            </IconTooltip>
          ))}
        </div>
        {view === "preview" && (
          <span role="status" title={statusLabel[status]} className="flex min-w-0 items-center gap-1.5 text-[13px] text-neutral-500">
            <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${status === "ready" ? "bg-emerald-500" : status === "error" ? "bg-red-500" : status === "stopped" ? "bg-neutral-400" : "animate-pulse bg-amber-500 motion-reduce:animate-none"}`} />
            <span className="sr-only sm:not-sr-only sm:truncate">{statusLabel[status]}</span>
          </span>
        )}
        {view === "preview" && (
          <>
            <div className="ml-auto" />
            {status === "ready" && (
              <IconTooltip label={pv.actionStopHint}>
                <button
                  type="button"
                  onClick={stop}
                  aria-label={pv.actionStop}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-red-300 text-red-600 hover:bg-red-50"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="1" />
                  </svg>
                </button>
              </IconTooltip>
            )}
            <IconTooltip label={status === "stopped" ? pv.actionStart : pv.actionRefreshHint}>
              <button
                type="button"
                onClick={refresh}
                disabled={status !== "ready" && status !== "error" && status !== "stopped"}
                aria-label={status === "stopped" ? pv.actionStart : pv.actionRefresh}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[#cbd1c0] bg-white text-[var(--brand-ink)] hover:bg-[#eff5d9] disabled:pointer-events-none disabled:opacity-40"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                  {status === "stopped" ? <path d="m8 5 11 7-11 7z" /> : <><path d="M20 7v5h-5" /><path d="M20 12a8 8 0 1 0-2.3 5.7" /></>}
                </svg>
              </button>
            </IconTooltip>
            <IconTooltip label={consoleSize === "hidden" ? pv.actionShowTerminal : pv.actionHideTerminal}>
              <button
                type="button"
                onClick={() => setConsoleSize((size) => size === "hidden" ? "compact" : "hidden")}
                aria-label={consoleSize === "hidden" ? pv.actionShowTerminal : pv.actionHideTerminal}
                aria-expanded={consoleSize !== "hidden"}
                aria-controls="preview-console"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[#cbd1c0] bg-white text-[var(--brand-ink)] hover:bg-[#eff5d9]"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M12 15h5" />
                </svg>
              </button>
            </IconTooltip>
          </>
        )}
      </div>
      {view === "code" && (
        <div className="min-h-0 flex-1">
          {workspaceIdProp ? <CodeEditor workspaceId={workspaceIdProp} /> : null}
        </div>
      )}
      <div className={view === "preview" ? "relative min-h-0 flex-1" : "hidden"}>
        {previewUrl ? <iframe ref={iframeRef} src={previewUrl} onLoad={onPreviewLoad} title={pv.iframeTitle} className="h-full w-full bg-white" allow="popups; popups-to-escape-sandbox; scripts; same-origin" referrerPolicy="no-referrer" /> : <div className="flex h-full flex-col items-center justify-center gap-3 text-neutral-500">
          {status === "error" ? <><p className="max-w-md px-4 text-center text-sm font-medium text-red-600">{error ? renderPreviewError(pv, error) : pv.statusError}</p><p className="max-w-md px-4 text-center text-[13px] text-neutral-500">{pv.errorCheckTerminal}</p>{logs.length > 0 && <pre className="max-h-40 max-w-xl overflow-auto rounded bg-neutral-100 p-3 text-left text-[13px] text-neutral-700">{logs.join("")}</pre>}</> : status === "stopped" ? <><p className="text-sm font-medium text-neutral-600">{pv.stoppedTitle}</p><p className="text-[13px] text-neutral-400">{pv.stoppedBody}</p></> : <><div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-[var(--brand-purple)]" /><p className="text-sm">{statusLabel[status]}</p><p className="text-[13px] text-neutral-400">{pv.loadingHint}</p></>}
        </div>}
      </div>

      <div
        role="separator"
        aria-orientation="horizontal"
        className={view === "preview" && consoleSize !== "hidden" ? "h-1 shrink-0 bg-[#e1e7d4]" : "hidden"}
      />
      <div
        id="preview-console"
        className={view === "preview" && consoleSize !== "hidden" ? "flex min-h-0 shrink-0 flex-col border-t border-[var(--brand-line)]" : "hidden"}
        style={{ height: terminalHeight, maxHeight: "50%" }}
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--brand-line)] bg-[#f0f2e9] px-3">
          <span className="text-[#799b39]" aria-hidden="true">●</span>
          <span className="text-[13px] font-bold text-[var(--brand-ink)]">{pv.terminalTitle}</span>
          <IconTooltip className="ml-auto" label={consoleSize === "expanded" ? pv.actionCollapseTerminal : pv.actionExpandTerminal}>
            <button
              type="button"
              onClick={() => setConsoleSize((size) => size === "expanded" ? "compact" : "expanded")}
              aria-label={consoleSize === "expanded" ? pv.actionCollapseTerminal : pv.actionExpandTerminal}
              className="flex h-8 w-8 items-center justify-center rounded text-[var(--brand-muted)] hover:bg-[#e1e7d4]"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                {consoleSize === "expanded" ? <path d="m7 10 5 5 5-5" /> : <path d="m7 14 5-5 5 5" />}
              </svg>
            </button>
          </IconTooltip>
          <IconTooltip label={pv.actionHideTerminal}>
            <button
              type="button"
              onClick={() => setConsoleSize("hidden")}
              aria-label={pv.actionHideTerminal}
              className="flex h-8 w-8 items-center justify-center rounded text-[var(--brand-muted)] hover:bg-[#e1e7d4]"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-4 w-4" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </IconTooltip>
        </div>
        <div ref={terminalRef} className="min-h-0 flex-1 bg-white px-2 py-1" />
      </div>
    </div>
  );
}
