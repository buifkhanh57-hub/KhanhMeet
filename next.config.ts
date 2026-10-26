import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // engine.io (Socket.IO polling) gọi path "/api/km-sio/" CÓ dấu gạch chéo
  // cuối — tắt redirect 308 để gói tin đi thẳng tới route handler, không
  // mất thêm một vòng qua lại.
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
