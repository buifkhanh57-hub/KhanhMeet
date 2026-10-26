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
  env: {
    // VERCEL=1 được Vercel đặt sẵn lúc BUILD (biến hệ thống, không tự nhúng
    // vào client bundle). Chuyển sang tên NEXT_PUBLIC_ để phía client biết
    // đang chạy trên Vercel → mặc định nối dịch vụ signaling tại /signaling
    // (xem src/lib/meet/signaling.ts). Muốn dùng dịch vụ signaling riêng
    // (Railway/Render…) thì đặt NEXT_PUBLIC_SIGNALING_URL — biến đó được
    // ưu tiên trước mặc định này.
    NEXT_PUBLIC_VERCEL: process.env.VERCEL ? "1" : "",
  },
};

export default nextConfig;
