"use client";

import { useEffect, useRef, useState } from "react";

type Message = {
  id: number;
  role: "user" | "agent";
  text: string;
  streaming?: boolean;
};

export default function AgentPanel() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 0,
      role: "agent",
      text: "Hi! I'm PI, your coding agent. Describe the app you want and I'll build it live in the WebContainer preview on the right.",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(1);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;

    const userMsg: Message = { id: idRef.current++, role: "user", text };
    const agentMsg: Message = { id: idRef.current++, role: "agent", text: "", streaming: true };
    setMessages((prev) => [...prev, userMsg, agentMsg]);
    setInput("");
    setBusy(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        const snapshot = acc;
        setMessages((prev) =>
          prev.map((m) => (m.id === agentMsg.id ? { ...m, text: snapshot } : m)),
        );
      }
    } catch (err) {
      const fallback = err instanceof Error ? err.message : "Something went wrong.";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === agentMsg.id ? { ...m, text: `Error: ${fallback}` } : m,
        ),
      );
    } finally {
      setMessages((prev) =>
        prev.map((m) => (m.id === agentMsg.id ? { ...m, streaming: false } : m)),
      );
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Panel header */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-neutral-200 px-3">
        <span className="text-xs font-medium tracking-wide text-neutral-600 uppercase">
          Assistant
        </span>
        <span className="flex items-center gap-1.5 text-xs text-neutral-500">
          <span
            className={`h-1.5 w-1.5 rounded-full ${busy ? "animate-pulse bg-amber-500" : "bg-emerald-500"}`}
          />
          {busy ? "Working" : "Idle"}
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
            placeholder="Describe what you want to build…"
            className="flex-1 resize-none bg-transparent px-1.5 py-1 text-sm text-neutral-800 outline-none placeholder:text-neutral-400"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
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
