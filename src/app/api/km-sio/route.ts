/**
 * ============================================================================
 *  KHANHMEET — TRUNG CHUYỂN SIGNALING (SOCKET.IO POLLING) TỪ NEXT.JS (LOCAL)
 * ----------------------------------------------------------------------------
 *  Chỉ dùng ở CHẾ ĐỘ LOCAL khi người dùng truy cập THẲNG vào Next.js :3000
 *  (bỏ qua gateway Caddy): WebSocket không thể nâng cấp qua route handler —
 *  nhưng transport POLLING của Socket.IO là HTTP thuần (GET giữ kết nối +
 *  POST gửi gói) nên trung chuyển từng gói được nguyên vẹn.
 *
 *  Truy cập QUA gateway thì request này không bao giờ tới đây (Caddy đã
 *  chuyển thẳng ?XTransformPort=3003 về dịch vụ). Trên deploy thật client
 *  nối THẲNG dịch vụ signaling trên Render (xem src/lib/meet/signaling.ts)
 *  — route này không được dùng.
 * ============================================================================
 */

import type { NextRequest } from "next/server";

async function proxyEngineIO(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  // engine.io của dịch vụ local chạy path "/" nên chấp nhận mọi đường dẫn
  // → giữ nguyên path + query (sid nằm trong query).
  const target = `http://localhost:3003${url.pathname}${url.search}`;
  const method = req.method.toUpperCase();

  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await req.text();
  }

  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body,
      cache: "no-store",
      redirect: "manual",
      // engine.io giữ GET long-poll tới ~25s — không được tự ngắt.
      signal: AbortSignal.timeout(35_000),
    });

    const outHeaders = new Headers();
    const upType = upstream.headers.get("content-type");
    if (upType) outHeaders.set("content-type", upType);
    outHeaders.set("cache-control", "no-store");

    return new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders,
    });
  } catch {
    // Dịch vụ signaling chưa lên / đang khởi động lại — báo lỗi engine.io
    // để client tự retry (socket.io client có reconnect vô hạn).
    return new Response("transport error", {
      status: 502,
      headers: { "content-type": "text/plain; charset=UTF-8" },
    });
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return proxyEngineIO(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return proxyEngineIO(req);
}

// Route long-poll — tuyệt đối không được cache.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
