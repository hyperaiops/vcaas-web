import "server-only";

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

export function oidcFailureHint(diagnostic: Diagnostic): string | undefined {
  if (diagnostic.reason === "JWT_ALGORITHM_MISMATCH") {
    return `Authing 身份令牌的签名算法与应用配置不一致。预期算法：${diagnostic.expectedAlgorithm ?? "已配置的算法"}；实际算法：${diagnostic.receivedAlgorithm ?? "不支持的算法"}。请将 Authing 应用的 ID Token 签名算法设为 RS256，保存后重新登录。系统未跳过签名校验。`;
  }
  if (diagnostic.reason.startsWith("STATE_")) return "登录状态不匹配。请关闭旧的登录标签页，在当前浏览器从网站首页重新发起一次登录。请勿重复使用或刷新旧的回调链接。";
  if (diagnostic.reason === "JWT_SIGNATURE_INVALID") return "身份令牌签名校验失败。请联系管理员检查应用的 issuer、JWKS 公钥端点及 Authing 签名密钥配置，不要关闭签名校验。";
  if (diagnostic.reason.startsWith("TOKEN_RESPONSE_")) return "Authing 返回的令牌响应缺少有效的必填字段。请联系管理员检查应用的 OIDC 授权码配置和令牌端点。";
  return undefined;
}
