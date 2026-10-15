import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Load the Redis/BullMQ clients from node_modules at runtime instead of bundling them.
  serverExternalPackages: ["bullmq", "ioredis", "pg"],
};

export default nextConfig;
