import "server-only";

function isLocalHttpDebug(origin: URL): boolean {
  const enabled = process.env.NODE_ENV !== "production" || process.env.AUTH_ALLOW_HTTP_LOCALHOST === "true";
  return enabled && origin.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
}

export function authConfig() {
  const origin = new URL(process.env.AUTH_ORIGIN ?? "https://console.vibe-coding.host");
  const issuer = new URL(process.env.AUTH_ISSUER ?? "https://vibe-coding-host.authing.cn/oidc");
  if ((origin.protocol !== "https:" && !isLocalHttpDebug(origin)) || issuer.protocol !== "https:") {
    throw new Error("认证需要 HTTPS；仅在开发模式或显式开启 AUTH_ALLOW_HTTP_LOCALHOST 时允许 localhost HTTP 调试。");
  }
  const secret = process.env.AUTH_CLIENT_SECRET;
  const encryptionKey = process.env.AUTH_SESSION_KEY;
  if (!secret || !encryptionKey || !/^[a-f0-9]{64}$/i.test(encryptionKey)) {
    throw new Error("AUTH_CLIENT_SECRET and a 32-byte hex AUTH_SESSION_KEY are required.");
  }
  return {
    origin: origin.origin,
    issuer: issuer.href,
    clientId: process.env.AUTH_CLIENT_ID ?? "6aae0a13969a9131274d7e08",
    secret,
    encryptionKey: Buffer.from(encryptionKey, "hex"),
    callback: new URL("/auth/callback", origin).href,
  };
}

const localHttp = isLocalHttpDebug(new URL(process.env.AUTH_ORIGIN ?? "https://console.vibe-coding.host"));
// __Host- cookies require Secure; use separate names for explicitly allowed local HTTP debugging.
export const SESSION_COOKIE = localHttp ? "pi-session-dev" : "__Host-pi-session";
export const TRANSACTION_COOKIE = localHttp ? "pi-login-dev" : "__Host-pi-login";
export const cookieOptions = { httpOnly: true, secure: !localHttp, sameSite: "lax" as const, path: "/" };
