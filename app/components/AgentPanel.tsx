"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authenticatedFetch } from "@/app/lib/auth/client";

type TurnPhase = "running" | "retrying" | "compacting" | "stopping" | "uncertain" | "done" | "stopped" | "failed";
type Activity = { id: string; name: string; status: "running" | "done" | "failed" };
type Message = {
  id: number;
  role: "user" | "agent";
  text: string;
  streaming?: boolean;
  phase?: TurnPhase;
  activities?: Activity[];
  notice?: string;
  truncated?: boolean;
};

type TurnSnapshot = { id: string; text: string; phase: TurnPhase; activities: Activity[]; truncated?: boolean };
type PiEvent =
  | { type: "turn_snapshot"; version: 1; sequence: number; busy: boolean; turn?: TurnSnapshot }
  | { type: "turn_event"; version: 1; sequence: number; turnId: string; event:
      | { kind: "text"; delta: string }
      | { kind: "phase"; phase: TurnPhase }
      | { kind: "activity"; activity: Activity } };

const isFinished = (phase: TurnPhase) => phase === "done" || phase === "stopped" || phase === "failed";
const activityLabel = (name: string) => ({
  read: "读取文件", write: "创建文件", edit: "修改文件", bash: "执行命令",
  grep: "搜索内容", find: "查找文件", ls: "查看文件",
} as Record<string, string>)[name] ?? "执行操作";

type ConnState = "connecting" | "open" | "closed" | "error";

// Matches the server-side DEFAULT_LIMITS.maxFileBytes (files API rejects larger writes).
const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const ATTACHMENTS_DIR = ".attachments";

type PendingAttachment = {
  name: string;
  path: string;
  status: "uploading" | "ready" | "failed";
};

type Activation = {
  clientId: string;
  issuedAt: number;
  workspaceId: string;
  released: boolean;
  ready: boolean;
  streamingId: number | null;
  turnId: string | null;
  sequence: number;
  cancelPending: boolean;
  draft: { text: string; attachments: PendingAttachment[] } | null;
  readyTimer?: ReturnType<typeof setTimeout>;
  controller: AbortController;
  sse: EventSource | null;
};

const agentBase = (wid: string) => `/api/v1/workspaces/${encodeURIComponent(wid)}/agent`;

export default function AgentPanel({ workspaceId }: { workspaceId: string | null }) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 0,
      role: "agent",
      text: "你好！我是随心一码 AI 编程助手。告诉我你想做什么应用，我会帮你编写代码，并在右侧 WebContainer 中实时预览。",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [otherBusy, setOtherBusy] = useState(false);
  const [phase, setPhase] = useState<TurnPhase>("running");
  const [stopping, setStopping] = useState(false);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(1);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Uploads already in flight, keyed by attachment path, so StrictMode replays
  // and re-mounts cannot double-send the same file.
  const uploadsRef = useRef(new Set<string>());

  // The server holds the authenticated WebSocket to the agent; the browser
  // reads events over SSE and sends prompts over POST. Each page activation
  // owns a lease, while the Pi conversation is shared by the workspace session.
  const activeRef = useRef<Activation | null>(null);

  const restoreDraft = useCallback((lease: Activation) => {
    const draft = lease.draft;
    if (!draft) return;
    setInput((value) => value || draft.text);
    setAttachments((current) => [...draft.attachments.filter((a) => !current.some((item) => item.path === a.path)), ...current]);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!workspaceId) return;
    const wid = workspaceId;
    let activation: Activation;

    function release(lease: Activation) {
      if (lease.released) return;
      lease.released = true;
      lease.ready = false;
      if (lease.readyTimer) clearTimeout(lease.readyTimer);
      lease.controller.abort();
      if (lease.sse) {
        lease.sse.onmessage = null;
        lease.sse.onerror = null;
        lease.sse.close();
      }
      if (activeRef.current === lease) activeRef.current = null;
      // Never log response bodies or transport errors: they may contain secrets.
      try {
        void fetch(`${agentBase(wid)}/stop`, {
          method: "POST",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId: lease.clientId, issuedAt: lease.issuedAt }),
        }).then((res) => {
          if (!res.ok) console.warn("Agent lease release failed", res.status);
        }).catch(() => { console.warn("Agent lease release request failed"); });
      } catch {
        console.warn("Agent lease release request failed");
      }
    }

    async function connect(lease: Activation) {
      const current = () => !lease.released && activeRef.current === lease;
      setConn("connecting");
      try {
        // Open the server-side agent ws (also ensures the PiWorker CR is Ready).
        const res = await authenticatedFetch(`${agentBase(wid)}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId: lease.clientId, issuedAt: lease.issuedAt }),
          signal: lease.controller.signal,
        });
        if (!current()) return;
        if (!res.ok) {
          throw new Error(`编程助手启动失败（${res.status}）`);
        }
        // Subscribe to the agent's SSE event stream.
        const sse = new EventSource(`${agentBase(wid)}/events?clientId=${encodeURIComponent(lease.clientId)}`);
        lease.sse = sse;
        const waitForSnapshot = () => {
          if (lease.readyTimer) return;
          lease.readyTimer = setTimeout(() => {
            if (current() && !lease.ready) setConn("error");
          }, 15_000);
        };
        waitForSnapshot();
        sse.onmessage = (ev) => {
          if (!current()) return;
          let event: PiEvent;
          try {
            event = JSON.parse(ev.data) as PiEvent;
          } catch {
            return;
          }
          if (!event || typeof event !== "object" || event.version !== 1 || !Number.isSafeInteger(event.sequence)) return;
          if (event.type === "turn_snapshot") {
            if (event.sequence < lease.sequence) return;
            lease.sequence = event.sequence;
            lease.ready = true;
            if (lease.readyTimer) clearTimeout(lease.readyTimer);
            lease.readyTimer = undefined;
            setConn("open");
            const turn = event.turn;
            setOtherBusy(event.busy && (!turn || isFinished(turn.phase)));
            const id = lease.streamingId;
            if (!turn || turn.id !== lease.turnId || id === null || typeof turn.text !== "string" || !Array.isArray(turn.activities)) return;
            setPhase(turn.phase);
            setStopping(turn.phase === "stopping");
            setMessages((prev) => prev.map((m) => m.id === id ? {
              ...m, text: turn.text, activities: turn.activities, phase: turn.phase,
              streaming: !isFinished(turn.phase), truncated: turn.truncated,
            } : m));
            if (isFinished(turn.phase)) {
              if (turn.phase === "failed") restoreDraft(lease);
              lease.draft = null;
              lease.streamingId = null;
              lease.turnId = null;
              lease.cancelPending = false;
              setBusy(false);
              setStopping(false);
            }
            return;
          }
          if (event.type !== "turn_event" || event.sequence <= lease.sequence) return;
          lease.sequence = event.sequence;
          const id = lease.streamingId;
          if (id === null || event.turnId !== lease.turnId) return;
          const update = event.event;
          if (!update || typeof update !== "object") return;
          if (update.kind === "text") {
            setMessages((prev) => prev.map((m) => m.id === id ? { ...m, text: m.text + update.delta } : m));
          } else if (update.kind === "activity") {
            setMessages((prev) => prev.map((m) => {
              if (m.id !== id) return m;
              const activities = m.activities ?? [];
              const index = activities.findIndex((activity) => activity.id === update.activity.id);
              return { ...m, activities: index < 0 ? [...activities, update.activity] : activities.map((activity, i) => i === index ? update.activity : activity) };
            }));
          } else if (update.kind === "phase") {
            setPhase(update.phase);
            setStopping(update.phase === "stopping");
            setMessages((prev) => prev.map((m) => m.id === id ? { ...m, phase: update.phase, streaming: !isFinished(update.phase) } : m));
            if (isFinished(update.phase)) {
              if (update.phase === "failed") restoreDraft(lease);
              lease.draft = null;
              lease.streamingId = null;
              lease.turnId = null;
              lease.cancelPending = false;
              setBusy(false);
              setStopping(false);
            }
          }
        };
        sse.onerror = () => {
          if (!current()) return;
          // EventSource hides HTTP status codes. Check an authenticated API so
          // an expired/revoked session navigates to login instead of retrying forever.
          lease.ready = false;
          if (sse.readyState === 2) setConn("error");
          else { setConn("connecting"); waitForSnapshot(); }
          void authenticatedFetch(`/api/v1/workspaces/${encodeURIComponent(wid)}`, { cache: "no-store" }).catch(() => {});
        };
      } catch {
        if (!current()) return;
        console.error("agent connect failed");
        setConn("error");
        setMessages((prev) => [
          ...prev,
          {
            id: idRef.current++,
            role: "agent",
            text: "无法启动编程助手，请稍后重试；若问题持续，请联系管理员检查服务配置。",
          },
        ]);
      }
    }

    function activate() {
      activation = {
        clientId: crypto.randomUUID(), issuedAt: Date.now(), workspaceId: wid,
        released: false, ready: false, streamingId: null, turnId: null,
        sequence: -1, cancelPending: false, draft: null, controller: new AbortController(), sse: null,
      };
      activeRef.current = activation;
      setBusy(false);
      setOtherBusy(false);
      setStopping(false);
      setPhase("running");
      setMessages((prev) => prev.map((m) => m.streaming ? { ...m, streaming: false } : m));
      void connect(activation);
    }
    const onPageHide = () => release(activation);
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      release(activation);
      activate();
    };
    activate();
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      release(activation);
    };
  }, [workspaceId, restoreDraft]);

  /** Upload selected files into the workspace; they become attachment references on the next message. */
  async function uploadFiles(files: FileList | File[]) {
    if (!workspaceId) return;
    const wid = workspaceId;
    for (const file of Array.from(files)) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setMessages((prev) => [
          ...prev,
          { id: idRef.current++, role: "agent", text: `附件 ${file.name} 超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB 大小限制，未上传。` },
        ]);
        continue;
      }
      const safeName = file.name.replace(/[\\/:*?"<>|#%]/g, "_").slice(0, 120) || "attachment";
      const attachmentPath = `${ATTACHMENTS_DIR}/${Date.now()}-${safeName}`;
      if (uploadsRef.current.has(attachmentPath)) continue;
      uploadsRef.current.add(attachmentPath);
      const pending: PendingAttachment = { name: file.name, path: attachmentPath, status: "uploading" };
      setAttachments((prev) => [...prev, pending]);
      try {
        const contents = await file.text();
        const res = await authenticatedFetch(
          `/api/v1/workspaces/${encodeURIComponent(wid)}/files/${encodeURIComponent(attachmentPath)}`,
          { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents }) },
        );
        if (!res.ok) throw new Error(`upload failed: ${res.status}`);
        setAttachments((prev) => prev.map((a) => (a.path === attachmentPath ? { ...a, status: "ready" } : a)));
      } catch {
        setAttachments((prev) => prev.map((a) => (a.path === attachmentPath ? { ...a, status: "failed" } : a)));
      } finally {
        uploadsRef.current.delete(attachmentPath);
      }
    }
  }

  function removeAttachment(path: string) {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  }

  async function send() {
    const text = input.trim();
    if (!text || busy || otherBusy) return;
    const lease = activeRef.current;
    if (!lease || lease.released || !lease.ready || lease.turnId !== null || lease.workspaceId !== workspaceId) return;
    if (attachments.some((a) => a.status === "uploading")) return;

    const ready = attachments.filter((a) => a.status === "ready");
    const failed = attachments.filter((a) => a.status === "failed");
    if (failed.length) return; // surface failure instead of silently dropping it

    const body = ready.length
      ? `${text}\n\n附件已保存到工作区，请读取使用：\n${ready.map((a) => `- ${a.path}（${a.name}）`).join("\n")}`
      : text;

    const userMsg: Message = { id: idRef.current++, role: "user", text: body };
    const agentMsg: Message = { id: idRef.current++, role: "agent", text: "", streaming: true, phase: "running", activities: [] };
    const turnId = crypto.randomUUID();
    lease.streamingId = agentMsg.id;
    lease.turnId = turnId;
    lease.draft = { text, attachments: ready };
    setMessages((prev) => [...prev, userMsg, agentMsg]);
    setInput("");
    setAttachments([]);
    setBusy(true);
    setPhase("running");
    setStopping(false);

    try {
      const res = await authenticatedFetch(`${agentBase(lease.workspaceId)}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: lease.clientId, turnId, message: body }),
      });
      if (!res.ok && res.status >= 500 && !lease.released && activeRef.current === lease && lease.turnId === turnId) {
        restoreDraft(lease);
        setMessages((prev) => prev.map((m) => m.id === agentMsg.id
          ? { ...m, notice: "发送状态暂时未知，可尝试停止并等待连接恢复。" }
          : m));
      } else if (!res.ok && !lease.released && activeRef.current === lease && lease.turnId === turnId) {
        setMessages((prev) => prev.map((m) => m.id === agentMsg.id
          ? { ...m, streaming: false, phase: "failed", notice: res.status === 409 ? "其他页面正在处理，请稍后再试。" : "消息发送失败，请稍后重试。" }
          : m));
        restoreDraft(lease);
        setBusy(false);
        setStopping(false);
        lease.draft = null;
        lease.streamingId = null;
        lease.turnId = null;
        lease.cancelPending = false;
      }
    } catch {
      if (lease.released || activeRef.current !== lease || lease.turnId !== turnId) return;
      restoreDraft(lease);
      setMessages((prev) => prev.map((m) => m.id === agentMsg.id
        ? { ...m, notice: "发送状态暂时未知，可尝试停止并等待连接恢复。" }
        : m));
    }
  }

  async function stop() {
    const lease = activeRef.current;
    const turnId = lease?.turnId;
    if (!lease || lease.released || !turnId || lease.cancelPending) return;
    const previousPhase = phase;
    lease.cancelPending = true;
    setStopping(true);
    setPhase("stopping");
    const id = lease.streamingId;
    setMessages((prev) => prev.map((m) => m.id === id ? { ...m, phase: "stopping", notice: undefined } : m));
    try {
      const res = await authenticatedFetch(`${agentBase(lease.workspaceId)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: lease.clientId, turnId }),
      });
      if (!res.ok) throw new Error("cancel failed");
    } catch {
      if (lease.released || activeRef.current !== lease || lease.turnId !== turnId) return;
      lease.cancelPending = false;
      setStopping(false);
      setPhase(previousPhase);
      setMessages((prev) => prev.map((m) => m.id === id ? { ...m, phase: previousPhase, notice: "停止请求未确认，请重试。" } : m));
    }
  }

  const workingLabel = phase === "uncertain" ? "任务状态未确认" : stopping ? "正在停止" : phase === "retrying" ? "正在重试" : phase === "compacting" ? "正在整理上下文" : "正在处理";
  const statusLabel =
    conn === "open" ? (busy ? workingLabel : otherBusy ? "其他页面正在处理" : "等待输入") :
    conn === "connecting" ? "正在连接" :
    conn === "error" ? "连接失败" : "已断开连接";
  const dotColor =
    conn === "open" ? (busy ? "bg-amber-500 animate-pulse motion-reduce:animate-none" : "bg-[#799b39]") :
    conn === "connecting" ? "bg-amber-500 animate-pulse motion-reduce:animate-none" : "bg-neutral-400";

  return (
    <div className="flex h-full flex-col bg-[#fffefa]">
      {/* Panel header */}
      <div className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-[var(--brand-line)] bg-[var(--brand-paper)] px-4">
        <span className="flex items-center gap-2 text-sm font-bold text-[var(--brand-ink)]">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-[var(--brand-lime)] text-base" aria-hidden="true">✳</span>AI 编程助手
        </span>
        <span role="status" aria-live="polite" className="flex items-center gap-1.5 rounded-full border border-[#dce3d3] bg-white px-2.5 py-1 text-xs text-[var(--brand-muted)]">
          <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
          {statusLabel}
        </span>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5"
      >
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[90%] rounded-xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                m.role === "user"
                  ? "rounded-br-sm bg-[#f0ebfe] text-[#4b4268]"
                  : "rounded-bl-sm border border-[#e1e6d8] bg-[#f5f8ed] text-[#3d4637]"
              }`}
            >
              {m.text}
              {m.streaming && m.text && (
                <span aria-hidden="true" className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-neutral-400 align-text-bottom motion-reduce:animate-none" />
              )}
              {m.streaming && !m.text && (
                <div className="flex items-center gap-2 text-[var(--brand-muted)]">
                  <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#c4cbb9] border-t-[var(--brand-purple)] motion-reduce:animate-none" />
                  {m.phase === "stopping" ? "正在停止…" : m.phase === "retrying" ? "正在重试…" : m.phase === "compacting" ? "正在整理上下文…" : "正在处理…"}
                </div>
              )}
              {!!m.activities?.length && (
                <div className="mt-2 space-y-1 border-t border-[#e1e6d8] pt-2 text-xs text-[#66715c]" aria-label="处理进度">
                  {m.activities.map((activity) => (
                    <div key={activity.id} className="flex items-center gap-1.5">
                      <span aria-hidden="true">{activity.status === "running" ? "◌" : activity.status === "failed" ? "!" : "✓"}</span>
                      <span>{activityLabel(activity.name)} · {activity.status === "running" ? "进行中" : activity.status === "failed" ? "失败" : "已完成"}</span>
                    </div>
                  ))}
                </div>
              )}
              {m.phase === "uncertain" && <p className="mt-2 text-xs text-red-600">暂时无法确认任务状态。请关闭所有工作区页面后重新打开。</p>}
              {m.phase === "stopped" && <p className="mt-2 text-xs text-neutral-500">已停止。已执行的文件改动不会撤销。</p>}
              {m.phase === "failed" && !m.notice && <p className="mt-2 text-xs text-red-600">本次处理未完成，请重试。</p>}
              {m.truncated && <p className="mt-2 text-xs text-neutral-500">内容较长，部分内容已省略。</p>}
              {m.notice && <p className="mt-2 text-xs text-red-600">{m.notice}</p>}
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <form
        className="shrink-0 border-t border-[var(--brand-line)] bg-[var(--brand-paper)] p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <span
                key={a.path}
                className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${
                  a.status === "failed"
                    ? "border-red-200 bg-red-50 text-red-600"
                    : a.status === "uploading"
                      ? "border-amber-200 bg-amber-50 text-amber-700"
                      : "border-neutral-200 bg-neutral-50 text-neutral-600"
                }`}
              >
                <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l8.57-8.57A4 4 0 1118 8.84l-8.59 8.57a2 2 0 01-2.83-2.83l8.49-8.48" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="truncate">
                  {a.name}
                  {a.status === "uploading" ? " · 上传中…" : a.status === "failed" ? " · 上传失败" : ""}
                </span>
                <button
                  type="button"
                  onClick={() => removeAttachment(a.path)}
                  aria-label={`移除附件 ${a.name}`}
                  className="shrink-0 rounded-full p-0.5 text-current opacity-60 hover:opacity-100"
                >
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-lg border border-[#cbd1c0] bg-white p-1.5 shadow-[3px_3px_0_#e5eada] focus-within:border-[var(--brand-purple)] focus-within:ring-2 focus-within:ring-[#e9e4fb]">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = e.target.files;
              if (files?.length) void uploadFiles(files);
              e.target.value = ""; // allow re-selecting the same file
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={conn !== "open"}
            aria-label="上传附件到工作区"
            title="上传附件到工作区"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" width="18" height="18">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l8.57-8.57A4 4 0 1118 8.84l-8.59 8.57a2 2 0 01-2.83-2.83l8.49-8.48" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            aria-label="发送给 AI 编程助手的消息"
            rows={2}
            placeholder={conn === "open" ? "描述你想实现的应用或功能…" : conn === "error" ? "连接失败，请刷新页面重试。" : "正在连接编程助手…"}
            disabled={conn !== "open"}
            className="flex-1 resize-none bg-transparent px-1.5 py-1 text-sm text-neutral-800 outline-none placeholder:text-neutral-400 disabled:cursor-not-allowed disabled:text-neutral-400"
          />
          {busy ? (
            <button type="button" onClick={() => void stop()} disabled={stopping || phase === "uncertain"} className="brand-button min-h-9 px-3 py-1.5 text-sm">
              {phase === "uncertain" ? "状态未确认" : stopping ? "正在停止…" : "停止"}
            </button>
          ) : (
            <button
              type="submit"
              disabled={otherBusy || !input.trim() || conn !== "open" || attachments.some((a) => a.status !== "ready")}
              className="brand-button min-h-9 px-3 py-1.5 text-sm"
            >
              发送
            </button>
          )}
        </div>
        <p className="mt-1.5 px-0.5 text-[13px] text-neutral-400">
          Enter 发送 · Shift+Enter 换行 · 附件保存到工作区 .attachments/
        </p>
      </form>
    </div>
  );
}
