import "server-only";
import { formatApiMessage, type ApiMessageArgs, type ApiMessageKey } from "@/app/lib/i18n/api-messages";

type Diagnostic = { reason: string; expectedAlgorithm?: string; receivedAlgorithm?: string };
const algorithms = new Set(["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "HS256", "HS384", "HS512", "EdDSA", "none"]);
const reasons: Record<string, string> = {
  'unexpected "state" response parameter value': "STATE_MISMATCH",
  'response parameter "state" missing': "STATE_MISSING",
  'unexpected "state" response parameter encountered': "STATE_UNEXPECTED",
  'unexpected ID Token "nonce" claim value': "NONCE_MISMATCH",
  'JWT signature verification failed': "JWT_SIGNATURE_INVALID",
  'JWT is not a valid compact JWS': "JWT_FORMAT_INVALID",
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

// Only emit our own enums and recognized algorithm names. Never serialize
// errors, causes, response bodies, JWT claims, URLs, or expected state/nonce.
export function oidcDiagnostic(error: unknown): Diagnostic {
  const visited = new Set<unknown>();
  let current = record(error);
  while (current && !visited.has(current)) {
    visited.add(current);
    const message = typeof current.message === "string" ? current.message : "";
    const cause = record(current.cause);
    if (message === 'unexpected JWT "alg" header parameter') {
      const received = record(cause?.header)?.alg;
      const expected = cause?.expected;
      return {
        reason: "JWT_ALGORITHM_MISMATCH",
        ...(typeof received === "string" && algorithms.has(received) ? { receivedAlgorithm: received } : {}),
        ...(typeof expected === "string" && algorithms.has(expected) ? { expectedAlgorithm: expected } : {}),
      };
    }
    if (Object.hasOwn(reasons, message)) return { reason: reasons[message] };
    for (const field of ["id_token", "access_token", "token_type"]) {
      if (message.startsWith(`"response" body "${field}" property`)) {
        return { reason: `TOKEN_RESPONSE_${field.toUpperCase()}_INVALID` };
      }
    }
    current = cause;
  }
  return { reason: "UNCLASSIFIED" };
}

// Localized failure hint: stable messageKey + safe args (only algorithm names
// from a fixed allowlist) alongside the pre-rendered zh-CN text.
export function oidcFailureHint(diagnostic: Diagnostic): { text: string; messageKey: ApiMessageKey; args?: ApiMessageArgs } | undefined {
  if (diagnostic.reason === "JWT_ALGORITHM_MISMATCH") {
    const args = {
      expectedAlgorithm: diagnostic.expectedAlgorithm ?? "已配置的算法",
      receivedAlgorithm: diagnostic.receivedAlgorithm ?? "不支持的算法",
    };
    return { text: formatApiMessage("auth.hintJwtAlgorithm", args), messageKey: "auth.hintJwtAlgorithm", args };
  }
  if (diagnostic.reason.startsWith("STATE_")) return { text: formatApiMessage("auth.hintStateMismatch"), messageKey: "auth.hintStateMismatch" };
  if (diagnostic.reason === "JWT_SIGNATURE_INVALID") return { text: formatApiMessage("auth.hintJwtSignature"), messageKey: "auth.hintJwtSignature" };
  if (diagnostic.reason.startsWith("TOKEN_RESPONSE_")) return { text: formatApiMessage("auth.hintTokenResponse"), messageKey: "auth.hintTokenResponse" };
  return undefined;
}
