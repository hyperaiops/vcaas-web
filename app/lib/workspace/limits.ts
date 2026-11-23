import "server-only";
import { DEFAULT_LIMITS, type WorkspaceLimits } from "./types";

function positiveBytes(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const bytes = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`${name} must be a positive integer number of bytes`);
  }
  return bytes;
}

export function getWorkspaceLimits(): WorkspaceLimits {
  const maxFileBytes = positiveBytes("WORKSPACE_MAX_FILE_BYTES", DEFAULT_LIMITS.maxFileBytes);
  const maxTotalBytes = positiveBytes("WORKSPACE_MAX_TOTAL_BYTES", DEFAULT_LIMITS.maxTotalBytes);
  if (maxFileBytes > maxTotalBytes) {
    throw new Error("WORKSPACE_MAX_FILE_BYTES cannot exceed WORKSPACE_MAX_TOTAL_BYTES");
  }
  return { ...DEFAULT_LIMITS, maxFileBytes, maxTotalBytes };
}
