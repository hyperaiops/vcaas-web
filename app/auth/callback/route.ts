import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import * as oidc from "openid-client";
import { authConfig, cookieOptions, SESSION_COOKIE, TRANSACTION_COOKIE } from "@/app/lib/auth/config";
import { oidcClient } from "@/app/lib/auth/oidc";
import { oidcDiagnostic, oidcFailureHint } from "@/app/lib/auth/diagnostics";
import { consumeLogin, createSession, revokeSession } from "@/app/lib/auth/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

class LoginCallbackError extends Error {
  constructor(readonly code: string) {
    super("Login callback rejected");
  }
}

// Do not log exception messages/causes: provider responses can contain tokens.
function errorCode(error: unknown): string {
  if (error instanceof LoginCallbackError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" &&
      /^(OAUTH|ERR|SQLITE)_[A-Z_]{1,80}$/.test(error.code)) return error.code;
  return "LOGIN_CALLBACK_FAILED";
}

export async function GET(request: Request) {
  const jar = await cookies();
  const transactionToken = jar.get(TRANSACTION_COOKIE)?.value;
  let response: NextResponse;
  let stage = "configuration";
  try {
    const config = authConfig();
    stage = "login-transaction";
    if (!transactionToken) throw new LoginCallbackError("LOGIN_COOKIE_MISSING");
    const transaction = consumeLogin(transactionToken);
    if (!transaction) throw new LoginCallbackError("LOGIN_TRANSACTION_EXPIRED");
    // Do not trust the reverse proxy's Host header to determine the redirect URI.
    const callback = new URL(config.callback);
    callback.search = new URL(request.url).search;
    stage = "provider-discovery";
    const client = await oidcClient();
    stage = "token-validation";
    const tokens = await oidc.authorizationCodeGrant(client, callback, {
      pkceCodeVerifier: transaction.verifier, expectedState: transaction.state,
      expectedNonce: transaction.nonce, idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims?.sub || !tokens.id_token || !claims.exp) throw new LoginCallbackError("IDENTITY_CLAIMS_MISSING");
    const name = typeof claims.name === "string" ? claims.name : typeof claims.preferred_username === "string" ? claims.preferred_username : "用户";
    stage = "session-creation";
    const session = createSession(claims.sub, name, tokens.id_token, claims.exp);
    const previous = jar.get(SESSION_COOKIE)?.value;
    if (previous) revokeSession(previous);
    response = NextResponse.redirect(new URL(transaction.returnTo, config.origin));
    response.cookies.set(SESSION_COOKIE, session.token, { ...cookieOptions, expires: new Date(session.expiresAt) });
  } catch (error) {
    const code = errorCode(error);
    const diagnostic = oidcDiagnostic(error);
    console.warn("[auth/callback] Sign-in rejected", { stage, code, ...diagnostic });
    const hint = oidcFailureHint(diagnostic) ?? (code === "LOGIN_COOKIE_MISSING"
      ? "未找到登录凭据。请从网站首页重新登录，并始终使用配置的认证域名，不要混用其他域名或 IP 地址。"
      : code === "LOGIN_TRANSACTION_EXPIRED"
        ? "本次登录已过期或回调链接已被使用，请从网站首页重新登录。"
        : "请重新登录。如仍然失败，请仅将下方错误编号提供给管理员，不要发送带授权码的完整地址。");
    const detail = diagnostic.reason === "UNCLASSIFIED" ? "" : `/${diagnostic.reason}`;
    response = new NextResponse(`登录失败或已过期。\n${hint}\n错误编号：${stage}/${code}${detail}\n重新登录：/auth/login`, {
      status: 400,
      headers: { "x-auth-error": code, "x-auth-reason": diagnostic.reason },
    });
  }
  response.cookies.set(TRANSACTION_COOKIE, "", { ...cookieOptions, maxAge: 0 });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
