// Runtime mode selection: exactly two modes, explicitly configured.
// local: spawn the local `pi` binary against the workspace on the local disk
//        (development only — never allowed when NODE_ENV is production).
// prod:  connect to the workspace's PiWorker over the in-cluster Service.
import "server-only";

export class BridgeLifecycleError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export type AgentRuntimeMode = "local" | "prod";

export function runtimeMode(): AgentRuntimeMode {
  const raw = process.env.PI_RUNTIME_MODE;
  if (raw !== "local" && raw !== "prod") {
    throw new BridgeLifecycleError(
      500,
      "BAD_CONFIG",
      "PI_RUNTIME_MODE must be explicitly set to local or prod.",
    );
  }
  if (raw === "local" && process.env.NODE_ENV === "production") {
    throw new BridgeLifecycleError(
      500,
      "BAD_CONFIG",
      "PI_RUNTIME_MODE=local runs a coding CLI on the server and is forbidden in production.",
    );
  }
  return raw;
}
