import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // Native and browser-automation packages must stay outside the server bundle.
  serverExternalPackages: ["better-sqlite3", "playwright", "playwright-core"],
  poweredByHeader: false,
  // The floating dev badge sits over the sidebar footer; build errors still show as an overlay.
  devIndicators: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
