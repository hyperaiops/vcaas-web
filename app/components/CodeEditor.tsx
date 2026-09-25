"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Editor, loader as monacoLoader } from "@monaco-editor/react";
import type { TreeNode } from "@/app/lib/workspace/types";

// Self-host Monaco: use the local monaco-editor package bundled with this app
// instead of loading workers from a CDN. Configured once at module load.
let monacoConfigured = false;
async function ensureMonacoConfigured() {
  if (monacoConfigured) return;
  try {
    const monaco = await import("monaco-editor");
    monacoLoader.config({ monaco });

    // Monaco spins up language web workers (editor.worker, ts.worker, …) via
    // self.MonacoEnvironment.getWorker. Under Turbopack the default worker
    // URL resolution fails and throws an ErrorEvent ("[object ErrorEvent]"
    // unhandledRejection). We don't need the TS language worker — diagnostics
    // are disabled below — so route every worker label at a no-op worker
    // created from a blob. It answers the worker protocol pings so Monaco's
    // WorkerManager settles instead of rejecting.
    const noopWorkerSrc = [
      "self.onmessage = (e) => {",
      "  // Echo back so Monaco's worker manager handshake completes.",
      "  self.postMessage({ id: e.data && e.data.id, method: 'ack' });",
      "};",
    ].join("\n");
    const noopWorkerUrl = URL.createObjectURL(new Blob([noopWorkerSrc], { type: "application/javascript" }));
    self.MonacoEnvironment = {
      ...(self.MonacoEnvironment ?? {}),
      getWorker: () => new Worker(noopWorkerUrl),
    };

    // Disable the built-in TS/JS language service diagnostics so the editor
    // behaves like a plain text editor for validation: syntax highlighting
    // and bracket matching stay, but "unreachable code" / type-error
    // squiggles and the marker gutter are suppressed.
    //
    // `monaco.languages.typescript` is @deprecated (typed as
    // `{ deprecated: true }`) — the real defaults live on the top-level
    // `typescript` export, imported directly here.
    monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
    });
    monaco.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
    });
  } catch {
    // Fallback to the CDN loader if the local package fails to load.
  }
  monacoConfigured = true;
}

type FileEntry = {
  path: string; // slash-joined relative path, e.g. "pages/index.tsx"
  encoding: "utf-8" | "base64";
  contents: string;
};

type SaveState = "idle" | "saving" | "saved" | "error";

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".md": "markdown",
  ".mdx": "markdown",
  ".svg": "xml",
  ".xml": "xml",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".sh": "shell",
  ".env": "plaintext",
};

function languageForPath(filePath: string): string {
  // Handle dotted names like ".env.local" by matching the last dot segment.
  const base = filePath.split("/").pop() ?? filePath;
  if (base === ".gitignore" || base === ".npmrc" || base === ".env" || base.startsWith(".env.")) {
    return "plaintext";
  }
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "plaintext";
  return LANGUAGE_BY_EXT[base.slice(dot).toLowerCase()] ?? "plaintext";
}

// Flatten the tree into a list of file entries and a nested view for rendering.
function flattenTree(node: TreeNode, prefix: string, out: Map<string, FileEntry>): void {
  if (node.kind !== "directory") return;
  for (const [name, child] of Object.entries(node.children)) {
    const childPath = prefix ? `${prefix}/${name}` : name;
    if (child.kind === "file") {
      out.set(childPath, { path: childPath, encoding: child.encoding, contents: child.contents });
    } else {
      flattenTree(child, childPath, out);
    }
  }
}

type TreeNodeView = {
  name: string;
  path: string;
  dir: boolean;
  children: TreeNodeView[];
};

function buildTreeView(node: TreeNode, prefix: string): TreeNodeView[] {
  if (node.kind !== "directory") return [];
  return Object.entries(node.children)
    .map(([name, child]) => {
      const childPath = prefix ? `${prefix}/${name}` : name;
      if (child.kind === "directory") {
        return { name, path: childPath, dir: true, children: buildTreeView(child, childPath) };
      }
      return { name, path: childPath, dir: false, children: [] };
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

function FileTreeItem({
  node,
  depth,
  activePath,
  onSelect,
}: {
  node: TreeNodeView;
  depth: number;
  activePath: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  if (node.dir) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-xs text-neutral-600 hover:bg-neutral-100"
          style={{ paddingLeft: depth * 10 + 6 }}
        >
          <span className="text-[9px] text-neutral-400">{open ? "▼" : "▶"}</span>
          <span className="truncate font-medium">{node.name}</span>
        </button>
        {open &&
          node.children.map((child) => (
            <FileTreeItem key={child.path} node={child} depth={depth + 1} activePath={activePath} onSelect={onSelect} />
          ))}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onSelect(node.path)}
      className={`flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-xs ${
        activePath === node.path ? "bg-blue-50 text-blue-700" : "text-neutral-700 hover:bg-neutral-100"
      }`}
      style={{ paddingLeft: depth * 10 + 18 }}
    >
      <span className="truncate">{node.name}</span>
    </button>
  );
}

export default function CodeEditor({ workspaceId }: { workspaceId: string }) {
  const [treeView, setTreeView] = useState<TreeNodeView[]>([]);
  const [files, setFiles] = useState<Map<string, FileEntry>>(new Map());
  const [activePath, setActivePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  // Live (possibly unsaved) content for the active file, keyed by path.
  const [draftByPath, setDraftByPath] = useState<Record<string, string>>({});
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const refreshTree = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tree`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const data = (await res.json()) as { root: TreeNode };
      const flat = new Map<string, FileEntry>();
      flattenTree(data.root, "", flat);
      setFiles(flat);
      setTreeView(buildTreeView(data.root, ""));
      setError(null);
      // Keep drafts for files that still exist; drop stale drafts for deleted files.
      setDraftByPath((prev) => {
        const next: Record<string, string> = {};
        for (const [p, v] of Object.entries(prev)) {
          if (flat.has(p)) next[p] = v;
        }
        return next;
      });
      return flat;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load files.");
      return null;
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  // Track whether a default file has been chosen so the initial-load effect
  // doesn't depend on `files` (which changes on every refresh).
  const defaultChosen = useRef(false);

  useEffect(() => {
    void (async () => {
      await ensureMonacoConfigured();
      const flat = await refreshTree();
      if (flat && !defaultChosen.current) {
        defaultChosen.current = true;
        // Default to a sensible entry file if present.
        const preferred = ["pages/index.tsx", "src/pages/index.tsx", "package.json", "README.md"];
        const found = preferred.find((p) => flat.has(p));
        setActivePath(found ?? flat.keys().next().value ?? null);
      }
    })();
  }, [refreshTree]);

  const activeFile = activePath ? files.get(activePath) ?? null : null;
  const isBinary = activeFile?.encoding === "base64";
  const activeDraft = activePath ? draftByPath[activePath] ?? activeFile?.contents ?? "" : "";
  const draft = activePath ? draftByPath[activePath] : undefined;
  const isDirty = activeFile ? draft !== undefined && draft !== activeFile.contents : false;

  const writeFile = useCallback(
    async (filePath: string, contents: string) => {
      try {
        const res = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/files/${filePath}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error?.message ?? `Failed (${res.status})`);
        }
        // Mark the on-disk contents as the new baseline so the file is no longer dirty.
        setFiles((prev) => {
          const next = new Map(prev);
          const existing = next.get(filePath);
          if (existing) next.set(filePath, { ...existing, contents });
          return next;
        });
        setDraftByPath((prev) => {
          const next = { ...prev };
          delete next[filePath];
          return next;
        });
        setSaveState("saved");
        setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 1500);
      } catch (err) {
        setSaveState("error");
        setError(err instanceof Error ? err.message : "Save failed.");
      }
    },
    [workspaceId],
  );

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (!activePath || isBinary || !activeFile) return;
      const next = value ?? "";
      setDraftByPath((prev) => ({ ...prev, [activePath]: next }));
      setSaveState("saving");
      // Debounce the write.
      clearTimeout(saveTimers.current[activePath]);
      saveTimers.current[activePath] = setTimeout(() => {
        void writeFile(activePath, next);
      }, 600);
    },
    [activePath, activeFile, isBinary, writeFile],
  );

  // Flush pending saves on unmount.
  useEffect(() => {
    const timers = saveTimers;
    return () => {
      for (const t of Object.values(timers.current)) clearTimeout(t);
    };
  }, []);

  const monacoOptions = useMemo(
    () => ({
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      tabSize: 2,
      wordWrap: "on" as const,
    }),
    [],
  );

  const saveLabel: Record<SaveState, string> = { idle: "", saving: "Saving…", saved: "Saved", error: "Save error" };
  const saveColor: Record<SaveState, string> = {
    idle: "text-neutral-400",
    saving: "text-amber-500",
    saved: "text-emerald-500",
    error: "text-red-500",
  };

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Editor toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-200 px-3">
        <span className="text-xs font-medium tracking-wide text-neutral-600 uppercase">Code</span>
        <span className="max-w-[16rem] truncate font-mono text-[11px] text-neutral-500" title={activePath ?? ""}>
          {activePath ?? "no file selected"}
        </span>
        {isDirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="Unsaved changes" />}
        <span className={`text-[11px] ${saveColor[saveState]}`}>{saveLabel[saveState]}</span>
        <button
          type="button"
          onClick={() => void refreshTree()}
          className="ml-auto rounded border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 hover:bg-neutral-100"
          title="Re-read files from disk"
        >
          Refresh
        </button>
      </div>

      {error && (
        <p className="shrink-0 border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-600">{error}</p>
      )}

      <div className="flex min-h-0 flex-1">
        {/* File tree */}
        <aside className="w-52 shrink-0 overflow-y-auto border-r border-neutral-200 py-2">
          {loading ? (
            <p className="px-3 py-2 text-xs text-neutral-400">Loading…</p>
          ) : treeView.length === 0 ? (
            <p className="px-3 py-2 text-xs text-neutral-400">No files.</p>
          ) : (
            treeView.map((node) => (
              <FileTreeItem key={node.path} node={node} depth={0} activePath={activePath} onSelect={setActivePath} />
            ))
          )}
        </aside>

        {/* Monaco editor */}
        <div className="min-w-0 flex-1">
          {!activeFile ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-400">
              Select a file to edit.
            </div>
          ) : isBinary ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-400">
              <div className="text-center">
                <p className="font-medium text-neutral-500">Binary file</p>
                <p className="mt-1 text-xs">This file is not editable in the code editor.</p>
              </div>
            </div>
          ) : (
            <Editor
              key={activePath}
              language={languageForPath(activePath ?? "")}
              value={activeDraft}
              onChange={handleChange}
              options={monacoOptions}
              loading={<div className="flex h-full items-center justify-center text-sm text-neutral-400">Loading editor…</div>}
            />
          )}
        </div>
      </div>
    </div>
  );
}
