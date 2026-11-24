import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Runtime databases and user workspaces must never be bundled into the image.
  outputFileTracingExcludes: { "/*": ["./.data/**/*"] },
  allowedDevOrigins: ["vibe-coding.host"],
  // WebContainer requires cross-origin isolation (SharedArrayBuffer).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
      {
        source: "/preview-console.js",
        headers: [{ key: "Cross-Origin-Resource-Policy", value: "cross-origin" }],
      },
    ];
  },
};

export default nextConfig;
