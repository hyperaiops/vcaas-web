"use client";

import { useEffect, useRef, useState } from "react";

type Message = {
  id: number;
  role: "user" | "agent";
  text: string;
  streaming?: boolean;
};

// A Pi RPC event as emitted on stdout (one JSONL record per SSE frame).
// We only care about assistant text deltas; other event types are ignored.
type PiEvent = {
  type: string;
  // Present on message_update events; we consume text_delta to build the answer.
  assistantMessageEvent?: { type: string; contentIndex?: number; delta?: string };
  // Present on agent_end; true when the agent will auto-retry this turn, in
  // which case we must keep streaming into the same message (a retry's deltas
  // append to what we already showed rather than starting fresh).
  willRetry?: boolean;
};

type ConnState = "connecting" | "open" | "closed" | "error";

const agentBase = (wid: string) => `/api/v1/workspaces/${encodeURIComponent(wid)}/agent`;

export default function AgentPanel({ workspaceId }: { workspaceId: string | null }) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 0,
      role: "agent",
      text: "Hi! I'm PI, your coding agent. Describe the app you want and I'll build it live in the WebContainer preview on the right.",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState<ConnState>("connecting");
  const scrollRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(1);

  // The server holds the WebSocket to the agent (over the ingress port-forward);
  // the browser reads events over SSE and sends prompts over POST. Browsers
  // can't do the split TCP-target/SNI trick the server-side ws needs, so the
  // server proxies. The Pi conversation is stateful across the server session.
  const sseRef = useRef<EventSource | null>(null);
  const readyRef = useRef(false);
  // The id of the agent message currently being streamed, if any.
  const streamingIdRef = useRef<number | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!workspaceId) return;
    const wid = workspaceId;
    let cancelled = false;

    async function connect() {
      setConn("connecting");
      try {
        // Open the server-side agent ws (also ensures the PiWorker CR is Ready).
        const res = await fetch(`${agentBase(wid)}/start`, { method: "POST" });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error?.message ?? `agent/start failed (${res.status})`);
        }
        if (cancelled) return;
        readyRef.current = true;
        setConn("open");

        // Subscribe to the agent's SSE event stream.
        const sse = new EventSource(`${agentBase(wid)}/events`);
        sseRef.current = sse;
        sse.onmessage = (ev) => {
          let event: PiEvent;
          try {
            event = JSON.parse(ev.data) as PiEvent;
          } catch {
            return;
          }
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent?.type === "text_delta" &&
            typeof event.assistantMessageEvent.delta === "string"
          ) {
            const delta = event.assistantMessageEvent.delta;
            const id = streamingIdRef.current;
            if (id === null) return;
            setMessages((prev) =>
              prev.map((m) => (m.id === id ? { ...m, text: m.text + delta } : m)),
            );
          } else if (event.type === "agent_end" && !event.willRetry) {
            // The agent turn is actually done — the `response`/`prompt` event
            // fires right after preflight (before any text), so it can't be
            // used as the completion signal. `agent_end` is emitted once the
            // whole turn's events have streamed (same signal pi-chat.mjs waits
            // on). Skip retries (willRetry) — those emit another agent_end
            // after the next attempt, and their deltas keep appending. Finalize
            // the in-flight message and release the busy lock only on the last.
            const id = streamingIdRef.current;
            if (id !== null) {
              streamingIdRef.current = null;
              setBusy(false);
              setMessages((prev) =>
                prev.map((m) => (m.id === id ? { ...m, streaming: false } : m)),
              );
            }
          }
        };
        sse.onerror = () => {
          if (cancelled) return;
          // EventSource auto-reconnects; only flag error if we never connected.
          if (!readyRef.current) setConn("error");
        };
      } catch (err) {
        if (cancelled) return;
        console.error("agent connect failed", err);
        setConn("error");
        setMessages((prev) => [
          ...prev,
          {
            id: idRef.current++,
            role: "agent",
            text: `Could not start the agent: ${err instanceof Error ? err.message : String(err)}. Check the server logs and PI_LITELLM_* env vars.`,
          },
        ]);
      }
    }

    void connect();

    return () => {
      cancelled = true;
      readyRef.current = false;
      const sse = sseRef.current;
      if (sse) {
        sse.onmessage = null;
        sse.onerror = null;
        try { sse.close(); } catch { /* ignore */ }
      }
      sseRef.current = null;
      // Drop the server-side session + delete the PiWorker CR so the operator
      // garbage-collects the agent Deployment / Service / Ingress / Secret.
      try {
        void fetch(`${agentBase(wid)}/stop`, { method: "POST", keepalive: true });
      } catch { /* ignore */ }
    };
  }, [workspaceId]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    if (!readyRef.current) return;

    const userMsg: Message = { id: idRef.current++, role: "user", text };
    const agentMsg: Message = { id: idRef.current++, role: "agent", text: "", streaming: true };
    streamingIdRef.current = agentMsg.id;
    setMessages((prev) => [...prev, userMsg, agentMsg]);
    setInput("");
    setBusy(true);

    try {
      const res = await fetch(`${agentBase(workspaceId!)}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? `prompt failed (${res.status})`);
      }
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === agentMsg.id
            ? { ...m, streaming: false, text: `Error: ${err instanceof Error ? err.message : String(err)}` }
            : m,
        ),
      );
      setBusy(false);
      streamingIdRef.current = null;
    }
  }

  const statusLabel =
    conn === "open" ? (busy ? "Working" : "Idle") :
    conn === "connecting" ? "Connecting" :
    conn === "error" ? "Error" : "Disconnected";
  const dotColor =
    conn === "open" ? (busy ? "bg-amber-500 animate-pulse" : "bg-emerald-500") :
    conn === "connecting" ? "bg-amber-500 animate-pulse" : "bg-neutral-400";

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Panel header */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-neutral-200 px-3">
        <span className="text-xs font-medium tracking-wide text-neutral-600 uppercase">
          Assistant
        </span>
        <span className="flex items-center gap-1.5 text-xs text-neutral-500">
          <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
          {statusLabel}
        </span>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
      >
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                m.role === "user"
                  ? "bg-blue-600 text-white"
                  : "border border-neutral-200 bg-neutral-50 text-neutral-800"
              }`}
            >
              {m.text}
              {m.streaming && (
                <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-neutral-400 align-text-bottom" />
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <form
        className="shrink-0 border-t border-neutral-200 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="flex items-end gap-2 rounded-md border border-neutral-300 bg-white p-1.5 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-100">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder={conn === "open" ? "Describe what you want to build…" : "Connecting to agent…"}
            disabled={conn !== "open"}
            className="flex-1 resize-none bg-transparent px-1.5 py-1 text-sm text-neutral-800 outline-none placeholder:text-neutral-400 disabled:cursor-not-allowed disabled:text-neutral-400"
          />
          <button
            type="submit"
            disabled={busy || !input.trim() || conn !== "open"}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Send
          </button>
        </div>
        <p className="mt-1.5 px-0.5 text-[11px] text-neutral-400">
          Enter to send · Shift+Enter for a new line
        </p>
      </form>
    </div>
  );
}
