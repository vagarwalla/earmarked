import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The /press rebuild route renders a PDF through the Vivliostyle CLI, which
  // spawns Chromium and reads its own package files off disk. Bundling it
  // breaks both, so it is required at runtime instead.
  serverExternalPackages: ["@vivliostyle/cli", "playwright-core"],

  // ...but "not bundled" still means "traced into the function", and these
  // three come to ~93MB (Chromium alone is 64MB), which puts the press routes
  // over Vercel's function size limit and fails the deploy at the upload step
  // with no error in the build log.
  //
  // Nothing deployed can use them regardless: rendering an issue is minutes of
  // headless Chromium, which is why worker/ exists. The rebuild route refuses
  // with 501 when it is running against Supabase, and these stay on the
  // machines that actually have a browser.
  outputFileTracingExcludes: {
    "/api/press/**": [
      "node_modules/@sparticuz/chromium/**",
      "node_modules/playwright-core/**",
      "node_modules/@vivliostyle/**",
    ],
  },
};

export default nextConfig;
