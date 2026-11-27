import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import * as oidc from "openid-client";
import { authConfig, cookieOptions, TRANSACTION_COOKIE } from "@/app/lib/auth/config";
import { oidcClient, safeReturnTo } from "@/app/lib/auth/oidc";
import { consumeLogin, saveLogin } from "@/app/lib/auth/store";
import { formatApiMessage } from "@/app/lib/i18n/api-messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const config = authConfig();
    const client = await oidcClient();
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    // Prefer the user's browser language for the identity provider UI; fall back
    // to Simplified Chinese. Only allowlisted values are passed to the OIDC provider.
    const browserLocale = (request.headers.get("accept-language") ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
    const uiLocales = browserLocale.startsWith("en") ? "en" : "zh-CN";
    const url = oidc.buildAuthorizationUrl(client, {
      redirect_uri: config.callback, response_type: "code", scope: "openid profile email", ui_locales: uiLocales,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256", state, nonce,
    });
    const jar = await cookies();
    const previous = jar.get(TRANSACTION_COOKIE)?.value;
    if (previous) await consumeLogin(previous);
    const token = await saveLogin({ state, nonce, verifier, returnTo: safeReturnTo(new URL(request.url).searchParams.get("returnTo")) });
    const response = NextResponse.redirect(url);
    response.cookies.set(TRANSACTION_COOKIE, token, { ...cookieOptions, maxAge: 600 });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return new Response(formatApiMessage("auth.loginUnavailable"), {
      status: 503,
      headers: { "Cache-Control": "no-store", "x-auth-message-key": "auth.loginUnavailable" },
    });
  }
}
