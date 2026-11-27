"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authenticatedFetch } from "@/app/lib/auth/client";
import { MAX_COMMAND_BYTES, MAX_HISTORY_DETAIL_BYTES, MAX_PATH_BYTES, MAX_TURN_DETAIL_BYTES, type Activity, type ActivityMetrics } from "@/app/lib/bridge/activity-types";
import { useMessages } from "@/app/lib/i18n/context";
import type { Messages } from "@/app/lib/i18n/messages";
import IconTooltip from "./IconTooltip";

type TurnPhase = "running" | "retrying" | "compacting" | "stopping" | "uncertain" | "done" | "stopped" | "failed";
type Message = {
  id: number;
  sourceId?: string;
  turnId?: string;
  role: "user" | "agent";
  text: string;
  streaming?: boolean;
  phase?: TurnPhase;
  activities?: Activity[];
  // Stable message keys into `messages.agentPanel` — never the rendered text.
  // `textKey` marks UI-generated bubbles (welcome, start-failure) so they
  // re-render on locale switch; real user/agent content always uses `text`.
  notice?: AgentPanelKey;
  textKey?: AgentPanelKey;
  truncated?: boolean;
};

type TurnSnapshot = { id: string; text: string; phase: TurnPhase; activities: Activity[]; truncated?: boolean };
type PiEvent =
  | { type: "turn_snapshot"; version: 1; sequence: number; busy: boolean; revision: string; revisionReason?: "initial" | "session" | "transport"; switching: boolean; uncertain: boolean; otherTurnLatest?: boolean; turn?: TurnSnapshot }
  | { type: "turn_event"; version: 1; sequence: number; turnId: string; event:
      | { kind: "text"; delta: string }
      | { kind: "phase"; phase: TurnPhase }
      | { kind: "activity"; activity: Activity } };

const isFinished = (phase: TurnPhase) => phase === "done" || phase === "stopped" || phase === "failed";

type AgentPanelKey = keyof Messages["agentPanel"];

const ACTIVITY_NAME_KEYS = {
  read: "activityNameRead", write: "activityNameWrite", edit: "activityNameEdit", bash: "activityNameBash",
  grep: "activityNameGrep", find: "activityNameFind", ls: "activityNameLs",
} as const satisfies Record<string, AgentPanelKey>;

function activityLabel(m: Messages["agentPanel"], name: string): string {
  const key = (ACTIVITY_NAME_KEYS as Record<string, AgentPanelKey>)[name] ?? "activityNameFallback";
  return m[key] as string;
}

function activityMetricsLabel(m: Messages["agentPanel"], metrics?: ActivityMetrics): string {
  if (!metrics) return "";
  return [
    metrics.offset !== undefined ? m.activityMetricsOffset({ offset: String(metrics.offset) }) : "",
    metrics.limit !== undefined ? m.activityMetricsLimit({ limit: String(metrics.limit) }) : "",
    metrics.editCount !== undefined ? m.activityMetricsEditCount({ count: String(metrics.editCount) }) : "",
    metrics.writeBytes !== undefined ? m.activityMetricsWriteBytes({ bytes: metrics.writeBytes.toLocaleString("en-US") }) : "",
    metrics.timeout !== undefined ? m.activityMetricsTimeout({ seconds: String(metrics.timeout) }) : "",
  ].filter(Boolean).join(" · ");
}

function hasUnsafeControls(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if ((code < 32 && code !== 9 && code !== 10) || (code >= 0x7f && code <= 0x9f) ||
        (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) ||
        code === 0x061c || code === 0x200e || code === 0x200f || (code >= 0xd800 && code <= 0xdfff)) return true;
  }
  return false;
}

function parseActivities(value: unknown): Activity[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 100) throw new Error("invalid activities");
  let detailBytes = 0;
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string" || !item.id || item.id.length > 200 ||
        !("name" in item) || typeof item.name !== "string" || item.name.length > 32 || !("status" in item) ||
        (item.status !== "running" && item.status !== "done" && item.status !== "failed" && item.status !== "unknown")) throw new Error("invalid activity");
    let detail: Activity["detail"];
    if ("detail" in item && item.detail !== undefined) {
      const value = item.detail;
      if (!value || typeof value !== "object" || !("kind" in value) || !("value" in value) ||
          (value.kind !== "path" && value.kind !== "command") || typeof value.value !== "string" ||
          value.value.length > (value.kind === "command" ? MAX_COMMAND_BYTES : MAX_PATH_BYTES) || hasUnsafeControls(value.value) ||
          new TextEncoder().encode(value.value).length > (value.kind === "command" ? MAX_COMMAND_BYTES : MAX_PATH_BYTES) ||
          ("truncated" in value && value.truncated !== true) || ("escaped" in value && value.escaped !== true)) throw new Error("invalid activity detail");
      detailBytes += new TextEncoder().encode(value.value).length;
      if (detailBytes > MAX_TURN_DETAIL_BYTES) throw new Error("activity details too large");
      detail = { kind: value.kind, value: value.value, ...("truncated" in value ? { truncated: true as const } : {}), ...("escaped" in value ? { escaped: true as const } : {}) };
    }
    let metrics: ActivityMetrics | undefined;
    if ("metrics" in item && item.metrics !== undefined) {
      if (!item.metrics || typeof item.metrics !== "object" || Array.isArray(item.metrics)) throw new Error("invalid activity metrics");
      const values = item.metrics as Record<string, unknown>;
      metrics = {};
      for (const key of ["offset", "limit", "editCount", "writeBytes", "timeout"] as const) {
        const value = values[key];
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
            (key !== "timeout" && !Number.isSafeInteger(value)) || (key === "timeout" && value > 2147483)) throw new Error("invalid activity metric");
        metrics[key] = value;
      }
    }
    if ("detailTruncated" in item && item.detailTruncated !== true && item.detailTruncated !== undefined) throw new Error("invalid activity truncation");
    return { id: item.id, name: item.name, status: item.status, ...(detail ? { detail } : {}),
      ...(metrics ? { metrics } : {}), ...("detailTruncated" in item && item.detailTruncated === true ? { detailTruncated: true as const } : {}) };
  });
}

function activityKey(message: Message): string {
  return message.turnId ? `turn:${message.turnId}` : message.sourceId ? `history:${message.sourceId}` : `message:${message.id}`;
}

type ConnState = "connecting" | "open" | "closed" | "error";

const ATTACHMENTS_DIR = ".attachments";

// Locale-neutral size parts; the surrounding sentence comes from the catalog.
function formatBytesParts(bytes: number): { value: string; bytes: string } {
  const value = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MiB` : `${(bytes / 1024).toFixed(2)} KiB`;
  return { value, bytes: bytes.toLocaleString("en-US") };
}

function formatBytes(m: Messages["agentPanel"], bytes: number): string {
  return m.formatBytesDetail(formatBytesParts(bytes));
}

// Upload failures are either a stable catalog key (plus vars), a verbatim
// server-provided message (API content, never re-localized), or a composite
// of the localized size prefix plus a nested detail.
type UploadErrorValue =
  | { kind: "key"; key: AgentPanelKey; vars?: Record<string, string> }
  | { kind: "text"; text: string }
  | { kind: "sized"; size: string; detail: UploadErrorValue };

async function uploadError(response: Response): Promise<UploadErrorValue> {
  let code: string | undefined;
  let message: string | undefined;
  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = await response.json();
      code = body?.error?.code;
      message = body?.error?.message;
    } catch { /* A proxy may return an invalid or empty response. */ }
  }
  const knownCodes = ["FILE_TOO_LARGE", "WORKSPACE_TOTAL_TOO_LARGE", "WORKSPACE_FILE_COUNT_LIMIT", "WORKSPACE_INVALID", "INVALID_REQUEST", "INVALID_PATH", "PATH_IGNORED", "PATH_OUTSIDE_WORKSPACE", "PATH_UNSAFE", "PATH_IS_DIRECTORY", "WRITE_FAILED", "WORKSPACE_NOT_FOUND", "ORIGIN_MISMATCH"];
  if (typeof code === "string" && knownCodes.includes(code) && typeof message === "string") {
    return { kind: "text", text: `${message.slice(0, 300)}（${response.status}）` };
  }
  if (response.status === 413) {
    return { kind: "key", key: "uploadGateway413" };
  }
  if (response.status === 403) return { kind: "key", key: "uploadForbidden" };
  if (response.status === 404) return { kind: "key", key: "uploadNotFound" };
  return { kind: "key", key: "uploadRejected", vars: { status: String(response.status) } };
}

function renderUploadError(m: Messages["agentPanel"], error: UploadErrorValue): string {
  if (error.kind === "text") return error.text;
  if (error.kind === "sized") {
    return `${m.attachmentSizePrefix({ size: error.size })}${renderUploadError(m, error.detail)}`;
  }
  const leaf = m[error.key];
  // Keys are stored with the exact vars their template needs; the union of
  // leaf signatures can't express that, so dispatch through a loose callable.
  return typeof leaf === "function" ? (leaf as (vars: Record<string, string>) => string)(error.vars ?? {}) : leaf;
}

type PendingAttachment = {
  name: string;
  path: string;
  status: "uploading" | "ready" | "failed";
  error?: UploadErrorValue;
};

type Activation = {
  clientId: string;
  issuedAt: number;
  workspaceId: string;
  released: boolean;
  ready: boolean;
  streamingId: number | null;
  turnId: string | null;
  lastTurnId: string | null;
  sequence: number;
  revision: string | null;
  sessionActionPending: boolean;
  sessionActionRevision: string | null;
  cancelPending: boolean;
  historyReady: boolean;
  historyLoading: boolean;
  historySupported: boolean | null;
  serverBusy: boolean;
  draft: { text: string; attachments: PendingAttachment[] } | null;
  readyTimer?: ReturnType<typeof setTimeout>;
  controller: AbortController;
  sse: EventSource | null;
};

const agentBase = (wid: string) => `/api/v1/workspaces/${encodeURIComponent(wid)}/agent`;
// Notices are stored as stable catalog keys so a locale switch re-renders them
// without touching message state; rendered text never feeds back into logic.
const SEND_UNCERTAIN_NOTICE: AgentPanelKey = "noticeSendUncertain";
const STOP_UNCERTAIN_NOTICE: AgentPanelKey = "noticeStopUncertain";
const HISTORY_UNCONFIRMED_NOTICE: AgentPanelKey = "noticeHistoryUnconfirmed";
const SESSION_MISMATCH_NOTICE: AgentPanelKey = "noticeSessionMismatch";
const WELCOME_ID = 0;
const welcome: Message = {
  id: WELCOME_ID,
  role: "agent",
  text: "",
  textKey: "welcome",
};

type AgentPanelProps = { workspaceId: string | null; maxFileBytes?: number | null };

export default function AgentPanel(props: AgentPanelProps) {
  return <AgentPanelContent key={props.workspaceId ?? ""} {...props} />;
}

function AgentPanelContent({ workspaceId, maxFileBytes = null }: AgentPanelProps) {
  const i18n = useMessages();
  // `ap` = agentPanel catalog. (Message-map callbacks shadow `m` below.)
  const ap = i18n.agentPanel;
  const [messages, setMessages] = useState<Message[]>([welcome]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [otherBusy, setOtherBusy] = useState(false);
  const [phase, setPhase] = useState<TurnPhase>("running");
  const [stopping, setStopping] = useState(false);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [historyState, setHistoryState] = useState<"loading" | "ready" | "error">("loading");
  const [sessionSupported, setSessionSupported] = useState(false);
  const [canRestore, setCanRestore] = useState(false);
  const [restoreNeedsMigration, setRestoreNeedsMigration] = useState(false);
  const [sessionSwitching, setSessionSwitching] = useState(false);
  const [sessionActionPending, setSessionActionPending] = useState(false);
  const [sessionUncertain, setSessionUncertain] = useState(false);
  const [sessionMismatch, setSessionMismatch] = useState(false);
  // Stable catalog key ("" = none) so locale switches re-render the notice.
  const [sessionNotice, setSessionNotice] = useState<"" | AgentPanelKey>("");
  const [activityOpen, setActivityOpen] = useState<Record<string, boolean>>({});
  const [historyActivityTruncated, setHistoryActivityTruncated] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const retainedTurnRef = useRef<string | null>(null);
  const pendingTurnsRef = useRef(new Set<string>());
  const unconfirmedTurnRef = useRef<string | null>(null);
  const sessionMismatchRef = useRef(false);
  const historyTurnIdsRef = useRef(new Map<string, string>());
  const latestActivityKeyRef = useRef<string | null>(null);
  const idRef = useRef(1);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
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

    async function loadHistory(lease: Activation) {
      const current = () => !lease.released && activeRef.current === lease;
      if (!current() || !lease.ready || lease.serverBusy || lease.historyReady || lease.historyLoading) return;
      lease.historyLoading = true;
      const requestedAt = lease.sequence;
      let retry = false;
      try {
        const res = await authenticatedFetch(`${agentBase(wid)}/session?clientId=${encodeURIComponent(lease.clientId)}`, {
          cache: "no-store", signal: lease.controller.signal,
        });
        if (!current()) return;
        if (res.status === 409) {
          retry = lease.sequence !== requestedAt;
          return;
        }
        if (!res.ok) throw new Error("history request failed");
        const body: unknown = await res.json();
        if (!current()) return;
        if (!body || typeof body !== "object" || !("supported" in body)) throw new Error("invalid history response");
        if (body.supported === false) {
          lease.historySupported = false;
          lease.historyReady = true;
          setSessionSupported(false);
          setHistoryState("ready");
          return;
        }
        if (body.supported !== true || !("sequence" in body) || !Number.isSafeInteger(body.sequence) ||
            !("revision" in body) || typeof body.revision !== "string" || !("canRestore" in body) || typeof body.canRestore !== "boolean" ||
            !("messages" in body) || !Array.isArray(body.messages)) throw new Error("invalid history response");
        if (!lease.ready || lease.serverBusy || body.sequence !== lease.sequence || body.revision !== lease.revision) {
          retry = lease.ready && !lease.serverBusy && typeof body.sequence === "number" &&
            (body.sequence < lease.sequence || (body.sequence === lease.sequence && body.revision !== lease.revision));
          return;
        }
        setSessionSupported(true);
        setCanRestore(body.canRestore);
        setRestoreNeedsMigration("restoreNeedsMigration" in body && body.restoreNeedsMigration === true);
        lease.historySupported = true;
        const matchedIndex = "reconciledTurnId" in body && body.reconciledTurnId === lease.lastTurnId &&
          "reconciledIndex" in body && typeof body.reconciledIndex === "number" && Number.isSafeInteger(body.reconciledIndex)
          ? body.reconciledIndex : -1;
        const matchedItem: unknown = matchedIndex >= 0 ? body.messages[matchedIndex] : null;
        const matched = !!lease.lastTurnId && !!matchedItem && typeof matchedItem === "object" &&
          "role" in matchedItem && matchedItem.role === "agent" && "id" in matchedItem && typeof matchedItem.id === "string";
        const pendingMatch = !!matched && !!lease.lastTurnId && pendingTurnsRef.current.has(lease.lastTurnId);
        if (pendingTurnsRef.current.size - (pendingMatch ? 1 : 0) > 0 || (lease.lastTurnId && !matched) ||
            (unconfirmedTurnRef.current && (!matched || lease.lastTurnId !== unconfirmedTurnRef.current))) {
          if (!unconfirmedTurnRef.current) unconfirmedTurnRef.current = pendingTurnsRef.current.values().next().value ?? lease.lastTurnId;
          setSessionNotice(sessionMismatchRef.current ? SESSION_MISMATCH_NOTICE : HISTORY_UNCONFIRMED_NOTICE);
          lease.historyReady = true;
          setHistoryState("ready");
          return;
        }
        const restored: Message[] = body.messages.map((item: unknown, index: number) => {
          if (!item || typeof item !== "object" || !("role" in item) || !("text" in item) ||
              (item.role !== "user" && item.role !== "agent") || typeof item.text !== "string") throw new Error("invalid history message");
          const sourceId = "id" in item && typeof item.id === "string" ? item.id : undefined;
          const turnId = matched && index === matchedIndex ? lease.lastTurnId ?? undefined : sourceId ? historyTurnIdsRef.current.get(sourceId) : undefined;
          return { id: idRef.current++, sourceId, turnId, role: item.role, text: item.text,
            activities: parseActivities("activities" in item ? item.activities : undefined), truncated: "truncated" in item && item.truncated === true };
        });
        const detailBytes = restored.reduce((total, message) => total + (message.activities ?? []).reduce(
          (sum, activity) => sum + (activity.detail ? new TextEncoder().encode(activity.detail.value).length : 0), 0), 0);
        if (detailBytes > MAX_HISTORY_DETAIL_BYTES) throw new Error("history details too large");
        if (matched && matchedItem && typeof matchedItem === "object" && "id" in matchedItem && typeof matchedItem.id === "string" && lease.lastTurnId) {
          pendingTurnsRef.current.delete(lease.lastTurnId);
          historyTurnIdsRef.current.set(matchedItem.id, lease.lastTurnId);
          if (unconfirmedTurnRef.current === lease.lastTurnId) unconfirmedTurnRef.current = null;
        }
        const latest = [...restored].reverse().find((message) => message.role === "agent");
        const latestKey = latest ? activityKey(latest) : null;
        if (latestKey !== latestActivityKeyRef.current) setActivityOpen({});
        latestActivityKeyRef.current = latestKey;
        setHistoryActivityTruncated("activityTruncated" in body && body.activityTruncated === true);
        setMessages(restored.length ? restored : [welcome]);
        sessionMismatchRef.current = false;
        setSessionMismatch(false);
        setSessionNotice((notice) => notice === HISTORY_UNCONFIRMED_NOTICE || notice === SESSION_MISMATCH_NOTICE ? "" : notice);
        lease.lastTurnId = null;
        retainedTurnRef.current = null;
        lease.historyReady = true;
        setHistoryState("ready");
      } catch {
        if (current()) setHistoryState("error");
      } finally {
        lease.historyLoading = false;
        if (retry && current() && lease.ready && !lease.serverBusy) void loadHistory(lease);
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
          // Internal-only error (logged, never rendered); keep it locale-neutral.
          throw new Error(`agent start failed (${res.status})`);
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
            if (event.sequence < lease.sequence || typeof event.revision !== "string") return;
            if (lease.revision !== null && lease.revision !== event.revision) {
              const initiatedHere = lease.sessionActionRevision === lease.revision;
              lease.sessionActionRevision = null;
              lease.historyReady = false;
              setCanRestore(false);
              setHistoryState("loading");
              if (event.revisionReason === "transport" && lease.turnId) restoreDraft(lease);
              if (event.revisionReason !== "transport") {
                restoreDraft(lease);
                lease.draft = null;
                lease.streamingId = null;
                lease.turnId = null;
                lease.cancelPending = false;
                setBusy(false);
                setStopping(false);
                if (retainedTurnRef.current && !initiatedHere) {
                  unconfirmedTurnRef.current ??= retainedTurnRef.current;
                  sessionMismatchRef.current = true;
                  setSessionMismatch(true);
                  setSessionNotice(SESSION_MISMATCH_NOTICE);
                } else {
                  sessionMismatchRef.current = false;
                  setSessionMismatch(false);
                  stickToBottomRef.current = true;
                  lease.lastTurnId = null;
                  retainedTurnRef.current = null;
                  pendingTurnsRef.current.clear();
                  unconfirmedTurnRef.current = null;
                  historyTurnIdsRef.current.clear();
                  latestActivityKeyRef.current = null;
                  setActivityOpen({});
                  setHistoryActivityTruncated(false);
                  setMessages([welcome]);
                }
              }
            }
            lease.revision = event.revision;
            lease.sequence = event.sequence;
            lease.ready = true;
            lease.serverBusy = event.busy;
            if (lease.readyTimer) clearTimeout(lease.readyTimer);
            lease.readyTimer = undefined;
            setConn("open");
            const turn = event.turn;
            let snapshotActivities: Activity[] | undefined;
            if (turn && Array.isArray(turn.activities)) {
              try { snapshotActivities = parseActivities(turn.activities); } catch { /* Ignore malformed activity data. */ }
            }
            const ownTurn = !!turn && turn.id === lease.turnId && !isFinished(turn.phase);
            const otherPageBusy = event.busy && !ownTurn;
            setOtherBusy(otherPageBusy);
            setSessionSwitching(event.switching === true);
            setSessionUncertain(event.uncertain === true || (otherPageBusy && turn?.phase === "uncertain"));
            if (otherPageBusy && lease.historySupported === true && lease.historyReady) {
              lease.historyReady = false;
              setHistoryState("loading");
            }
            const ownedSnapshot = !!turn && (turn.id === lease.turnId || turn.id === lease.lastTurnId) &&
              typeof turn.text === "string" && snapshotActivities !== undefined;
            if (!event.busy && !lease.historyReady) {
              if (ownedSnapshot && event.otherTurnLatest !== true) {
                lease.historyReady = true;
                setHistoryState("ready");
              } else void loadHistory(lease);
            }
            const id = lease.streamingId;
            if (ownedSnapshot && turn && turn.id === lease.lastTurnId && turn.id !== lease.turnId && isFinished(turn.phase)) {
              setMessages((prev) => prev.map((message) => message.turnId === turn.id && message.role === "agent"
                ? { ...message, text: turn.text, activities: snapshotActivities!, phase: turn.phase, streaming: false, truncated: turn.truncated }
                : message));
            }
            const activities = snapshotActivities;
            if (!turn || turn.id !== lease.turnId || id === null || typeof turn.text !== "string" || !activities) return;
            setPhase(turn.phase);
            setStopping(turn.phase === "stopping");
            setMessages((prev) => prev.map((m) => m.id === id ? {
              ...m, text: turn.text, activities, phase: turn.phase,
              notice: (turn.text.length > 0 || activities.length > 0) && m.notice === SEND_UNCERTAIN_NOTICE ? undefined : m.notice,
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
            setMessages((prev) => prev.map((m) => m.id === id ? { ...m, text: m.text + update.delta, notice: m.notice === SEND_UNCERTAIN_NOTICE ? undefined : m.notice } : m));
          } else if (update.kind === "activity") {
            let item: Activity;
            try { item = parseActivities([update.activity])![0]; } catch { return; }
            setMessages((prev) => prev.map((m) => {
              if (m.id !== id) return m;
              const activities = m.activities ?? [];
              const index = activities.findIndex((activity) => activity.id === item.id);
              if (index < 0 && activities.length >= 100) return { ...m, truncated: true };
              const next = index < 0 ? [...activities, item] : activities.map((activity, i) => i === index ? item : activity);
              try {
                return { ...m, notice: m.notice === SEND_UNCERTAIN_NOTICE ? undefined : m.notice, activities: parseActivities(next) };
              } catch { return { ...m, truncated: true }; }
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
          if (lease.historySupported === true) {
            lease.historyReady = false;
            setHistoryState("loading");
          }
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
            text: "",
            textKey: "errorStartFailed",
          },
        ]);
      }
    }

    function activate() {
      activation = {
        clientId: crypto.randomUUID(), issuedAt: Date.now(), workspaceId: wid,
        released: false, ready: false, streamingId: null, turnId: null, lastTurnId: retainedTurnRef.current,
        sequence: -1, revision: null, sessionActionPending: false, sessionActionRevision: null, cancelPending: false, historyReady: false, historyLoading: false, historySupported: null, serverBusy: false,
        draft: null, controller: new AbortController(), sse: null,
      };
      activeRef.current = activation;
      setHistoryState("loading");
      setSessionSupported(false);
      setCanRestore(false);
      setSessionSwitching(false);
      setSessionActionPending(false);
      setSessionUncertain(false);
      setSessionMismatch(sessionMismatchRef.current);
      setSessionNotice(sessionMismatchRef.current ? SESSION_MISMATCH_NOTICE : "");
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
      const safeName = Array.from(file.name.replace(/[\x00-\x1f\x7f\\/:*?"<>|#%]/g, "_")).slice(0, 40).join("") || "attachment";
      const attachmentName = `${crypto.randomUUID()}-${safeName}`;
      const attachmentPath = `${ATTACHMENTS_DIR}/${attachmentName}`;
      if (maxFileBytes !== null && file.size > maxFileBytes) {
        setAttachments((prev) => [...prev, {
          name: file.name, path: attachmentPath, status: "failed",
          error: { kind: "key", key: "attachmentTooLarge", vars: { actual: formatBytes(ap, file.size), limit: formatBytes(ap, maxFileBytes) } },
        }]);
        continue;
      }
      const pending: PendingAttachment = { name: file.name, path: attachmentPath, status: "uploading" };
      setAttachments((prev) => [...prev, pending]);
      try {
        const res = await authenticatedFetch(
          `/api/v1/workspaces/${encodeURIComponent(wid)}/files/${encodeURIComponent(ATTACHMENTS_DIR)}/${encodeURIComponent(attachmentName)}`,
          { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file },
        );
        if (!res.ok) {
          const detail = await uploadError(res);
          const error: UploadErrorValue = { kind: "sized", size: formatBytes(ap, file.size), detail };
          setAttachments((prev) => prev.map((a) => (a.path === attachmentPath ? { ...a, status: "failed", error } : a)));
        } else {
          setAttachments((prev) => prev.map((a) => (a.path === attachmentPath ? { ...a, status: "ready" } : a)));
        }
      } catch {
        setAttachments((prev) => prev.map((a) => (a.path === attachmentPath ? { ...a, status: "failed", error: { kind: "key", key: "attachmentNetworkError" } } : a)));
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
    if (!lease || lease.released || !lease.ready || !lease.historyReady || !lease.revision || lease.serverBusy || lease.sessionActionPending || sessionMismatchRef.current || lease.turnId !== null || lease.workspaceId !== workspaceId) return;
    if (attachments.some((a) => a.status === "uploading")) return;

    const ready = attachments.filter((a) => a.status === "ready");
    const failed = attachments.filter((a) => a.status === "failed");
    if (failed.length) return; // surface failure instead of silently dropping it

    const body = ready.length
      ? `${text}\n\n附件已保存到工作区，请读取使用：\n${ready.map((a) => `- ${a.path}（${a.name}）`).join("\n")}`
      : text;

    const turnId = crypto.randomUUID();
    const userMsg: Message = { id: idRef.current++, turnId, role: "user", text: body };
    const agentMsg: Message = { id: idRef.current++, turnId, role: "agent", text: "", streaming: true, phase: "running", activities: [] };
    lease.streamingId = agentMsg.id;
    lease.turnId = turnId;
    lease.lastTurnId = turnId;
    retainedTurnRef.current = turnId;
    pendingTurnsRef.current.add(turnId);
    latestActivityKeyRef.current = activityKey(agentMsg);
    setActivityOpen({});
    lease.draft = { text, attachments: ready };
    stickToBottomRef.current = true;
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
        body: JSON.stringify({ clientId: lease.clientId, turnId, message: body, revision: lease.revision }),
      });
      if (!res.ok && res.status >= 500 && !lease.released && activeRef.current === lease && lease.turnId === turnId) {
        restoreDraft(lease);
        setMessages((prev) => prev.map((m) => m.id === agentMsg.id
          ? { ...m, notice: SEND_UNCERTAIN_NOTICE }
          : m));
      } else if (!res.ok && !lease.released && activeRef.current === lease && lease.turnId === turnId) {
        setMessages((prev) => prev.map((m) => m.id === agentMsg.id
          ? { ...m, streaming: false, phase: "failed", notice: res.status === 409 ? "noticeSendConflict" : "noticeSendFailed" }
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
        ? { ...m, notice: SEND_UNCERTAIN_NOTICE }
        : m));
    }
  }

  async function changeSession(action: "new" | "restore") {
    const lease = activeRef.current;
    if (!lease || lease.released || !lease.ready || !lease.historyReady || !lease.revision ||
        lease.serverBusy || lease.sessionActionPending || sessionMismatchRef.current || lease.turnId !== null || !sessionSupported || sessionUncertain ||
        (action === "restore" && !canRestore)) return;
    if (unconfirmedTurnRef.current && !window.confirm(ap.confirmDiscardUnconfirmed)) return;
    const confirmMigration = action === "restore" && restoreNeedsMigration;
    if (confirmMigration && !window.confirm(ap.confirmMigration)) return;
    lease.sessionActionPending = true;
    lease.sessionActionRevision = lease.revision;
    setSessionActionPending(true);
    setSessionNotice("");
    try {
      const res = await authenticatedFetch(`${agentBase(lease.workspaceId)}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: lease.clientId, revision: lease.revision, action, confirmMigration }),
        signal: lease.controller.signal,
      });
      if (lease.released || activeRef.current !== lease) return;
      const body = await res.json().catch(() => ({}));
      if (lease.released || activeRef.current !== lease) return;
      if (!res.ok) {
        lease.sessionActionRevision = null;
        const code = body?.error?.code;
        if (code === "SESSION_NOT_SAVED") setSessionNotice("noticeSessionNotSaved");
        else if (code === "SESSION_EXPIRED") { setCanRestore(false); setSessionNotice("noticeSessionExpired"); }
        else if (code === "SESSION_CHANGED" || code === "AGENT_BUSY") setSessionNotice("noticeSessionChanged");
        else setSessionNotice("noticeSessionSwitchFailed");
        if (res.status >= 500) { lease.historyReady = false; setSessionUncertain(true); }
      } else if (body.cancelled === true) {
        lease.sessionActionRevision = null;
        setSessionNotice("noticeSessionCancelled");
      }
    } catch {
      lease.sessionActionRevision = null;
      if (!lease.released && activeRef.current === lease) {
        lease.historyReady = false;
        setSessionUncertain(true);
        setSessionNotice("noticeSessionUnconfirmedSwitch");
      }
    } finally {
      lease.sessionActionPending = false;
      if (!lease.released && activeRef.current === lease) setSessionActionPending(false);
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
        body: JSON.stringify({ clientId: lease.clientId, turnId, revision: lease.revision }),
      });
      if (!res.ok) throw new Error("cancel failed");
    } catch {
      if (lease.released || activeRef.current !== lease || lease.turnId !== turnId) return;
      lease.cancelPending = false;
      setStopping(false);
      setPhase(previousPhase);
      setMessages((prev) => prev.map((m) => m.id === id ? { ...m, phase: previousPhase, notice: STOP_UNCERTAIN_NOTICE } : m));
    }
  }

  const turnUnconfirmed = messages.some((message) => message.streaming && (message.notice === SEND_UNCERTAIN_NOTICE || message.notice === STOP_UNCERTAIN_NOTICE));
  const workingLabel = phase === "uncertain" ? ap.statusUncertainTask : stopping ? ap.statusStopping : turnUnconfirmed ? ap.statusUncertainTask : phase === "retrying" ? ap.statusRetrying : phase === "compacting" ? ap.statusCompacting : ap.statusWorking;
  const statusLabel =
    conn === "open" ? (sessionMismatch ? ap.statusSessionSwitched : sessionUncertain ? ap.statusSessionUncertain : sessionSwitching || sessionActionPending ? ap.statusSessionSwitching : busy ? workingLabel : otherBusy ? ap.statusOtherBusy : historyState === "error" ? ap.statusHistoryError : historyState === "loading" ? ap.statusHistoryLoading : ap.statusIdle) :
    conn === "connecting" ? ap.statusConnecting :
    conn === "error" ? ap.statusConnError : ap.statusClosed;
  const dotColor =
    conn === "open" ? (busy ? "bg-amber-500 animate-pulse motion-reduce:animate-none" : "bg-[#799b39]") :
    conn === "connecting" ? "bg-amber-500 animate-pulse motion-reduce:animate-none" : "bg-neutral-400";
  let latestAssistantId: number | null = null;
  for (const message of messages) if (message.role === "agent" && message.id !== welcome.id) latestAssistantId = message.id;

  return (
    <div className="flex h-full flex-col bg-[#fffefa]">
      {/* Panel header */}
      <div className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-[var(--brand-line)] bg-[var(--brand-paper)] px-4">
        <span className="flex shrink-0 items-center gap-2 whitespace-nowrap text-sm font-bold text-[var(--brand-ink)]">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-[var(--brand-lime)] text-base" aria-hidden="true">✳</span>{ap.title}
        </span>
        <div className="flex min-w-0 items-center gap-1.5">
          <span role="status" aria-live="polite" title={statusLabel} className="flex min-w-0 items-center gap-1.5 rounded-full border border-[#dce3d3] bg-white px-2.5 py-1 text-xs text-[var(--brand-muted)]">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} />
            <span className="truncate">{statusLabel}</span>
          </span>
          <IconTooltip label={ap.actionNewSession}>
            <button type="button" aria-label={ap.actionNewSession} onClick={() => void changeSession("new")}
              disabled={conn !== "open" || historyState !== "ready" || !sessionSupported || sessionSwitching || sessionActionPending || sessionUncertain || sessionMismatch || busy || otherBusy}
              className="flex h-10 w-10 items-center justify-center rounded-md text-[var(--brand-ink)] hover:bg-[#eff5d9] disabled:pointer-events-none disabled:opacity-40">
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            </button>
          </IconTooltip>
          <IconTooltip label={ap.actionRestoreSessionHint}>
            <button type="button" aria-label={ap.actionRestoreSession} onClick={() => void changeSession("restore")}
              disabled={conn !== "open" || historyState !== "ready" || !sessionSupported || !canRestore || sessionSwitching || sessionActionPending || sessionUncertain || sessionMismatch || busy || otherBusy}
              className="flex h-10 w-10 items-center justify-center rounded-md text-[var(--brand-ink)] hover:bg-[#eff5d9] disabled:pointer-events-none disabled:opacity-40">
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></svg>
            </button>
          </IconTooltip>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5"
      >
        {sessionUncertain && <p role="alert" className="text-sm text-red-600">{ap.alertSessionUncertain}</p>}
        {sessionNotice && <p role="alert" className="text-sm text-red-600">{ap[sessionNotice] as string}</p>}
        {historyState === "error" && <p role="alert" className="text-sm text-red-600">{ap.alertHistoryError}</p>}
        {historyActivityTruncated && <p className="text-xs text-[var(--brand-muted)]">{ap.alertHistoryTruncated}</p>}
        {messages.map((m) => {
          const key = activityKey(m);
          const expanded = activityOpen[key] ?? (m.id === latestAssistantId);
          return <div
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
              {m.textKey ? ap[m.textKey] as string : m.text}
              {m.streaming && m.text && (
                <span aria-hidden="true" className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-neutral-400 align-text-bottom motion-reduce:animate-none" />
              )}
              {m.streaming && !m.text && (
                <div className="text-[var(--brand-muted)]">
                  {m.phase === "stopping" ? ap.streamStopping : m.phase === "uncertain" || m.notice === SEND_UNCERTAIN_NOTICE || m.notice === STOP_UNCERTAIN_NOTICE ? ap.streamUncertain : m.phase === "retrying" ? ap.streamRetrying : m.phase === "compacting" ? ap.streamCompacting : ap.streamWorking}
                </div>
              )}
              {!!m.activities?.length && (
                <div className="mt-2 border-t border-[#e1e6d8] pt-2 text-xs text-[#66715c]">
                  <button type="button" aria-expanded={expanded} aria-controls={`activity-${m.id}`}
                    onClick={() => setActivityOpen((previous) => ({ ...previous, [key]: !expanded }))}
                    className="flex items-center gap-1 rounded text-left font-medium hover:text-[var(--brand-ink)]">
                    <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>{ap.activityToggle({ count: String(m.activities.length) })}
                  </button>
                  <section id={`activity-${m.id}`} hidden={!expanded} className="mt-1 space-y-1" aria-label={ap.activityRegion}>
                    {m.activities.map((activity) => {
                      const status = activity.status === "running" && m.phase === "uncertain" ? "unknown" : activity.status;
                      const metrics = activityMetricsLabel(ap, activity.metrics);
                      return <div key={activity.id} className="flex items-start gap-1.5">
                        <span aria-hidden="true">{status === "running" ? "◌" : status === "failed" ? "!" : status === "unknown" ? "?" : "✓"}</span>
                        <div className="min-w-0 flex-1">
                          <div className="break-all">{activityLabel(ap, activity.name)}{activity.detail?.kind === "path" ? ` · ${activity.detail.value}` : ""} · {status === "running" ? ap.activityStatusRunning : status === "failed" ? ap.activityStatusFailed : status === "unknown" ? ap.activityStatusUnknown : ap.activityStatusDone}</div>
                          {metrics && <div className="mt-0.5 text-[var(--brand-muted)]">{metrics}</div>}
                          {activity.detail?.kind === "command" && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-white px-2 py-1 font-mono text-[var(--brand-ink)]">{activity.detail.value}</pre>}
                          {(activity.detailTruncated || activity.detail?.truncated) && <div className="mt-0.5">{ap.activityDetailTruncated}</div>}
                          {activity.detail?.escaped && <div className="mt-0.5">{ap.activityDetailEscaped}</div>}
                        </div>
                      </div>;
                    })}
                  </section>
                </div>
              )}
              {m.phase === "uncertain" && <p className="mt-2 text-xs text-red-600">{ap.alertTurnUncertain}</p>}
              {m.phase === "stopped" && <p className="mt-2 text-xs text-neutral-500">{ap.alertTurnStopped}</p>}
              {m.phase === "failed" && !m.notice && <p className="mt-2 text-xs text-red-600">{ap.alertTurnFailed}</p>}
              {m.truncated && <p className="mt-2 text-xs text-neutral-500">{ap.alertTurnTruncated}</p>}
              {m.notice && <p className="mt-2 text-xs text-red-600">{ap[m.notice] as string}</p>}
            </div>
          </div>;
        })}
      </div>

      {/* Input */}
      <form
        className="shrink-0 border-t border-[var(--brand-line)] bg-[var(--brand-paper)] p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {busy && conn === "open" && phase !== "uncertain" && !sessionUncertain && !turnUnconfirmed && (
          <div data-assistant-waiting="" aria-hidden="true" className="mb-2 flex items-center gap-2 text-xs text-[var(--brand-muted)]">
            <svg viewBox="0 0 48 48" className="h-8 w-8 motion-safe:animate-bounce motion-reduce:animate-none" aria-hidden="true">
              <path d="M24 5v6" stroke="#42385f" strokeWidth="2.5" strokeLinecap="round" />
              <circle cx="24" cy="5" r="3" fill="#b9db70" />
              <rect x="6" y="11" width="36" height="30" rx="10" fill="#f0ebfe" stroke="#42385f" strokeWidth="2.5" />
              <circle cx="17" cy="23" r="2.5" fill="#42385f" /><circle cx="31" cy="23" r="2.5" fill="#42385f" />
              <path d="M19 31q5 5 10 0" fill="none" stroke="#42385f" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
            <span>{workingLabel}…</span>
          </div>
        )}
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
                <span className="min-w-0 break-all">
                  {a.name}
                  {a.status === "uploading" ? ` · ${ap.attachmentUploading}` : a.status === "failed" && a.error ? <span role="alert"> · {ap.attachmentFailedPrefix}{renderUploadError(ap, a.error)}</span> : ""}
                </span>
                <button
                  type="button"
                  onClick={() => removeAttachment(a.path)}
                  aria-label={ap.attachmentRemove({ name: a.name })}
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
            aria-label={ap.actionUpload}
            title={ap.actionUpload}
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
            aria-label={ap.inputAriaLabel}
            rows={2}
            placeholder={conn !== "open" ? (conn === "error" ? ap.placeholderConnError : ap.placeholderConnecting) : sessionMismatch ? ap.placeholderSessionMismatch : busy ? ap.placeholderBusy : otherBusy ? ap.placeholderOtherBusy : ap.placeholderIdle}
            disabled={conn !== "open" || busy || otherBusy || sessionMismatch}
            className="min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1 text-sm text-neutral-800 outline-none placeholder:text-neutral-400 disabled:cursor-not-allowed disabled:text-neutral-400"
          />
          <IconTooltip placement="top" label={phase === "uncertain" && busy ? ap.actionStopUncertain : stopping ? ap.statusStopping : ap.actionStop}>
            <button
              type="button"
              onClick={() => void stop()}
              disabled={!busy || stopping || phase === "uncertain"}
              aria-label={ap.actionStop}
              aria-busy={stopping}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-red-600 hover:bg-red-50 disabled:pointer-events-none disabled:opacity-40"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
            </button>
          </IconTooltip>
          <IconTooltip placement="top" label={ap.actionSend}>
            <button
              type="submit"
              aria-label={ap.actionSend}
              disabled={busy || otherBusy || sessionSwitching || sessionActionPending || sessionUncertain || sessionMismatch || historyState !== "ready" || !input.trim() || conn !== "open" || attachments.some((a) => a.status !== "ready")}
              className="brand-button h-9 w-9 shrink-0 p-0 disabled:pointer-events-none"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
            </button>
          </IconTooltip>
        </div>
        <p className="mt-1.5 px-0.5 text-[13px] text-neutral-400">
          {ap.inputHint}{maxFileBytes !== null ? ap.inputHintFileLimit({ limit: formatBytes(ap, maxFileBytes) }) : ""}
        </p>
      </form>
    </div>
  );
}
