import assert from "node:assert/strict";
import { test } from "node:test";
import { oidcDiagnostic, oidcFailureHint } from "../app/lib/auth/diagnostics";

test("identifies an algorithm mismatch without exposing JWT headers or payloads", () => {
  const error = new Error("invalid response encountered", {
    cause: new Error('unexpected JWT "alg" header parameter', {
      cause: { header: { alg: "HS256", kid: "private-key-id" }, expected: "RS256", id_token: "secret-token" },
    }),
  });
  const diagnostic = oidcDiagnostic(error);
  assert.deepEqual(diagnostic, { reason: "JWT_ALGORITHM_MISMATCH", receivedAlgorithm: "HS256", expectedAlgorithm: "RS256" });
  const result = JSON.stringify(diagnostic);
  assert.ok(!result.includes("secret-token"));
  assert.ok(!result.includes("private-key-id"));
  assert.match(oidcFailureHint(diagnostic)!, /请将 Authing.*RS256/);
});

test("distinguishes state mismatch from signature failure without printing state", () => {
  const state = new Error("invalid response encountered", {
    cause: new Error('unexpected "state" response parameter value', { cause: { expected: "secret-state" } }),
  });
  assert.deepEqual(oidcDiagnostic(state), { reason: "STATE_MISMATCH" });
  assert.deepEqual(oidcDiagnostic(new Error("JWT signature verification failed")), { reason: "JWT_SIGNATURE_INVALID" });
  assert.ok(!oidcFailureHint(oidcDiagnostic(state))!.includes("secret-state"));
});

test("invalid token response diagnostics do not expose the response body", () => {
  const error = new Error('"response" body "id_token" property must be a non-empty string', {
    cause: { body: { access_token: "secret-access-token" } },
  });
  assert.deepEqual(oidcDiagnostic(error), { reason: "TOKEN_RESPONSE_ID_TOKEN_INVALID" });
  assert.deepEqual(oidcDiagnostic(new Error("an arbitrary error with secret-token")), { reason: "UNCLASSIFIED" });
});

test("unrecognized algorithms and cyclic causes cannot leak arbitrary data", () => {
  const error = new Error('unexpected JWT "alg" header parameter', {
    cause: { header: { alg: "SECRET-VALUE" }, expected: "ANOTHER-SECRET" },
  });
  assert.deepEqual(oidcDiagnostic(error), { reason: "JWT_ALGORITHM_MISMATCH" });
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  assert.deepEqual(oidcDiagnostic(cycle), { reason: "UNCLASSIFIED" });
});
