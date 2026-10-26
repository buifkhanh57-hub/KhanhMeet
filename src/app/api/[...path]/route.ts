/**
 * ============================================================================
 *  KHANHMEET — TRUNG CHUYỂN REST API TỪ NEXT.JS TỚI DỊCH VỤ SIGNALING
 * ----------------------------------------------------------------------------
 *  Mọi REST call của ứng dụng (/api/health, /api/rooms, /api/rooms/:id…)
 *  đều chạy được trên CẢ BA đường truy cập:
 *    • QUA GATEWAY (query XTransformPort=3004): Caddy chuyển thẳng tới dịch
 *      vụ — request không bao giờ chạm tới route này.
 *    • TRUY CẬP THẲNG :3000 (gateway bị bỏ qua): route này nhận và trung
 *      chuyển nguyên vẹn method + query + body về localhost:3004.
 *    • TRÊN VERCEL (services): binding SIGNALING_INTERNAL_URL (vercel.json)
 *      tiêm URL nội bộ của dịch vụ signaling — trung chuyển qua đó.
 *
 *  Route "km-sio" (trung chuyển Socket.IO) cụ thể hơn nên được khớp trước
 *  catch-all này.
 * ============================================================================
 */

import type { NextRequest } from "next/server";

/**
 * Binding nội bộ tới dịch vụ signaling (chỉ tồn tại khi chạy trên Vercel —
 * vercel.json khai báo bindings cho service "app"). Rỗng = chạy local
 * hai cổng 3003/3004 qua gateway/trung chuyển.
 */
const INTERNAL_URL = (process.env.SIGNALING_INTERNAL_URL || "").replace(
  /\/+$/,
  ""
);

const UPSTREAM = INTERNAL_URL || "http://localhost:3004";

async function proxyRest(
  req: NextRequest,
  path: string[]
): Promise<Response> {
  const url = new URL(req.url);
  const safePath = path.map((seg) => encodeURIComponent(seg)).join("/");
  const target = `${UPSTREAM}/api/${safePath}${url.search}`;
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
      signal: AbortSignal.timeout(15_000),
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
    return new Response(
      JSON.stringify({ ok: false, error: "signaling-unreachable" }),
      {
        status: 502,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }
    );
  }
}

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

export async function GET(
  req: NextRequest,
  ctx: RouteContext
): Promise<Response> {
  const { path } = await ctx.params;
  return proxyRest(req, path);
}

export async function POST(
  req: NextRequest,
  ctx: RouteContext
): Promise<Response> {
  const { path } = await ctx.params;
  return proxyRest(req, path);
}

export async function PUT(
  req: NextRequest,
  ctx: RouteContext
): Promise<Response> {
  const { path } = await ctx.params;
  return proxyRest(req, path);
}

export async function DELETE(
  req: NextRequest,
  ctx: RouteContext
): Promise<Response> {
  const { path } = await ctx.params;
  return proxyRest(req, path);
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
