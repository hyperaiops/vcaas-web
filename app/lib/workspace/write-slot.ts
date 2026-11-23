import "server-only";

// Serialize workspace file writes so concurrent uploads cannot both pass the
// workspace size check against the same old total. Agent processes are separate.
const writes = new Map<string, Promise<void>>();

export async function withWorkspaceWriteSlot<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = writes.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  writes.set(id, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (writes.get(id) === current) writes.delete(id);
  }
}
