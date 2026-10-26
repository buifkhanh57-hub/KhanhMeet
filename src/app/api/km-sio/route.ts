/**
 * ============================================================================
 *  KHANHMEET — TRUNG CHUYỂN SIGNALING (SOCKET.IO POLLING) TỪ NEXT.JS
 * ----------------------------------------------------------------------------
 *  Khi người dùng truy cập THẲNG vào Next.js :3000 (bỏ qua gateway Caddy),
 *  WebSocket không thể nâng cấp qua route handler — nhưng transport POLLING
 *  của Socket.IO là HTTP thuần (GET giữ kết nối + POST gửi gói) nên trung
 *  chuyển từng gói được nguyên vẹn.
 *
 *  Truy cập QUA gateway thì request này không bao giờ tới đây (Caddy đã
 *  chuyển thẳng ?XTransformPort=3003 về dịch vụ). Route này là "đường cứu
 *  sinh" cho đường truy cập thẳng — nhờ vậy chat/duyệt/webrtc chạy trên MỌI
 *  đường vào của ứng dụng.
 *
 *  TRÊN VERCEL (services): biến SIGNALING_INTERNAL_URL do binding trong
 *  vercel.json tiêm vào — dịch vụ signaling chạy chế độ MỘT CỔNG với
 *  engine.io tại /socket.io nên ánh xạ path sang đó.
 * ============================================================================
 */

import type { NextRequest } from "next/server";

/**
 * Binding nội bộ tới dịch vụ signaling (chỉ tồn tại khi chạy trên Vercel —
 * vercel.json khai báo bindings cho service "app"). Rỗng = chạy local.
 */
const INTERNAL_URL = (process.env.SIGNALING_INTERNAL_URL || "").replace(
  /\/+$/,
  ""
);

async function proxyEngineIO(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  // Local: engine.io của dịch vụ chạy path "/" nên chấp nhận mọi đường dẫn
  //   → giữ nguyên path + query (sid nằm trong query).
  // Vercel: engine.io tại "/socket.io" (chế độ một cổng) → ánh xạ sang đó.
  const target = INTERNAL_URL
    ? `${INTERNAL_URL}/socket.io/${url.search}`
    : `http://localhost:3003${url.pathname}${url.search}`;
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
