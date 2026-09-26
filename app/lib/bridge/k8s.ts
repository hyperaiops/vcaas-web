// Kubernetes client for the PiWorker CRD (server-only).
//
// Each workspace maps 1:1 to a `PiWorker` (ubi.pi.dev/v1alpha1) custom resource,
// named after the workspace id. Entering a workspace creates/ensures the CR;
// the PiWorker operator reconciles it into a Deployment + Service + Ingress +
// auto-generated bearer-token Secret and writes the public `wss://.../v1/rpc`
// endpoint into `.status.endpoint`. Leaving deletes the CR; the operator's
// ownerRef + finalizer garbage-collects the child resources (including the
// LiteLLM key Secret, which the controller now owns and creates from
// `spec.litellm.apiKey`).
//
// The LiteLLM API key is passed inline in `spec.litellm.apiKey`. The controller
// projects it into the agent Pod via a controller-owned Secret that is deleted
// with the CR, so this client no longer creates or deletes that Secret.
//
// This runs inside the cluster: `KubeConfig.loadFromDefault()` resolves the
// in-cluster service-account token/CA when the standard env vars are set.

import "server-only";
import * as k8s from "@kubernetes/client-node";
import { getWorkspace } from "@/app/lib/db";
import { isValidWorkspaceId } from "@/app/lib/workspace/types";

const GROUP = "ubi.pi.dev";
const VERSION = "v1alpha1";
const PLURAL = "piworkers";

const NAMESPACE = process.env.PI_NAMESPACE ?? "default";
// The LiteLLM API key is read from the server env and passed inline in
// `spec.litellm.apiKey`. The operator projects it into the agent Pod via a
// controller-owned Secret that is garbage-collected with the CR, so this client
// no longer creates or manages that Secret.
const LITELLM_API_KEY = process.env.PI_LITELLM_API_KEY ?? "";
const LITELLM_BASE_URL = process.env.PI_LITELLM_BASE_URL ?? "";
const LITELLM_MODEL = process.env.PI_LITELLM_MODEL ?? "gpt-4.1";
const INGRESS_CLASS = process.env.PI_INGRESS_CLASS ?? "";
const INGRESS_TLS_SECRET = process.env.PI_INGRESS_TLS_SECRET ?? "";
const ALLOWED_ORIGIN = process.env.PI_BRIDGE_ALLOWED_ORIGIN ?? "";

const READY_POLL_INTERVAL_MS = 1000;
const READY_TIMEOUT_MS = 120_000; // ingress + pod spin-up can take a while.

export type AgentHandle = {
  endpoint: string; // wss://pw-<host>.<domain>/v1/rpc
  token: string; // bearer token for the bridge /v1/rpc
};

class K8sClientError extends Error {
  code: "BAD_CONFIG" | "UNKNOWN_WORKSPACE" | "RECONCILE_TIMEOUT" | "K8S";
  constructor(code: K8sClientError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "K8sClientError";
  }
}

export { K8sClientError };

// Lazy singleton: built once per server process. `loadFromDefault` reads disk.
let _customApi: k8s.CustomObjectsApi | null = null;
let _coreApi: k8s.CoreV1Api | null = null;

function apis(): { custom: k8s.CustomObjectsApi; core: k8s.CoreV1Api } {
  if (!_customApi || !_coreApi) {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault(); // in-cluster when mounted in a pod; kubeconfig in dev.
    _customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    _coreApi = kc.makeApiClient(k8s.CoreV1Api);
  }
  return { custom: _customApi!, core: _coreApi! };
}

type Condition = { type: string; status: string };
type PiWorkerStatus = {
  endpoint?: string;
  host?: string;
  bearerTokenSecretRef?: { name: string; key: string };
  conditions?: Condition[];
};
type PiWorker = {
  metadata?: { name?: string; namespace?: string };
  status?: PiWorkerStatus;
};

/** Ensure a Ready PiWorker exists for the workspace; return its endpoint + token. */
export async function ensurePiWorker(workspaceId: string): Promise<AgentHandle> {
  if (!isValidWorkspaceId(workspaceId)) {
    throw new K8sClientError("BAD_CONFIG", `Invalid workspace id: ${workspaceId}`);
  }
  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    throw new K8sClientError("UNKNOWN_WORKSPACE", `Unknown workspace: ${workspaceId}`);
  }
  if (!LITELLM_BASE_URL || !LITELLM_API_KEY) {
    throw new K8sClientError(
      "BAD_CONFIG",
      "PI_LITELLM_BASE_URL and PI_LITELLM_API_KEY are required to start an agent.",
    );
  }

  const { custom, core } = apis();

  // Create the CR if absent (AlreadyExists is fine — a remount raced). The
  // LiteLLM key is passed inline in spec.litellm.apiKey; the operator creates
  // and owns the projection Secret, so no separate Secret is needed here.
  let pw: PiWorker | null = await safeGet(custom, workspaceId);
  if (!pw) {
    await createPiWorker(custom, workspaceId);
  }

  // Poll until Ready and endpoint populated.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    pw = await safeGet(custom, workspaceId);
    if (pw && isReady(pw) && pw.status?.endpoint) break;
    if (Date.now() > deadline) {
      throw new K8sClientError(
        "RECONCILE_TIMEOUT",
        `PiWorker ${workspaceId} did not become Ready within ${READY_TIMEOUT_MS}ms`,
      );
    }
    await sleep(READY_POLL_INTERVAL_MS);
  }

  const ref = pw.status?.bearerTokenSecretRef;
  if (!ref?.name) {
    throw new K8sClientError("RECONCILE_TIMEOUT", `PiWorker ${workspaceId} has no bearerTokenSecretRef yet`);
  }
  const token = await readSecret(core, ref.name, ref.key || "token");
  return { endpoint: pw.status!.endpoint!, token };
}

/** Delete the workspace's PiWorker (idempotent). The operator garbage-collects
 * the child resources, including the controller-owned LiteLLM key Secret. */
export async function deletePiWorker(workspaceId: string): Promise<void> {
  if (!isValidWorkspaceId(workspaceId)) return;
  const { custom } = apis();
  try {
    await custom.deleteNamespacedCustomObject(GROUP, VERSION, NAMESPACE, PLURAL, workspaceId);
  } catch (err) {
    if (!isNotFound(err)) throw err; // already gone is fine
  }
}

async function createPiWorker(custom: k8s.CustomObjectsApi, workspaceId: string): Promise<void> {
  const spec: Record<string, unknown> = {
    model: LITELLM_MODEL,
    litellm: {
      baseURL: LITELLM_BASE_URL,
      apiKey: LITELLM_API_KEY,
    },
    auth: { allowedOrigins: ALLOWED_ORIGIN ? [ALLOWED_ORIGIN] : [] },
  };
  const ingress: Record<string, unknown> = {};
  if (INGRESS_CLASS) ingress.className = INGRESS_CLASS;
  if (INGRESS_TLS_SECRET) ingress.tlsSecretName = INGRESS_TLS_SECRET;
  if (Object.keys(ingress).length) spec.ingress = ingress;

  const body = {
    apiVersion: `${GROUP}/${VERSION}`,
    kind: "PiWorker",
    metadata: {
      name: workspaceId,
      namespace: NAMESPACE,
      labels: { "app.kubernetes.io/managed-by": "webcontainer" },
    },
    spec,
  };
  try {
    await custom.createNamespacedCustomObject(GROUP, VERSION, NAMESPACE, PLURAL, body);
  } catch (err) {
    // Race: another request created it first. Treat as success.
    if (!isAlreadyExists(err)) throw err;
  }
}

async function safeGet(custom: k8s.CustomObjectsApi, workspaceId: string): Promise<PiWorker | null> {
  try {
    const res = await custom.getNamespacedCustomObject(GROUP, VERSION, NAMESPACE, PLURAL, workspaceId);
    return res.body as PiWorker;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

function isReady(pw: PiWorker): boolean {
  const conds = pw.status?.conditions ?? [];
  return conds.some((c) => c.type === "Ready" && c.status === "True");
}

async function readSecret(core: k8s.CoreV1Api, name: string, key: string): Promise<string> {
  const res = await core.readNamespacedSecret(name, NAMESPACE);
  const data = (res.body as { data?: Record<string, string> }).data ?? {};
  const b64 = data[key];
  if (!b64) throw new K8sClientError("K8S", `Secret ${name} has no key ${key}`);
  return Buffer.from(b64, "base64").toString("utf8").trim();
}

// --- error helpers ---

function isNotFound(err: unknown): boolean {
  return hasCode(err, 404);
}
function isAlreadyExists(err: unknown): boolean {
  return hasCode(err, 409);
}
// The k8s client throws HttpError with a numeric `.response.statusCode`, or an
// object with `.code` for some paths. Normalize both.
function hasCode(err: unknown, status: number): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { statusCode?: number; response?: { statusCode?: number }; code?: number };
  return e.statusCode === status || e.response?.statusCode === status || e.code === status;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
