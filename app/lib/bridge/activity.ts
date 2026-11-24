import "server-only";
import path from "node:path";
import { lstat } from "node:fs/promises";
import { isIgnoredName } from "@/app/lib/workspace/paths";
import { MAX_COMMAND_BYTES, MAX_PATH_BYTES, MAX_TURN_DETAIL_BYTES, type Activity, type ActivityDetail, type ActivityMetrics } from "./activity-types";

export type { Activity, ActivityDetail, ActivityMetrics, ActivityStatus } from "./activity-types";
export type ActivityInput = { path?: string; command?: string; truncated?: true; escaped?: true; metrics?: ActivityMetrics };
const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const SENSITIVE = /(?:^|[._-])(?:secret|secrets|token|password|credential|credentials|api[-_]?key)(?:[._-]|$)|^(?:\.env(?:\.|$)|\.ssh|\.aws|\.kube|\.npmrc|\.pypirc|id_rsa)$/i;

export function activityName(value: unknown): string {
  return typeof value === "string" && (FILE_TOOLS.has(value) || value === "bash") ? value : "other";
}

function unsafeControl(code: number): boolean {
  return (code < 32 && code !== 9 && code !== 10) || (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) ||
    code === 0x061c || code === 0x200e || code === 0x200f || (code >= 0xd800 && code <= 0xdfff);
}

function commandDetail(value: unknown): ActivityDetail | undefined {
  if (typeof value !== "string" || !value.length) return;
  let text = "", bytes = 0, truncated = false, escaped = false;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    const unsafe = unsafeControl(code);
    const display = unsafe ? (code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`) : char;
    const size = Buffer.byteLength(display, "utf8");
    if (bytes + size > MAX_COMMAND_BYTES) { truncated = true; break; }
    text += display;
    bytes += size;
    if (unsafe) escaped = true;
  }
  if (!text.trim() && !truncated) return;
  return { kind: "command", value: text, ...(truncated ? { truncated: true as const } : {}), ...(escaped ? { escaped: true as const } : {}) };
}

function metricsFor(name: string, input: Record<string, unknown>): ActivityMetrics | undefined {
  const metrics: ActivityMetrics = {};
  const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
  if (name === "read") {
    if (positiveInteger(input.offset)) metrics.offset = input.offset;
    if (positiveInteger(input.limit)) metrics.limit = input.limit;
  }
  if (name === "edit") {
    if (Array.isArray(input.edits)) metrics.editCount = input.edits.length;
    else if (typeof input.oldText === "string" && typeof input.newText === "string") metrics.editCount = 1;
  }
  if (name === "write" && typeof input.content === "string" && input.content.length <= 10 * 1024 * 1024) {
    metrics.writeBytes = Buffer.byteLength(input.content, "utf8");
  }
  if (name === "bash" && typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0 && input.timeout <= 2147483) {
    metrics.timeout = input.timeout;
  }
  return Object.keys(metrics).length ? metrics : undefined;
}

export function activityInput(name: string, args: unknown): ActivityInput | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return;
  const input = args as Record<string, unknown>;
  const metrics = metricsFor(name, input);
  if (name === "bash") {
    const command = commandDetail(input.command);
    if (!command) return metrics ? { metrics } : undefined;
    return { command: command.value, ...(command.truncated ? { truncated: true as const } : {}), ...(command.escaped ? { escaped: true as const } : {}), ...(metrics ? { metrics } : {}) };
  }
  const value = FILE_TOOLS.has(name) ? input.path : undefined;
  if (typeof value !== "string" || value.length > 4096 || Buffer.byteLength(value, "utf8") > 4096) return metrics ? { metrics } : undefined;
  return { path: value, ...(metrics ? { metrics } : {}) };
}

function bounded(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES) return value;
  let result = "";
  for (const char of value) {
    if (Buffer.byteLength(result + char, "utf8") > MAX_PATH_BYTES - 3) break;
    result += char;
  }
  return result + "…";
}

/** Project a bounded command or a verified workspace-relative path. */
export async function activityDetail(name: string, args: unknown, cwd?: string): Promise<ActivityDetail | undefined> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return;
  const input = args as Record<string, unknown>;
  if (name === "bash") {
    const detail = commandDetail(input.command);
    if (!detail) return;
    return { ...detail, ...(input.truncated === true ? { truncated: true as const } : {}), ...(input.escaped === true ? { escaped: true as const } : {}) };
  }
  if (!FILE_TOOLS.has(name) || !cwd || !path.isAbsolute(cwd) || typeof input.path !== "string") return;
  const raw = input.path;
  if (!raw || Buffer.byteLength(raw, "utf8") > 4096 || /[\x00-\x1f\x7f\\$?:#]/.test(raw) ||
      Array.from(raw).some((char) => unsafeControl(char.codePointAt(0)!)) || raw.startsWith("~") || raw.split("/").includes("..")) return;
  const root = path.resolve(cwd);
  const target = path.resolve(root, raw);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
  const parts = relative ? relative.split(path.sep) : [];
  if (parts.length > 64 || parts.some((part) => isIgnoredName(part) || SENSITIVE.test(part))) return;
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      return;
    }
  }
  const value = relative || ".";
  const display = bounded(value);
  return { kind: "path", value: display, ...(display !== value ? { truncated: true as const } : {}) };
}

/** Limit displayed detail text in activity order without splitting Unicode characters. */
export function limitActivityDetails(activities: readonly Activity[], budget = MAX_TURN_DETAIL_BYTES) {
  const cap = Math.max(0, budget);
  let remaining = cap, truncated = false;
  const limited = activities.map((activity) => {
    const detail = activity.detail;
    if (!detail) {
      if (activity.detailTruncated) truncated = true;
      return activity;
    }
    const bytes = Buffer.byteLength(detail.value, "utf8");
    if (bytes <= remaining) {
      remaining -= bytes;
      if (detail.truncated || activity.detailTruncated) truncated = true;
      return activity;
    }
    truncated = true;
    let text = "", used = 0;
    for (const char of detail.value) {
      const size = Buffer.byteLength(char, "utf8");
      if (used + size > remaining) break;
      text += char;
      used += size;
    }
    remaining -= used;
    if (text) return { ...activity, detail: { ...detail, value: text, truncated: true as const } };
    const withoutDetail = { ...activity };
    delete withoutDetail.detail;
    return { ...withoutDetail, detailTruncated: true as const };
  });
  return { activities: limited, bytes: cap - remaining, truncated };
}
