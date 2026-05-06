import type { NextConfig } from "next";
import MiniCssExtractPlugin from "mini-css-extract-plugin";

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
    // Required when any rule uses `MiniCssExtractPlugin.loader` (see mini-css-extract-plugin getting started).
    const hasMiniCss = config.plugins?.some(
      (p: unknown) => p instanceof MiniCssExtractPlugin
    );
    if (!hasMiniCss) {
      config.plugins = config.plugins ?? [];
      config.plugins.push(new MiniCssExtractPlugin());
    }
    return config;
  },
};

export default nextConfig;
