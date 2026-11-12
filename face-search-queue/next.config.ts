import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel Services mounts the queue app at this path so its /api routes do
  // not collide with the Express backend's /api routes. Standalone local
  // development continues to use the root path.
  basePath: process.env.VERCEL ? "/face-search-api" : "",
  async headers() {
    return [
      {
        // Apply CORS headers to all API routes
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" }, // Or your frontend origin
          { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS, DELETE" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization" },
        ],
      },
    ];
  }
};

export default nextConfig;
