import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // "standalone" chỉ dành cho chạy production tại máy local (bun run start).
  // Trên Vercel (VERCEL=1 được đặt sẵn lúc build) KHÔNG bật — Vercel tự đóng
  // gói theo cách của nó. (Vercel chỉ chạy GIAO DIỆN Next.js; máy chủ
  // signaling chạy miễn phí trên Render — xem render.yaml ở gốc repo.)
  ...(process.env.VERCEL ? {} : { output: "standalone" as const }),
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
    // đang chạy trên Vercel → nối dịch vụ signaling mặc định trên Render
    // (xem src/lib/meet/signaling.ts). Muốn trỏ dịch vụ khác thì đặt
    // NEXT_PUBLIC_SIGNALING_URL — biến đó được ưu tiên trước.
    NEXT_PUBLIC_VERCEL: process.env.VERCEL ? "1" : "",
  },
};

export default nextConfig;
