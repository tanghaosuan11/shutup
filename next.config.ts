import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // bb.js relies on SharedArrayBuffer — these headers are required in all browsers
  async headers() {
    return [
      // Share card + html-to-image: avoid COEP on this subtree (main app needs require-corp for WASM).
      {
        source: "/share/:path*",
        headers: [{ key: "Cross-Origin-Opener-Policy", value: "same-origin" }],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },

  // webpack config: enable async WASM (required by @aztec/bb.js and @noir-lang/noir_js)
  // Run `next dev --webpack` / `next build --webpack` to use this (Turbopack cannot handle WASM).
  webpack(config) {
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    // Note: CSS extraction is handled automatically by Next.js 13+
    // Do not add MiniCssExtractPlugin as it conflicts with Next.js's built-in CSS handling
    return config;
  },
};

export default nextConfig;
