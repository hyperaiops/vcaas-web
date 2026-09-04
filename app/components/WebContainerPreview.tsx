"use client";

import { useEffect, useRef, useState } from "react";
import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import { toFileSystemTree, type TreeResponse } from "@/app/lib/webcontainer-tree";

type Status = "booting" | "loading" | "installing" | "starting" | "ready" | "stopped" | "error";
type MountMode = "tree" | "snapshot";
type Source = { status: "ready" | "unavailable" | "pending" | "failed"; href?: string };
type Manifest = {
  workspace: { id: string; revision: string };
  defaultMountSource: MountMode;
  mountSources: { tree: Source; snapshot: Source };
};

const WORKSPACE_ID = process.env.NEXT_PUBLIC_WEBCONTAINER_WORKSPACE_ID ?? "workspace";

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

function sourceURL(workspaceId: string, mode: MountMode): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/${mode}`;
}

export default function WebContainerPreview() {
  const terminalRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("booting");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<MountMode>("snapshot");
  const [mounted, setMounted] = useState(false);
  const [snapshotAvailable, setSnapshotAvailable] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  // Keep a handle on the running dev server so Stop can kill it without
  // tearing down the whole effect (WebContainer stays alive).
  const devRef = useRef<WebContainerProcess | null>(null);
  // Marks a dev-server kill as intentional (Stop button), so the exit handler
  // doesn't flag it as an error.
  const stoppedRef = useRef(false);

  useEffect(() => {
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

    async function fetchJSON<T>(url: string): Promise<T> {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`Workspace API request failed (${response.status}).`);
      return response.json() as Promise<T>;
    }

    async function mountWorkspace(wc: WebContainer): Promise<void> {
      const manifest = await fetchJSON<Manifest>(`/api/workspaces/${encodeURIComponent(WORKSPACE_ID)}`);
      if (cancelled) return;
      setSnapshotAvailable(manifest.mountSources.snapshot.status === "ready");
      // Fall back to tree for this mount cycle if snapshot isn't ready, but
      // DON'T setMode("tree") — changing state here would re-trigger this
      // effect in a loop and undo the user's button click.
      const selectedMode = mode === "snapshot" && manifest.mountSources.snapshot.status === "ready" ? mode : "tree";
      const response = await fetch(sourceURL(manifest.workspace.id, selectedMode), {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Failed to load ${selectedMode} mount source (${response.status}): ${body.slice(0, 300)}`);
      }
      if (selectedMode === "snapshot") {
        if (response.headers.get("x-webcontainer-snapshot-format") !== "webcontainer-snapshot-v1") {
          throw new Error("The API returned an unsupported WebContainer snapshot format.");
        }
        await wc.mount(new Uint8Array(await response.arrayBuffer()));
      } else {
        await wc.mount(toFileSystemTree(await response.json() as TreeResponse));
      }
    }

    async function boot() {
      try {
        stoppedRef.current = false;
        setStatus("booting");
        setPreviewUrl(null);
        setError(null);
        setMounted(false);
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

        // Singleton boot — safe to call on every effect run (mode switch).
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
        setMounted(true);

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
  }, [mode, refreshKey]);

  function chooseMode(nextMode: MountMode) {
    if (nextMode === mode || (nextMode === "snapshot" && !snapshotAvailable)) return;
    if (mounted && !window.confirm("Switching mount mode re-mounts the workspace and restarts the dev server. Installed packages are kept, but unsaved container changes are lost. Continue?")) return;
    setMode(nextMode);
  }

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
        <span className="text-xs font-medium tracking-wide text-neutral-600 uppercase">Preview</span>
        <span className="flex items-center gap-1.5 text-xs text-neutral-500">
          <span className={`h-1.5 w-1.5 rounded-full ${status === "ready" ? "bg-emerald-500" : status === "error" ? "bg-red-500" : status === "stopped" ? "bg-neutral-400" : "animate-pulse bg-amber-500"}`} />
          {statusLabel[status]}
        </span>
        <div className="ml-auto flex rounded border border-neutral-300 p-0.5 text-xs">
          {(["tree", "snapshot"] as const).map((candidate) => (
            <button key={candidate} type="button" disabled={candidate === "snapshot" && !snapshotAvailable} onClick={() => chooseMode(candidate)} className={`rounded px-2 py-0.5 ${mode === candidate ? "bg-blue-600 text-white" : "text-neutral-600 hover:bg-neutral-100"} disabled:cursor-not-allowed disabled:opacity-40`}>
              {candidate === "tree" ? "File Tree" : "Snapshot"}
            </button>
          ))}
        </div>
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
        {previewUrl && <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="rounded border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 no-underline hover:bg-neutral-100">Open in new tab ↗</a>}
      </div>
      <div className="relative min-h-0 flex-1">
        {previewUrl ? <iframe src={previewUrl} title="WebContainer preview" className="h-full w-full bg-white" /> : <div className="flex h-full flex-col items-center justify-center gap-3 text-neutral-500">
          {status === "error" ? <><p className="max-w-md px-4 text-center text-sm font-medium text-red-600">{error}</p><p className="max-w-md px-4 text-center text-xs text-neutral-500">Check the terminal output below, then confirm the workspace API is running and reload.</p>{logs.length > 0 && <pre className="max-h-40 max-w-xl overflow-auto rounded bg-neutral-100 p-3 text-left text-[11px] text-neutral-700">{logs.join("")}</pre>}</> : status === "stopped" ? <><p className="text-sm font-medium text-neutral-600">Dev server stopped</p><p className="text-xs text-neutral-400">Click Start to run it again — the container and installed packages are still warm.</p></> : <><div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-blue-600" /><p className="text-sm">{statusLabel[status]}</p><p className="text-xs text-neutral-400">Loading the workspace through {mode === "tree" ? "File Tree" : "Snapshot"} mode.</p></>}
        </div>}
      </div>

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
    </div>
  );
}
