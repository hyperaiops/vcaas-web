import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pages Router only — App Router (RSC) crashes in WebContainer with
  // "Invariant: Expected workStore to be initialized".
  output: "export",
  // WebContainer is WASM-only; Turbopack needs native bindings, so we must
  // NOT enable it here — plain webpack is used when no turbopack config exists.
};

export default nextConfig;
