import "server-only";
import { createHash } from "node:crypto";
import { BridgeLifecycleError } from "./runtime";
import { activityDetail, activityInput, activityName, limitActivityDetails, type Activity, type ActivityDetail, type ActivityInput, type ActivityMetrics, type ActivityStatus } from "./activity";
import { MAX_HISTORY_DETAIL_BYTES, MAX_TURN_DETAIL_BYTES } from "./activity-types";

type Entry = { id: string; parentId: string | null; type: string; message?: unknown };
export type TranscriptMessage = { id: string; role: "user" | "agent"; text: string; activities?: Activity[]; truncated?: boolean };

function invalid(): never {
  throw new BridgeLifecycleError(503, "AGENT_HISTORY_INVALID", "Unable to read agent session.");
}

function activeBranch(data: unknown): Entry[] {
  if (!data || typeof data !== "object") return invalid();
  const { entries, leafId } = data as { entries?: unknown; leafId?: unknown };
  if (!Array.isArray(entries) || !(leafId === null || typeof leafId === "string")) return invalid();

  const byId = new Map<string, Entry>();
  for (const value of entries) {
    if (!value || typeof value !== "object") return invalid();
    const entry = value as Entry;
    if (typeof entry.id !== "string" || !entry.id || entry.id.length > 200 || typeof entry.type !== "string" ||
        !(entry.parentId === null || typeof entry.parentId === "string") || byId.has(entry.id)) return invalid();
    byId.set(entry.id, entry);
  }

  const branch: Entry[] = [];
  const visited = new Set<string>();
  let id = leafId as string | null;
  while (id !== null) {
    if (visited.has(id)) return invalid();
    visited.add(id);
    const entry = byId.get(id);
    if (!entry) return invalid();
    branch.push(entry);
    id = entry.parentId;
  }
  return branch.reverse();
}

export function transcriptLeaf(data: unknown): string | null {
  const branch = activeBranch(data);
  return branch.at(-1)?.id ?? null;
}

function textContent(content: unknown): string {
  return typeof content === "string" ? content : Array.isArray(content)
    ? content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("")
    : "";
}

/** Project the active Pi branch, including messages from before compaction. */
export function projectTranscript(data: unknown): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const entry of activeBranch(data)) {
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as { role?: unknown; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = textContent(message.content);
    if (text) messages.push({ id: entry.id, role: message.role === "user" ? "user" : "agent", text });
  }
  return messages;
}

type HistoryJob = { owner: TranscriptMessage; activity: Activity; input?: ActivityInput };
const historyId = (id: string) => `history-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
export type HistoryProjection = { messages: TranscriptMessage[]; activityTruncated: boolean; matched: boolean; matchedIndex?: number };

/** Recover safe activity summaries from the active branch, grouped by prompt. */
export async function projectHistory(data: unknown, cwd?: string, sourceIds: ReadonlySet<string> = new Set(), anchor?: string | null,
  expected?: { statuses: ReadonlyMap<string, ActivityStatus>; details: ReadonlyMap<string, ActivityDetail>; metrics?: ReadonlyMap<string, ActivityMetrics>; omitted?: ReadonlySet<string>; text: string }, endAnchor?: string | null): Promise<HistoryProjection> {
  const branch = activeBranch(data);
  const anchorIndex = anchor === null ? -1 : typeof anchor === "string" ? branch.findIndex((entry) => entry.id === anchor) : -2;
  const endIndex = endAnchor === undefined ? branch.length - 1 : endAnchor === null ? -1 : branch.findIndex((entry) => entry.id === endAnchor);
  const canMatch = (anchor === null || anchorIndex >= 0) && endIndex >= anchorIndex;
  const messages: TranscriptMessage[] = [];
  const retained: HistoryJob[] = [];
  const matched = new Map<string, { count: number; turn: number }>();
  const matchedActivities = new Map<string, Activity>();
  const resultIndices = new Map<Activity, number>();
  const assistantByTurn = new Map<number, TranscriptMessage>();
  const assistantBounds = new Map<number, { first: number; last: number }>();
  const boundedTurns = new Set<number>();
  let activityTruncated = false;
  let turn = 0;
  let assistant: TranscriptMessage | null = null;
  let calls = new Map<string, Activity>();

  const finish = () => {
    if (assistant && (assistant.text || assistant.activities?.length)) messages.push(assistant);
    assistant = null;
    calls = new Map();
  };

  for (let entryIndex = 0; entryIndex < branch.length; entryIndex++) {
    const entry = branch[entryIndex];
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as { role?: unknown; content?: unknown; toolCallId?: unknown; isError?: unknown };
    if (message.role === "user") {
      finish();
      turn++;
      if (canMatch && entryIndex > anchorIndex && entryIndex <= endIndex) boundedTurns.add(turn);
      const text = textContent(message.content);
      if (text) messages.push({ id: historyId(entry.id), role: "user", text });
      continue;
    }
    if (message.role === "assistant") {
      if (!assistant) {
        assistant = { id: historyId(entry.id), role: "agent", text: "", activities: [] };
        assistantByTurn.set(turn, assistant);
        assistantBounds.set(turn, { first: entryIndex, last: entryIndex });
      } else {
        assistantBounds.get(turn)!.last = entryIndex;
      }
      assistant.text += textContent(message.content);
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (!block || typeof block !== "object" || block.type !== "toolCall" || typeof block.id !== "string" || !block.id || block.id.length > 200) continue;
        const sourceId: string = block.id;
        if (canMatch && entryIndex > anchorIndex && entryIndex <= endIndex && sourceIds.has(sourceId)) {
          const previous = matched.get(sourceId);
          matched.set(sourceId, { count: (previous?.count ?? 0) + 1, turn: previous?.turn ?? turn });
        }
        if (calls.has(sourceId)) continue;
        if (calls.size >= 100) { assistant.truncated = true; activityTruncated = true; continue; }
        const name = activityName(block.name);
        const input = activityInput(name, block.arguments);
        const activity: Activity = { id: `activity-${calls.size + 1}`, name, status: "unknown", ...(input?.metrics ? { metrics: input.metrics } : {}) };
        calls.set(sourceId, activity);
        if (canMatch && entryIndex > anchorIndex && entryIndex <= endIndex && sourceIds.has(sourceId)) matchedActivities.set(sourceId, activity);
        assistant.activities!.push(activity);
        retained.push({ owner: assistant, activity, input });
        if (retained.length > 1000) {
          const oldest = retained.shift()!;
          oldest.owner.activities = oldest.owner.activities!.filter((item) => item !== oldest.activity);
          oldest.owner.truncated = true;
          activityTruncated = true;
        }
      }
      continue;
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const activity = calls.get(message.toolCallId);
      if (activity) {
        activity.status = message.isError === true ? "failed" : message.isError === false ? "done" : "unknown";
        if (matchedActivities.get(message.toolCallId) === activity) resultIndices.set(activity, entryIndex);
      }
    }
  }
  finish();

  let next = 0;
  const deadline = Date.now() + 2000;
  const timedOut = Symbol("activity-timeout");
  const detailCache = new Map<string, Promise<Activity["detail"]>>();
  await Promise.all(Array.from({ length: Math.min(8, retained.length) }, async () => {
    while (next < retained.length) {
      if (Date.now() >= deadline) { activityTruncated = true; return; }
      const job = retained[retained.length - 1 - next++];
      const key = job.input ? JSON.stringify([job.activity.name, job.input.path, job.input.command, job.input.truncated, job.input.escaped]) : "";
      let promise = key ? detailCache.get(key) : undefined;
      if (!promise) {
        promise = activityDetail(job.activity.name, job.input, cwd);
        if (key) detailCache.set(key, promise);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), Math.max(0, deadline - Date.now()));
        timer.unref?.();
      });
      let detail: Activity["detail"] | typeof timedOut;
      try { detail = await Promise.race([promise, timeout]); }
      finally { if (timer) clearTimeout(timer); }
      if (detail === timedOut) { activityTruncated = true; return; }
      if (detail) job.activity.detail = detail;
    }
  }));
  let remainingDetails = MAX_HISTORY_DETAIL_BYTES;
  for (const message of [...messages].reverse()) {
    if (message.role !== "agent" || !message.activities?.length) continue;
    const limited = limitActivityDetails(message.activities, Math.min(MAX_TURN_DETAIL_BYTES, remainingDetails));
    remainingDetails -= limited.bytes;
    if (limited.truncated) { message.truncated = true; activityTruncated = true; }
    limited.activities.forEach((value, index) => {
      const target = message.activities![index];
      if (value.detail) target.detail = value.detail; else delete target.detail;
      if (value.detailTruncated) target.detailTruncated = true; else delete target.detailTruncated;
    });
  }
  const values = [...matched.values()];
  const boundedTurn = boundedTurns.size === 1 ? [...boundedTurns][0] : undefined;
  const toolsMatch = sourceIds.size === 0 ? !!expected : matched.size === sourceIds.size && values.every((value) => value.count === 1 && value.turn === boundedTurn);
  const bounds = boundedTurn === undefined ? undefined : assistantBounds.get(boundedTurn);
  const unique = canMatch && boundedTurn !== undefined && toolsMatch && !!bounds && bounds.first > anchorIndex && bounds.last <= endIndex;
  const candidate = unique && boundedTurn !== undefined ? assistantByTurn.get(boundedTurn) : undefined;
  const complete = !expected || (!!candidate && candidate.text === expected.text && [...expected.statuses].every(([id, status]) => {
    const activity = matchedActivities.get(id);
    const detail = expected.details.get(id);
    const metrics = expected.metrics?.get(id);
    const resultIndex = activity ? resultIndices.get(activity) : undefined;
    return !!activity && !!candidate.activities?.includes(activity) &&
      (resultIndex === undefined || (resultIndex > anchorIndex && resultIndex <= endIndex)) &&
      (status === "unknown" || (activity.status === status && resultIndex !== undefined)) &&
      (detail ? !!activity.detail && activity.detail.kind === detail.kind && activity.detail.value === detail.value &&
        activity.detail.truncated === detail.truncated && activity.detail.escaped === detail.escaped : !expected.metrics || !activity.detail) &&
      (!expected.metrics || JSON.stringify(activity.metrics ?? null) === JSON.stringify(metrics ?? null)) &&
      (!expected.omitted || !!activity.detailTruncated === expected.omitted.has(id));
  }));
  const matchedIndex = unique && complete && candidate ? messages.indexOf(candidate) : -1;
  return { messages, activityTruncated, matched: matchedIndex >= 0, ...(matchedIndex >= 0 ? { matchedIndex } : {}) };
}
