const apiTarget = process.env.API_INTERNAL_URL || "http://localhost:8100";

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      { source: "/api/v1/:path*", destination: `${apiTarget}/api/v1/:path*` },
      { source: "/health", destination: `${apiTarget}/health` }
    ];
  }
};

export default nextConfig;
