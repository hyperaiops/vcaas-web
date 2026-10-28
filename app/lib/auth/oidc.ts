import "server-only";
import * as oidc from "openid-client";
import { authConfig } from "./config";

let configuration: Promise<oidc.Configuration> | undefined;
export function oidcClient() {
  if (!configuration) {
    const config = authConfig();
    configuration = oidc.discovery(new URL(config.issuer), config.clientId, {
      client_secret: config.secret,
      id_token_signed_response_alg: "RS256",
    }, oidc.ClientSecretPost(config.secret), {
      algorithm: "oidc",
      timeout: 15,
      execute: [oidc.enableNonRepudiationChecks],
    }).catch((error: unknown) => {
      configuration = undefined;
      throw error;
    });
  }
  return configuration;
}

export function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\r\n]/.test(value)) return "/";
  const url = new URL(value, "https://local.invalid");
  if (url.origin !== "https://local.invalid" || url.pathname.startsWith("/auth/")) return "/";
  return url.pathname + url.search;
}
