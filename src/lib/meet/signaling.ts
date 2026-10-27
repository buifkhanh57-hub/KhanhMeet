/**
 * ============================================================================
 *  KhanhMeet — TRỢ LÝ KẾT NỐI SIGNALING & REST
 * ----------------------------------------------------------------------------
 *  HAI CHẾ ĐỘ tự chọn theo biến môi trường lúc build:
 *
 *  (1) DỊCH VỤ SIGNALING RIÊNG — chế độ deploy thật (MIỄN PHÍ trên Render,
 *      xem render.yaml ở gốc repo):
 *        • Đặt NEXT_PUBLIC_SIGNALING_URL = "https://<tên-dịch-vụ>.onrender.com"
 *          → Socket.IO nối TRỰC TIẾP tới đó (path "/socket.io"), REST gọi
 *          `${URL}/api/...` (CORS đã mở "*" phía dịch vụ).
 *        • Build trên VERCEL mà CHƯA đặt biến → tự dùng mặc định
 *          https://khanhmeet-signaling.onrender.com (đúng tên dịch vụ trong
 *          render.yaml; đổi tên dịch vụ thì phải đặt biến này cho khớp).
 *
 *  (2) CHẾ ĐỘ LOCAL một máy (sandbox có Caddy gateway):
 *        • Mọi request dùng ĐƯỜNG DẪN TƯƠNG ĐỐI, cổng đích khai báo bằng
 *          query ?XTransformPort=<cổng> (bắt buộc). Socket.IO đi qua đường
 *          trung chuyển /api/km-sio của Next.js (qua gateway được nâng cấp
 *          WebSocket; truy cập thẳng :3000 thì ở lại polling — vẫn đủ chạy).
 * ============================================================================
 */

import { io, type Socket } from "socket.io-client";
import { REST_PORT, SIGNALING_PORT } from "./types";

/**
 * URL mặc định của dịch vụ signaling trên Render (gói FREE — render.yaml ở
 * gốc repo dựng sẵn với đúng tên này). Dùng khi build trên Vercel mà chưa
 * đặt NEXT_PUBLIC_SIGNALING_URL. Muốn đổi (đặt dịch vụ ở tên/máy khác) →
 * đặt NEXT_PUBLIC_SIGNALING_URL trong Settings của project trên Vercel.
 */
const DEFAULT_SIGNALING_URL = "https://khanhmeet-signaling.onrender.com";

/** URL dịch vụ signaling (rỗng = chạy local qua gateway). */
const SIGNALING_BASE = (
  process.env.NEXT_PUBLIC_SIGNALING_URL ||
  (process.env.NEXT_PUBLIC_VERCEL === "1" ? DEFAULT_SIGNALING_URL : "")
)
  .trim()
  .replace(/\/+$/, "");

/** Xây URL REST theo chế độ đang dùng (trực tiếp hoặc qua gateway). */
function restUrl(path: string): string {
  if (SIGNALING_BASE) return `${SIGNALING_BASE}${path}`;
  return `${path}?XTransformPort=${REST_PORT}`;
}

/** Tuỳ chọn socket chung cho mọi chế độ (tự nối lại vô hạn — lớp học dài giờ). */
const SOCKET_OPTIONS = {
  transports: ["polling", "websocket"] as string[],
  forceNew: true,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 800,
  reconnectionDelayMax: 5000,
  timeout: 10000,
};

/**
 * Tạo socket Socket.IO tới dịch vụ signaling:
 *  • Có URL dịch vụ riêng (deploy) → nối thẳng, path "/socket.io" chuẩn.
 *  • Local → path "/api/km-sio" + query XTransformPort=3003 qua gateway;
 *    engine.io bắt đầu bằng polling rồi tự nâng cấp lên WebSocket khi đường
 *    truyền cho phép (nâng cấp hỏng thì ở lại polling — vẫn chạy đủ chức năng).
 */
export function createSignalingSocket(): Socket {
  if (SIGNALING_BASE) {
    return io(SIGNALING_BASE, { ...SOCKET_OPTIONS, path: "/socket.io" });
  }
  return io({
    ...SOCKET_OPTIONS,
    path: "/api/km-sio",
    query: { XTransformPort: SIGNALING_PORT },
  });
}

/* ========================================================================== */
/* REST — mọi hàm TỰ THỬ LẠI 1 LẦN: máy chủ gói FREE (Render) "ngủ" sau 15   */
/* phút không ai dùng; request đầu tiên đánh thức nó (có thể chờ vài chục    */
/* giây), request ngay sau đó là nhanh.                                       */
/* ========================================================================== */

/** Đợi giữa hai lần thử. */
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Gọi GET /api/health — kiểm tra dịch vụ còn sống (thử tối đa 2 lần). */
export async function fetchHealth(): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(restUrl("/api/health"), {
        cache: "no-store",
      });
      const data = (await res.json()) as { ok?: boolean };
      if (data.ok === true) return true;
    } catch {
      // Mạng lỗi / máy chủ đang thức dậy — thử lại sau một nhịp.
    }
    if (attempt === 0) await wait(2500);
  }
  return false;
}

/** Gọi POST /api/rooms — tạo phòng học mới, nhận mã phòng + khoá chủ phòng. */
export async function apiCreateRoom(body: {
  title?: string;
}): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetch(restUrl("/api/rooms"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
    } catch (err) {
      lastError = err;
      await wait(3000);
    }
  }
  throw lastError;
}

/** Gọi GET /api/rooms/:id — tra cứu thông tin công khai của phòng. */
export async function apiGetRoom(roomId: string): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetch(restUrl(`/api/rooms/${encodeURIComponent(roomId)}`), {
        cache: "no-store",
      });
    } catch (err) {
      lastError = err;
      await wait(3000);
    }
  }
  throw lastError;
}

/* ========================================================================== */
/* ICE SERVERS (STUN/TURN) — LẤY TỪ MÁY CHỦ SIGNALING                          */
/*                                                                            */
/* Máy chủ trả danh sách phù hợp: nếu chủ web cấu hình Cloudflare TURN (bền,   */
/* có máy chủ tại Việt Nam) thì trả credential tạm thời của Cloudflare; nếu    */
/* chưa cấu hình thì trả danh sách mặc định (STUN Google + OpenRelay).         */
/* Lấy thất bại (mạng chập chờn / máy chủ đang thức dậy) → trả null, caller    */
/* dùng danh sách tĩnh trong types.ts — không bao giờ chặn việc vào lớp.       */
/* ========================================================================== */

/** Kết quả GET /api/turn. */
interface TurnResponse {
  ok?: boolean;
  iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
}

/** Gọi GET /api/turn — lấy danh sách STUN/TURN hiện hành (thử lại 1 lần). */
export async function fetchIceServers(): Promise<RTCIceServer[] | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(restUrl("/api/turn"), { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as TurnResponse;
        const servers = data.iceServers;
        if (Array.isArray(servers) && servers.length > 0) {
          return servers.map((s) => ({
            urls: Array.isArray(s.urls) ? s.urls : [s.urls],
            ...(s.username ? { username: s.username } : {}),
            ...(s.credential ? { credential: s.credential } : {}),
          })) as RTCIceServer[];
        }
      }
      return null; // Phản hồi không hợp lệ — dùng mặc định, khỏi thử lại.
    } catch {
      // Mạng lỗi / máy chủ đang thức dậy — thử lại sau một nhịp.
    }
    if (attempt === 0) await wait(2000);
  }
  return null;
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
  /* iOS: trình duyệt nhúng (WKWebView trần, không phải Safari/Chrome/Firefox)
   * KHÔNG có token "Safari/" trong UA — Safari thật thì LUÔN có. Lưu ý: KHÔNG
   * dùng pattern lookahead kiểu "(?!.*Safari)" — chúng khớp TỚI CẢ Safari
   * thật (lookahead đứng cuối chuỗi luôn thành công) → từng báo nhầm toàn bộ
   * người dùng iPhone/iPad là "trình duyệt nhúng". */
  const iosDevice = /iPhone|iPad|iPod/.test(ua);
  const iosWebView =
    iosDevice && /AppleWebKit/.test(ua) && !/Safari\//.test(ua);
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
