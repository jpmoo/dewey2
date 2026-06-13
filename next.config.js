/** @type {import('next').NextConfig} */
// Serve under a sub-path (e.g. /dewey) when NEXT_PUBLIC_BASE_PATH is set, so the
// app works behind a reverse proxy that forwards that prefix unchanged.
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
const nextConfig = {
  ...(basePath && { basePath, assetPrefix: basePath }),
  async headers() {
    return [
      {
        source: "/",
        headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }],
      },
      {
        // Baseline hardening on every response. (A full Content-Security-Policy
        // is a separate change.) nosniff stops MIME-sniffing of uploads; the
        // frame/referrer headers are safe, low-risk defaults.
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
