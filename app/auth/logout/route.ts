import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import * as oidc from "openid-client";
import { checkOrigin } from "@/app/lib/auth/access";
import { authConfig, cookieOptions, SESSION_COOKIE, TRANSACTION_COOKIE } from "@/app/lib/auth/config";
import { oidcClient } from "@/app/lib/auth/oidc";
import { consumeLogin, revokeSession } from "@/app/lib/auth/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = checkOrigin(request);
  if (rejected) return rejected;
  const config = authConfig();
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const idToken = token ? revokeSession(token) : null;
  const transaction = jar.get(TRANSACTION_COOKIE)?.value;
  if (transaction) consumeLogin(transaction);
  let target = new URL("/", config.origin);
  if (idToken) {
    try {
      target = oidc.buildEndSessionUrl(await oidcClient(), {
        id_token_hint: idToken, post_logout_redirect_uri: target.href,
      });
    } catch { /* Local logout must still work when the provider is unavailable. */ }
  }
  const response = NextResponse.redirect(target, 303);
  response.cookies.set(SESSION_COOKIE, "", { ...cookieOptions, maxAge: 0 });
  response.cookies.set(TRANSACTION_COOKIE, "", { ...cookieOptions, maxAge: 0 });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
