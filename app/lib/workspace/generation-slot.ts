// Per-workspace snapshot generation guard. Mirrors the Go API's 1-slot
// channel: only one snapshot generation runs per workspace at a time; a
// concurrent request gets a 409 SNAPSHOT_GENERATION_IN_PROGRESS.
//
// In a serverless/edge world this wouldn't be safe, but these Route Handlers
// run on the Node runtime in a long-lived dev/server process, so a
// module-level Map is a sufficient mutex.

const slots = new Map<string, Promise<unknown>>();

export function isGenerating(workspaceId: string): boolean {
  return slots.has(workspaceId);
}

export async function withGenerationSlot<T>(
  workspaceId: string,
  work: () => Promise<T>,
): Promise<T> {
  if (slots.has(workspaceId)) {
    throw new GenerationInProgressError(workspaceId);
  }
  const promise = work().finally(() => slots.delete(workspaceId));
  slots.set(workspaceId, promise);
  return promise;
}

export class GenerationInProgressError extends Error {
  workspaceId: string;
  constructor(workspaceId: string) {
    super("当前正在生成另一个快照，请稍后重试。");
    this.name = "GenerationInProgressError";
    this.workspaceId = workspaceId;
  }
}
