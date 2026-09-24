"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { WebContainer, WebContainerProcess } from "@webcontainer/api";

// Monaco is large — only load the code editor when the Code tab is opened.
const CodeEditor = dynamic(() => import("@/app/components/CodeEditor"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-neutral-500">
      Loading editor…
    </div>
  ),
});

type View = "preview" | "code";

type Status = "booting" | "loading" | "installing" | "starting" | "ready" | "stopped" | "error";

const WORKSPACE_ID_FALLBACK = "workspace";

// WebContainer is a strict singleton per page. Booting twice throws
// "Only a single WebContainer instance can be booted", so keep the instance
// (and its one-time boot) outside the component.
let bootPromise: Promise<WebContainer> | null = null;
function getWebContainer(): Promise<WebContainer> {
  if (!bootPromise) {
    bootPromise = import("@webcontainer/api").then(({ WebContainer }) =>
      WebContainer.boot({ forwardPreviewErrors: true }),
    );
  }
  return bootPromise;
}

type Props = { workspaceId: string | null };

export default function WebContainerPreview({ workspaceId: workspaceIdProp }: Props) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("booting");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [view, setView] = useState<View>("preview");
  // Keep a handle on the running dev server so Stop can kill it without
  // tearing down the whole effect (WebContainer stays alive).
  const devRef = useRef<WebContainerProcess | null>(null);
  // Marks a dev-server kill as intentional (Stop button), so the exit handler
  // doesn't flag it as an error.
  const stoppedRef = useRef(false);

  useEffect(() => {
    // Wait until a workspace has been selected before booting/mounting.
    if (!workspaceIdProp) return;
    const workspaceId = workspaceIdProp ?? WORKSPACE_ID_FALLBACK;
    let cancelled = false;
    let shell: WebContainerProcess | null = null;
    let dev: WebContainerProcess | null = null;
    let terminal: { write(data: string): void; dispose(): void } | null = null;
    const controller = new AbortController();
    // Killing a container process rejects the pending pipeTo() promise with
    // "Process aborted". Swallowing it here keeps it out of unhandledRejection.
    const ignoreAbort = () => {};
    const addLog = (message: string) => {
      if (!cancelled) setLogs((previous) => [...previous, message].slice(-100));
    };

    async function fetchSnapshot(url: string): Promise<Response> {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (response.status === 404) {
        // No cached snapshot yet — trigger generation, then retry once.
        const gen = await fetch(url, { method: "POST", signal: controller.signal });
        if (!gen.ok) {
          const body = await gen.text();
          throw new Error(`Failed to generate snapshot (${gen.status}): ${body.slice(0, 300)}`);
        }
        return gen;
      }
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Failed to load snapshot (${response.status}): ${body.slice(0, 300)}`);
      }
      return response;
    }

    async function mountWorkspace(wc: WebContainer): Promise<void> {
      const url = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/snapshot`;
      const response = await fetchSnapshot(url);
      if (cancelled) return;
      if (response.headers.get("x-webcontainer-snapshot-format") !== "webcontainer-snapshot-v1") {
        throw new Error("The API returned an unsupported WebContainer snapshot format.");
      }
      await wc.mount(new Uint8Array(await response.arrayBuffer()));
    }

    async function boot() {
      try {
        stoppedRef.current = false;
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

        const xterm = new Terminal({
          convertEol: true,
          fontSize: 11,
          fontFamily: "var(--font-geist-mono), monospace",
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
        xterm.open(terminalRef.current);
        fitAddon.fit();

        // Singleton boot — safe to call on every effect run (refresh).
        const container = await getWebContainer();
        if (cancelled) return;
        container.on("error", ({ message }) => {
          addLog(`WebContainer error: ${message}`);
          if (!cancelled) { setStatus("error"); setError(`WebContainer error: ${message}`); }
        });
        container.on("preview-message", (message) => {
          const detail = "message" in message ? message.message : message.args.map(String).join(" ");
          addLog(`Preview error: ${detail}`);
        });
        container.on("server-ready", (_port, url) => {
          // The iframe must load once the HTTP listener is actually up.
          // Deferring with a short retry prevents the "blank first paint"
          // that happens when the frame races the listener.
          void (async () => {
            for (let attempt = 0; attempt < 20; attempt++) {
              if (cancelled) return;
              try {
                const probe = await fetch(url, { mode: "no-cors", cache: "no-store" });
                if (probe) {
                  if (!cancelled) { setPreviewUrl(url); setStatus("ready"); }
                  return;
                }
              } catch {
                // Listener not ready yet — retry.
              }
              await new Promise((resolve) => setTimeout(resolve, 400));
            }
            if (!cancelled) { setPreviewUrl(url); setStatus("ready"); }
          })();
        });

        setStatus("loading");
        await mountWorkspace(container);
        if (cancelled) return;

        shell = await container.spawn("jsh", { terminal: { cols: xterm.cols, rows: xterm.rows } });
        const shellOutput = new WritableStream({ write(data: string) { xterm.write(data); addLog(data); } });
        shell.output.pipeTo(shellOutput).catch(ignoreAbort);
        // Keep the shell running for npm/vite output, but make the terminal
        // read-only — users shouldn't type into it.
        // xterm.onData((data) => { void input.write(data); });

        setStatus("installing");
        // pnpm is faster than npm inside WebContainer (content-addressed
        // store survives container restarts), and LIGHTNINGCSS_FORCE_WASM=1
        // keeps Tailwind v4 from downloading the native linux-x64 binding.
        const install = await container.spawn("pnpm", ["install", "--prefer-offline"], {
          env: { LIGHTNINGCSS_FORCE_WASM: "1" },
        });
        install.output.pipeTo(new WritableStream({ write(data: string) { xterm.write(data); addLog(data); } })).catch(ignoreAbort);
        if ((await install.exit) !== 0) throw new Error("`pnpm install` failed inside the WebContainer.");
        if (cancelled) return;

        setStatus("starting");
        // Turbo/webpack cache dirs can be corrupted inside a snapshot
        // (e.g. after COEP isolation changes), which makes the dev server
        // silently render a blank page. Clearing it forces a clean compile.
        const clean = await container.spawn("rm", ["-rf", ".next"]);
        await clean.exit;
        // The workspace's package.json already forces webpack (Turbopack
        // needs native bindings that WASM-only WebContainer can't provide).
        dev = await container.spawn("pnpm", ["run", "dev"]);
        devRef.current = dev;
        dev.output.pipeTo(new WritableStream({ write(data: string) { xterm.write(data); addLog(data); } })).catch(ignoreAbort);
        void dev.exit.then((code) => {
          const wasStopped = stoppedRef.current;
          devRef.current = null;
          // A kill from the Stop button is expected — don't report it as an error.
          if (!cancelled && code !== 0 && !wasStopped) {
            addLog(`Dev server exited with code ${code}.`);
            setStatus("error");
            setError(`The development server exited with code ${code}. Check the terminal output below.`);
          }
        });
      } catch (reason) {
        if (!cancelled) { setStatus("error"); setError(reason instanceof Error ? reason.message : "Failed to start WebContainer."); }
      }
    }

    void boot();
    return () => {
      cancelled = true;
      controller.abort();
      // Do NOT call container.teardown() here — it races the boot/mount
      // pipeline and surfaces as "unhandledRejection: Process aborted".
      // Killing the child processes is enough; the container itself is
      // a singleton that lives until the page unloads.
      dev?.kill();
      shell?.kill();
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
          forward({ error: "Popup blocked — allow popups for this site and try again." });
          return;
        }
        closedWatcher = window.setInterval(() => {
          if (popup?.closed) {
            window.clearInterval(closedWatcher);
            forward({ error: "Sign-in window was closed before completing." });
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
    setRefreshKey((k) => k + 1);
  }

  function stop() {
    // Kill the dev server only — the WebContainer and its installed packages
    // stay alive, so Start (refresh) is fast.
    stoppedRef.current = true;
    devRef.current?.kill();
    devRef.current = null;
    setPreviewUrl(null);
    setStatus("stopped");
  }

  const statusLabel: Record<Status, string> = { booting: "Booting…", loading: "Loading workspace…", installing: "Installing…", starting: "Starting server…", ready: "Running", stopped: "Stopped", error: "Error" };

  // Fixed terminal size: small while loading, larger once running (derived,
  // no state/effect needed).
  const terminalHeight = status === "ready" ? 30 : 15; // percentage

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-200 px-3">
        {/* Preview / Code tab toggle */}
        <div className="flex rounded border border-neutral-300 p-0.5 text-xs">
          {(["preview", "code"] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => setView(candidate)}
              className={`rounded px-2 py-0.5 ${
                view === candidate ? "bg-blue-600 text-white" : "text-neutral-600 hover:bg-neutral-100"
              }`}
            >
              {candidate === "preview" ? "Preview" : "Code"}
            </button>
          ))}
        </div>
        {view === "preview" && (
          <span className="flex items-center gap-1.5 text-xs text-neutral-500">
            <span className={`h-1.5 w-1.5 rounded-full ${status === "ready" ? "bg-emerald-500" : status === "error" ? "bg-red-500" : status === "stopped" ? "bg-neutral-400" : "animate-pulse bg-amber-500"}`} />
            {statusLabel[status]}
          </span>
        )}
        {view === "preview" && (
          <>
            <div className="ml-auto" />
            {status === "ready" && (
              <button
                type="button"
                onClick={stop}
                title="Stop the dev server (WebContainer stays alive)"
                className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50"
              >
                Stop
              </button>
            )}
            <button
              type="button"
              onClick={refresh}
              disabled={status !== "ready" && status !== "error" && status !== "stopped"}
              title="Re-mount the workspace and restart the dev server"
              className="rounded border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {status === "stopped" ? "Start" : "Refresh"}
            </button>
            {previewUrl && (
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard
                    .writeText(previewUrl)
                    .then(() => {
                      setCopiedUrl(true);
                      window.setTimeout(() => setCopiedUrl(false), 1500);
                    })
                    .catch(() => {});
                }}
                title="Click to copy the preview URL"
                className="flex max-w-[16rem] items-center gap-1 truncate rounded border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-3 w-3 shrink-0"
                  aria-hidden="true"
                >
                  {copiedUrl ? (
                    <polyline points="20 6 9 17 4 12" />
                  ) : (
                    <>
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </>
                  )}
                </svg>
                <span className="truncate">{previewUrl}</span>
              </button>
            )}
          </>
        )}
      </div>
      {view === "code" ? (
        <div className="min-h-0 flex-1">
          {workspaceIdProp ? <CodeEditor workspaceId={workspaceIdProp} /> : null}
        </div>
      ) : (
      <div className="relative min-h-0 flex-1">
        {previewUrl ? <iframe src={previewUrl} title="WebContainer preview" className="h-full w-full bg-white" allow="popups; popups-to-escape-sandbox; scripts; same-origin" referrerPolicy="no-referrer" /> : <div className="flex h-full flex-col items-center justify-center gap-3 text-neutral-500">
          {status === "error" ? <><p className="max-w-md px-4 text-center text-sm font-medium text-red-600">{error}</p><p className="max-w-md px-4 text-center text-xs text-neutral-500">Check the terminal output below, then confirm the workspace API is running and reload.</p>{logs.length > 0 && <pre className="max-h-40 max-w-xl overflow-auto rounded bg-neutral-100 p-3 text-left text-[11px] text-neutral-700">{logs.join("")}</pre>}</> : status === "stopped" ? <><p className="text-sm font-medium text-neutral-600">Dev server stopped</p><p className="text-xs text-neutral-400">Click Start to run it again — the container and installed packages are still warm.</p></> : <><div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-blue-600" /><p className="text-sm">{statusLabel[status]}</p><p className="text-xs text-neutral-400">Loading the workspace through Snapshot mode.</p></>}
        </div>}
      </div>
      )}

      {view === "preview" && (
        <>
          {/* Visual divider for terminal — fixed, not draggable */}
          <div
            role="separator"
            aria-orientation="horizontal"
            className="h-1 shrink-0 bg-neutral-300"
          />

          <div
            className="flex min-h-0 flex-col border-t border-neutral-300"
            style={{ height: `${terminalHeight}%` }}
          >
            <div className="flex h-9 shrink-0 items-center border-b border-neutral-200 px-3"><span className="text-xs font-medium tracking-wide text-neutral-600 uppercase">Terminal</span></div>
            <div ref={terminalRef} className="min-h-0 flex-1 bg-white px-2 py-1" />
          </div>
        </>
      )}
    </div>
  );
}
