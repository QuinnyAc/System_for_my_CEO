const apiTarget = process.env.API_INTERNAL_URL || "http://localhost:8100";
const collectorTarget = process.env.COLLECTOR_INTERNAL_URL || "http://localhost:8200";

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      { source: "/api/v1/:path*", destination: `${apiTarget}/api/v1/:path*` },
      { source: "/health", destination: `${apiTarget}/health` },
      { source: "/collector/:path*", destination: `${collectorTarget}/:path*` }
    ];
  }
};

export default nextConfig;
