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
    ];
  },
};

module.exports = nextConfig;
