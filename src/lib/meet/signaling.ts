/**
 * ============================================================================
 *  KhanhMeet — TRỢ LÝ KẾT NỐI SIGNALING & REST
 * ----------------------------------------------------------------------------
 *  HAI CHẾ ĐỘ TỰ ĐỘNG CHỌN theo biến môi trường NEXT_PUBLIC_SIGNALING_URL:
 *
 *  (1) CÓ đặt NEXT_PUBLIC_SIGNALING_URL (kiểu deploy Vercel + dịch vụ
 *      signaling riêng trên Railway/Render/Fly…):
 *        • Socket.IO kết nối TRỰC TIẾP tới URL đó (path "/", CORS đã mở).
 *        • REST call tới `${URL}/api/...` — không cần query XTransformPort.
 *
 *  (2) KHÔNG đặt (kiểu chạy local một máy với Caddy gateway):
 *        • Toàn bộ request dùng ĐƯỜNG DẪN TƯƠNG ĐỐI, cổng đích khai báo
 *          bằng query ?XTransformPort=<cổng> (bắt buộc).
 *        • Tuyệt đối không viết tuyệt đối kiểu http://localhost:<cổng>.
 * ============================================================================
 */

import { io, type Socket } from "socket.io-client";
import { REST_PORT, SIGNALING_PORT } from "./types";

/**
 * URL công khai của dịch vụ signaling khi deploy tách rời (Vercel + dịch vụ
 * riêng). Rỗng = chạy local qua gateway. Next.js tự nhúng biến NEXT_PUBLIC_*
 * vào bundle lúc BUILD — trên Vercel cấu hình trong Project Settings.
 */
const SIGNALING_BASE = (
  process.env.NEXT_PUBLIC_SIGNALING_URL || ""
)
  .trim()
  .replace(/\/+$/, "");

/** Xây URL REST theo chế độ đang dùng (trực tiếp hoặc qua gateway). */
function restUrl(path: string): string {
  if (SIGNALING_BASE) return `${SIGNALING_BASE}${path}`;
  return `${path}?XTransformPort=${REST_PORT}`;
}

/**
 * Tạo socket Socket.IO tới dịch vụ signaling (cổng 3003).
 * Cấu hình "/api/km-sio" hoạt động trên MỌI đường truy cập:
 *  • Qua gateway ( có query XTransformPort=3003 ): Caddy chuyển thẳng tới
 *    dịch vụ :3003 (engine.io path "/" chấp nhận mọi đường dẫn) → WebSocket.
 *  • Truy cập thẳng Next.js :3000 (gateway bị bỏ qua): route handler
 *    /api/km-sio của Next.js trung chuyển từng gói HTTP polling tới :3003.
 * Bắt đầu bằng polling rồi tự nâng cấp lên WebSocket khi đường truyền cho
 * phép (nâng cấp hỏng thì ở lại polling — vẫn chạy đủ chức năng).
 * Socket tự động kết nối lại vô hạn — nền tảng của tính năng 24/24.
 */
export function createSignalingSocket(): Socket {
  // Chế độ (1): deploy tách rời — kết nối thẳng dịch vụ signaling công khai
  // (path "/socket.io" chuẩn của chế độ một cổng — xem mini-services/signaling).
  if (SIGNALING_BASE) {
    return io(SIGNALING_BASE, {
      path: "/socket.io",
      transports: ["polling", "websocket"],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
  }
  // Chế độ (2): qua gateway Caddy / trung chuyển Next.js như mô tả ở đầu file.
  return io({
    path: "/api/km-sio",
    query: { XTransformPort: SIGNALING_PORT },
    transports: ["polling", "websocket"],
    forceNew: true,
    reconnection: true,
    reconnectionAttempts: Infinity, // Không bao giờ bỏ cuộc — thi kéo dài nhiều giờ
    reconnectionDelay: 800,
    reconnectionDelayMax: 5000,
    timeout: 10000,
  });
}

/** Gọi GET /api/health — kiểm tra dịch vụ còn sống. */
export async function fetchHealth(): Promise<boolean> {
  try {
    const res = await fetch(restUrl("/api/health"), {
      cache: "no-store",
    });
    const data = (await res.json()) as { ok?: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}

/** Gọi POST /api/rooms — tạo phòng học mới, nhận mã phòng. */
export async function apiCreateRoom(body: {
  title?: string;
}): Promise<Response> {
  return fetch(restUrl("/api/rooms"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
}

/** Gọi GET /api/rooms/:id — tra cứu thông tin công khai của phòng. */
export async function apiGetRoom(
  roomId: string
): Promise<Response> {
  return fetch(restUrl(`/api/rooms/${encodeURIComponent(roomId)}`), {
    cache: "no-store",
  });
}

/**
 * Sao chép văn bản vào clipboard với fallback cho trình duyệt cũ
 * (khu vực clipboard API bị chặn khi không phải HTTPS).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Rơi xuống phương pháp truyền thống bên dưới.
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Đọc origin công khai hiện tại (qua gateway) để dựng liên kết phòng
 * dạng https://<origin>/#/room/<id> — chia sẻ được cho thành viên.
 */
export function appOrigin(): string {
  return window.location.origin;
}

/* ========================================================================== */
/* NHẬN DIỆN TRÌNH DUYỆT NHÚNG (Zalo, Facebook, Messenger…)                    */
/* ========================================================================== */

/**
 * true = đang mở web bên trong trình duyệt nhúng của app khác (Zalo,
 * Facebook, Messenger, Instagram…). Các trình duyệt này THƯỜNG CHẶN
 * getUserMedia → không có camera/micro → phải mở bằng Chrome/Safari thật.
 */
export function isInAppBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // iOS: mọi trình duyệt nhúng đều dựa trên WKWebView và KHÔNG có chữ
  // "Safari" trong UA (Safari thật thì có).
  const iosWebView =
    /(iPhone|iPad|iPod).*AppleWebKit.*(?!.*Safari)/.test(ua) ||
    /(iPhone|iPad|iPod).*AppleWebKit.*Mobile(?!.*Safari)/.test(ua);
  return (
    iosWebView ||
    /Zalo|FBAN|FBAV|FB_IAB|Messenger|Instagram|Line\/|MicroMessenger|Snapchat|TikTok|WebView|wv\)/i.test(ua)
  );
}

/** Trình duyệt này có API camera/micro (getUserMedia) hay không. */
export function mediaApiAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

/* ========================================================================== */
/* KHOÁ CHỦ PHÒNG (hostKey) — lưu trên máy người tạo cuộc họp                  */
/* ========================================================================== */

/** Lưu khoá chủ phòng của một lớp vào localStorage (chỉ máy người tạo có). */
export function saveHostKey(roomId: string, hostKey: string): void {
  try {
    localStorage.setItem(`km-host:${roomId}`, hostKey);
  } catch {
    // localStorage có thể bị chặn (chế độ riêng tư) — bỏ qua.
  }
}

/** Đọc khoá chủ phòng đã lưu (null = máy này không phải của người tạo lớp). */
export function readHostKey(roomId: string): string | null {
  try {
    const key = localStorage.getItem(`km-host:${roomId}`);
    return key && key.length >= 8 ? key : null;
  } catch {
    return null;
  }
}
