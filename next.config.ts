import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The /press rebuild route renders a PDF through the Vivliostyle CLI, which
  // spawns Chromium and reads its own package files off disk. Bundling it
  // breaks both, so it is required at runtime instead.
  serverExternalPackages: ["@vivliostyle/cli", "playwright-core"],
};

export default nextConfig;
