"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Editor, loader as monacoLoader } from "@monaco-editor/react";
import { authenticatedFetch } from "@/app/lib/auth/client";
import type { TreeNode } from "@/app/lib/workspace/types";

// The generated AMD assets include the matching official Chinese language pack.
// Share initialization across mounts; never fall back to an external CDN.
let monacoPromise: Promise<void> | null = null;
function ensureMonacoConfigured(): Promise<void> {
  if (!monacoPromise) {
    monacoPromise = (async () => {
      type Monaco = typeof import("monaco-editor");
      const amd = window as unknown as {
        require: {
          config(config: object): void;
          (dependencies: string[], loaded: (monaco: Monaco) => void, failed: (error: unknown) => void): void;
        };
        define(name: string, dependencies: string[], factory: () => object): void;
        _VSCODE_NLS_LANGUAGE?: string;
        _VSCODE_NLS_MESSAGES?: unknown;
      };
      const config = {
        paths: { vs: "/monaco/vs" },
        "vs/nls": { availableLanguages: { "*": "zh-cn" } },
      };
      monacoLoader.config(config);
      let timeoutId: number | undefined;
      const monaco = await new Promise<Monaco>((resolve, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error("本地编辑器加载超时")), 15000);
        const loadScript = (src: string) => new Promise<void>((loaded, failed) => {
          const script = document.createElement("script");
          script.src = src;
          script.onload = () => loaded();
          script.onerror = () => failed(new Error(`无法加载本地编辑器资源：${src}`));
          document.body.appendChild(script);
        });
        void (async () => {
          await loadScript("/monaco/vs/loader.js");
          await loadScript("/monaco/vs/nls/lang/zh-cn.js");
          if (amd._VSCODE_NLS_LANGUAGE !== "zh-cn" || !Array.isArray(amd._VSCODE_NLS_MESSAGES) || amd._VSCODE_NLS_MESSAGES.length === 0) {
            throw new Error("本地编辑器中文语言包未正确加载");
          }
          // Monaco 0.56's language script installs globals but has no AMD define.
          // Its NLS plugin waits on require(["vs/nls/lang/zh-cn"]), so HTTP 200
          // alone leaves editor.main pending forever. Register only after the
          // language globals are ready, without modifying the official asset.
          amd.define("vs/nls/lang/zh-cn", [], () => ({}));
          amd.require.config(config);
          amd.require(["vs/editor/editor.main"], resolve, reject);
        })().catch(reject);
      }).finally(() => window.clearTimeout(timeoutId));
      monacoLoader.config({ ...config, monaco });
      await monacoLoader.init();
      monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: true,
        noSyntaxValidation: true,
      });
      monaco.typescript.javascriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: true,
        noSyntaxValidation: true,
      });
    })().catch((error: unknown) => {
      monacoPromise = null;
      throw error;
    });
  }
  return monacoPromise;
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
          className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-[13px] text-neutral-600 hover:bg-neutral-100"
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
      className={`flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-[13px] ${
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
  const [editorStatus, setEditorStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  // Live (possibly unsaved) content for the active file, keyed by path.
  const [draftByPath, setDraftByPath] = useState<Record<string, string>>({});
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const refreshTree = useCallback(async () => {
    try {
      const res = await authenticatedFetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tree`, { cache: "no-store" });
      if (!res.ok) throw new Error(`请求失败（${res.status}）`);
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
      console.error("File load failed", err);
      setError("文件加载失败，请稍后重试。");
      return null;
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  // Track whether a default file has been chosen so the initial-load effect
  // doesn't depend on `files` (which changes on every refresh).
  const defaultChosen = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void ensureMonacoConfigured().then(
      () => { if (!cancelled) setEditorStatus("ready"); },
      (error: unknown) => {
        console.error("Local Monaco initialization failed", error);
        if (!cancelled) setEditorStatus("error");
      },
    );
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    void (async () => {
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
        const res = await authenticatedFetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/files/${filePath}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents }),
        });
        if (!res.ok) {
          throw new Error(`请求失败（${res.status}）`);
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
        console.error("File save failed", err);
        setError("保存失败，请稍后重试。");
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
      fontSize: 14,
      fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "PingFang SC", "Microsoft YaHei", "Noto Sans Mono CJK SC", monospace',
      ariaLabel: "代码编辑器",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      tabSize: 2,
      wordWrap: "on" as const,
    }),
    [],
  );

  const saveLabel: Record<SaveState, string> = { idle: "", saving: "正在保存…", saved: "已保存", error: "保存失败" };
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
        <span className="text-[13px] font-medium tracking-wide text-neutral-600 uppercase">代码</span>
        <span className="max-w-[16rem] truncate font-mono text-[13px] text-neutral-500" title={activePath ?? ""}>
          {activePath ?? "未选择文件"}
        </span>
        {isDirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="有未保存的更改" />}
        <span className={`text-[13px] ${saveColor[saveState]}`}>{saveLabel[saveState]}</span>
        <button
          type="button"
          onClick={() => void refreshTree()}
          className="ml-auto rounded border border-neutral-300 px-2 py-0.5 text-[13px] text-neutral-600 hover:bg-neutral-100"
          title="重新读取磁盘中的文件"
        >
          刷新文件
        </button>
      </div>

      {error && (
        <p className="shrink-0 border-b border-red-200 bg-red-50 px-3 py-1.5 text-[13px] text-red-600">{error}</p>
      )}

      <div className="flex min-h-0 flex-1">
        {/* File tree */}
        <aside className="w-52 shrink-0 overflow-y-auto border-r border-neutral-200 py-2">
          {loading ? (
            <p className="px-3 py-2 text-[13px] text-neutral-400">正在加载…</p>
          ) : treeView.length === 0 ? (
            <p className="px-3 py-2 text-[13px] text-neutral-400">暂无文件。</p>
          ) : (
            treeView.map((node) => (
              <FileTreeItem key={node.path} node={node} depth={0} activePath={activePath} onSelect={setActivePath} />
            ))
          )}
        </aside>

        {/* Monaco editor */}
        <div className="min-w-0 flex-1">
          {editorStatus === "error" ? (
            <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-sm text-neutral-600">
              <p>代码编辑器加载失败，请检查网络连接后重试。</p>
              {/* The upstream loader retains a rejected initialization promise.
                  Reloading resets it without relying on private loader state. */}
              <button type="button" onClick={() => window.location.reload()} className="rounded border border-neutral-300 px-3 py-1.5 hover:bg-neutral-100">
                重新加载页面并重试
              </button>
            </div>
          ) : editorStatus === "loading" ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-400">正在加载编辑器…</div>
          ) : !activeFile ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-400">
              选择一个文件开始编辑。
            </div>
          ) : isBinary ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-400">
              <div className="text-center">
                <p className="font-medium text-neutral-500">二进制文件</p>
                <p className="mt-1 text-[13px]">代码编辑器暂不支持编辑此类文件。</p>
              </div>
            </div>
          ) : (
            <Editor
              key={activePath}
              language={languageForPath(activePath ?? "")}
              value={activeDraft}
              onChange={handleChange}
              options={monacoOptions}
              loading={<div className="flex h-full items-center justify-center text-sm text-neutral-400">正在加载编辑器…</div>}
            />
          )}
        </div>
      </div>
    </div>
  );
}
