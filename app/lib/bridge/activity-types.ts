// Shared, browser-safe activity contract and byte limits.
export const MAX_COMMAND_BYTES = 4096;
export const MAX_PATH_BYTES = 256;
export const MAX_TURN_DETAIL_BYTES = 64 * 1024;
export const MAX_HISTORY_DETAIL_BYTES = 512 * 1024;

export type ActivityStatus = "running" | "done" | "failed" | "unknown";
export type ActivityDetail = { kind: "path" | "command"; value: string; truncated?: true; escaped?: true };
export type ActivityMetrics = { offset?: number; limit?: number; editCount?: number; writeBytes?: number; timeout?: number };
export type Activity = { id: string; name: string; status: ActivityStatus; detail?: ActivityDetail; metrics?: ActivityMetrics; detailTruncated?: true };
