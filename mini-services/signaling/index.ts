/**
 * ============================================================================
 *  LỚP HỌC TRỰC TUYẾN — DỊCH VỤ SIGNALING LỚP HỌC TRỰC TUYẾN (chạy 24/24)
 * ============================================================================
 *  Kiến trúc "một tiến trình, hai cổng":
 *    • Cổng 3003 — Socket.IO (path "/") : signaling WebRTC, quản lý lớp học,
 *                  chat, heartbeat/đo độ trễ, nhật ký hoạt động realtime.
 *    • Cổng 3004 — Express REST        : tạo phòng, tra cứu thông tin phòng,
 *                  health-check.
 *
 *  BA VAI TRÒ:
 *    - "member" — thành viên (học sinh): vào lớp bằng liên kết. Khi trong lớp
 *      CÓ người duyệt (chủ phòng/chủ web) đang trực tuyến thì phải được DUYỆT
 *      mới vào; không ai duyệt online thì vào thẳng (chủ phòng vào sau vẫn
 *      toàn quyền kick/tắt mic/tắt cam).
 *    - "host"   — CHỦ PHÒNG (người tạo cuộc họp): giữ KHOÁ CHỦ PHÒNG (hostKey
 *      trả về khi tạo phòng, chỉ nằm trên máy người tạo). Quyền: mời liên
 *      kết, DUYỆT/TỪ CHỐI người vào lớp, ĐUỔI (kick), TẮT MIC / TẮT CAMERA
 *      thành viên từ xa, YÊU CẦU BẬT CAMERA (minh bạch) — đúng "người tạo
 *      cuộc họp chỉ có chức năng thế".
 *    - "admin"  — CHỦ WEB (người sáng tạo trang web): mở bảng điều khiển
 *      bằng MÃ CHỦ WEB (ô nhỏ góc trái dưới trang chủ) — quyền tối cao,
 *      xem mọi phòng, cảnh báo, tan lớp, ghi chú.
 *
 *  Mô hình hoạt động (minh bạch — mọi người đều thấy nhau trong lớp):
 *    - Mỗi thành viên có MỘT luồng media thật duy nhất; tắt cam/mic là TẮT
 *      THẬT (track.enabled = false) — không có luồng ngầm nào phía sau.
 *    - Khi chủ web chọn một phòng để xem, hệ thống phục vụ như một thành viên
 *      recvonly và xuất hiện công khai trong danh sách — không ẩn mình.
 *
 *  Bảo mật: bảng điều khiển mở bằng MÃ CHỦ WEB — mã bí mật ngẫu nhiên
 *  (đổi/thêm bằng biến môi trường OWNER_CODES, phân cách phẩy).
 * ============================================================================
 */

import { createServer } from "http";
import express, { type Request, type Response } from "express";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { randomUUID, randomBytes } from "crypto";
import { PrismaClient } from "@prisma/client";

/* ========================================================================== */
/* 1. CẤU HÌNH CỔNG & HẰNG SỐ                                                 */
/* ========================================================================== */

/** Cổng Socket.IO — bắt buộc path "/" để Caddy gateway chuyển tiếp đúng. */
const SIGNALING_PORT = 3003;
/** Cổng Express REST (tách riêng để path "/" của Socket.IO không "nuốt" request). */
const REST_PORT = 3004;

const MAX_SESSIONS_PER_ROOM = 64; // Số người tối đa trong 1 phòng
const MAX_CHAT_HISTORY = 200; // Giữ tối đa 200 tin nhắn gần nhất trong bộ nhớ
const MAX_CHAT_LENGTH = 1000; // Độ dài tối đa 1 tin nhắn chat
const MAX_NOTE_LENGTH = 1000; // Độ dài tối đa 1 ghi chú
const MAX_WARNING_LENGTH = 500; // Độ dài tối đa 1 cảnh báo
const ROOM_IDLE_MS = 30 * 60 * 1000; // Phòng trống >30 phút sẽ bị dọn khỏi RAM
/**
 * Session mất mạng QUÁ LÂU (không heartbeat, không quay lại) bị coi là đã
 * rời hẳn — dọn khỏi danh sách để không còn "hồn ma" treo lơ lửng hiển thị
 * "Đang kết nối lại…" mãi mãi trong lớp.
 */
const STALE_OFFLINE_MS = 5 * 60 * 1000;
/**
 * CUỘC HỌP TỰ NGHỈ: phòng ĐÃ TỪNG có thành viên mà KHÔNG còn ai
 * trực tuyến trong 60 giây sẽ được DỌN KHỎI BỘ NHỚ (biến mất khỏi danh
 * sách console) — nhưng LIÊN KẾT VẪN SỐNG: ai mở lại liên kết sẽ hồi
 * sinh phòng (chỉ hành động TAN LỚP của chủ web mới đóng vĩnh viễn).
 * 60 giây là thời gian trù bị để người refresh trang (F5) hoặc rớt mạng
 * kết nối lại kịp mà không bị dọn phòng giữa chừng.
 */
const AUTO_CLOSE_EMPTY_MS = 60 * 1000;

/**
 * DANH SÁCH MÃ CHỦ WEB — nhập đúng MỘT trong các mã này là mở được bảng
 * điều khiển (không phân biệt hoa/thường, bỏ khoảng trắng thừa).
 * MÃ BÍ MẬT NGẪU NHIÊN — tuyệt đối KHÔNG dùng tên riêng hay ngày sinh
 * (mã cũ BAOKHANH/KHANHYEUDAN đã bị lộ vì ai cũng biết tên chủ web).
 *
 * NGUỒN MÃ (theo thứ tự ưu tiên):
 *   1. Biến môi trường OWNER_CODES (phân cách phẩy) — bắt buộc khi deploy!
 *   2. Nếu KHÔNG đặt: sinh MỘT mã ngẫu nhiên lúc khởi động và in ra console
 *      — mã đổi mỗi lần restart nên không ai (kể cả người đọc mã nguồn
 *      công khai) dùng được lối này trên máy chủ thật.
 * Mã mặc định cũ đã bị XOÁ khỏi mã nguồn để mở public repo an toàn.
 */
function loadOwnerCodes(): string[] {
  const fromEnv = (process.env.OWNER_CODES || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
  if (fromEnv.length > 0) return fromEnv;
  // Chưa cấu hình → mã ngẫu nhiên một lần chạy (in ra console phía dưới).
  return [`KM-${randomBytes(4).toString("hex").toUpperCase()}`];
}
const OWNER_CODES: string[] = loadOwnerCodes();

/** So khớp mã chủ web do client gửi lên (đã chuẩn hoá hoa/thường + trim). */
function isOwnerCode(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const key = raw.trim().toUpperCase();
  return key.length > 0 && OWNER_CODES.includes(key);
}

/** Tên phòng con (socket.io room) phát sự kiện tới các quản trị viên. */
function adminsChannel(roomId: string): string {
  return `${roomId}::admins`;
}
/** Phòng con chứa mọi socket chủ web đã xác thực (dùng cho danh sách phòng). */
const OWNERS_ROOM = "::owners";

/* ========================================================================== */
/* 2. PRISMA (SQLite) — singleton an toàn với `bun --hot`                     */
/* ========================================================================== */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ log: ["error", "warn"] });
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/* ========================================================================== */
/* 3. KIỂU DỮ LIỆU DÙNG CHUNG (đồng bộ với src/lib/meet/types.ts phía client)  */
/* ========================================================================== */

type Role = "member" | "admin" | "host";
type Severity = "info" | "warning" | "critical";
type SignalMedia = "cam" | "screen";
type SignalKind = "offer" | "answer" | "ice" | "bye";

/**
 * KHOÁ ĐIỀU KHIỂN THIẾT BỊ (cam/mic) của một thành viên do CHỦ PHÒNG/CHỦ WEB
 * nắm giữ — theo yêu cầu CEO: "BẬT là BẬT LUÔN, CẤM là CẤM LUÔN":
 *   • "none" : Tự do — thành viên tự bật/tắt thiết bị của mình.
 *   • "on"   : BẬT LUÔN — thiết bị bị bật NGAY bởi người điều hành và thành
 *              viên KHÔNG thể tự tắt (bật là bật luôn, không cần xin phép).
 *   • "off"  : CẤM — thiết bị bị tắt NGAY và thành viên KHÔNG thể tự bật
 *              lại (cấm là cấm luôn; mọi cố gắng lách đều bị ghi nhật ký).
 * Máy chủ là TRỌNG TÀI: state:update vi phạm khoá → TỪ CHỐI + ghi sự kiện.
 */
type DeviceLock = "none" | "on" | "off";

interface PublicSession {
  id: string;
  name: string;
  role: Role;
  joinTime: number; // Unix ms — thời điểm tham gia (cập nhật khi kết nối lại)
  camOn: boolean;
  micOn: boolean;
  /** Khoá điều khiển camera hiện hành (none/on/off — xem DeviceLock). */
  camLock: DeviceLock;
  /** Khoá điều khiển micro hiện hành (none/on/off — xem DeviceLock). */
  micLock: DeviceLock;
  handRaised: boolean;
  screenSharing: boolean;
  online: boolean;
  rtt: number | null; // Độ trễ mạng gần nhất (ms) do client tự đo
}

interface ChatMessage {
  id: string;
  sessionId: string;
  name: string;
  text: string;
  ts: number;
}

interface RoomSnapshot {
  roomId: string;
  title: string;
  sessions: PublicSession[];
}

/** Tóm tắt một phòng — phát tới bảng điều khiển chủ web ("rooms:update"). */
interface RoomSummary {
  id: string;
  title: string;
  memberCount: number; // Tổng số phiên (kể cả rớt mạng)
  onlineCount: number; // Số phiên đang trực tuyến
  lastActivity: number; // Unix ms
}

interface EventPayload {
  id: number;
  roomId: string;
  sessionId: string | null;
  sessionName: string | null;
  type: string;
  detail: string | null;
  severity: Severity;
  ts: number;
}

interface NotePayload {
  id: number;
  roomId: string;
  targetSessionId: string;
  targetName: string;
  authorName: string;
  content: string;
  ts: number;
}

/** Mức độ nghiêm trọng mặc định theo loại sự kiện (máy chủ là trọng tài). */
const EVENT_SEVERITY: Record<string, Severity> = {
  join: "info",
  rejoin: "info",
  leave: "info",
  disconnected: "warning",
  kicked: "critical",
  "cam-on": "info",
  "cam-off": "info",
  "mic-on": "info",
  "mic-off": "info",
  "screen-share-start": "info",
  "screen-share-stop": "info",
  "hand-raised": "info",
  "hand-lowered": "info",
  "warning-sent": "warning",
  "forced-mute": "warning", // (loại cũ — giữ lại để đọc lịch sử DB)
  "forced-cam-off": "warning", // (loại cũ — giữ lại để đọc lịch sử DB)
  "cam-request": "info", // (loại cũ — giữ lại để đọc lịch sử DB)
  "cam-request-denied": "warning", // (loại cũ — giữ lại để đọc lịch sử DB)
  // Điều khiển thiết bị mới (BẬT LUÔN / CẤM / TRẢ QUYỀN):
  "cam-forced-on": "warning",
  "cam-forbidden": "warning",
  "cam-released": "info",
  "mic-forced-on": "warning",
  "mic-forbidden": "warning",
  "mic-released": "info",
  // Thành viên cố lách khoá / thiết bị không mở được theo lệnh:
  "cam-blocked": "warning",
  "mic-blocked": "warning",
  "device-error": "warning",
  "join-request": "info",
  "join-denied": "warning",
  "meeting-ended": "critical",
  "meeting-auto-ended": "critical",
};

/* ========================================================================== */
/* 4. TRẠNG THÁI RUNTIME (bộ nhớ)                                             */
/* ========================================================================== */

interface SessionRuntime {
  id: string; // UUID ổn định phía client (dùng lại khi kết nối lại)
  name: string;
  role: Role;
  socketId: string | null; // Socket đang gắn với phiên (null nếu offline)
  joinTime: number;
  camOn: boolean;
  micOn: boolean;
  /** Khoá điều khiển camera (none/on/off — xem DeviceLock). */
  camLock: DeviceLock;
  /** Khoá điều khiển micro (none/on/off — xem DeviceLock). */
  micLock: DeviceLock;
  handRaised: boolean;
  screenSharing: boolean;
  online: boolean;
  rtt: number | null;
  lastBeat: number;
}

/** Yêu cầu vào lớp đang chờ chủ phòng duyệt (hàng chờ trước cửa lớp). */
interface PendingJoin {
  sessionId: string;
  name: string;
  socketId: string;
  requestedAt: number;
  /** Trạng thái cam/mic KHAI BÁO lúc gõ cửa (vào không camera = false). */
  camOn: boolean;
  micOn: boolean;
}

interface RoomRuntime {
  id: string;
  title: string;
  /** Khoá chủ phòng (null = phòng cũ tạo trước nâng cấp → không cần duyệt). */
  hostKey: string | null;
  /** Hàng chờ "gõ cửa lớp": sessionId → yêu cầu vào đang chờ chủ phòng duyệt. */
  pendingJoins: Map<string, PendingJoin>;
  sessions: Map<string, SessionRuntime>;
  chat: ChatMessage[];
  lastActivity: number;
  /** Đã từng có ÍT NHẤT một người (thành viên/chủ phòng) tham gia — phòng này
   *  đủ điều kiện TỰ KẾT THÚC khi hết người (xem scheduleAutoCloseIfEmpty). */
  everHadMember: boolean;
  /** Bộ đếm giờ tự kết thúc khi phòng trống (null = chưa hẹn). */
  autoCloseTimer: ReturnType<typeof setTimeout> | null;
}

const rooms = new Map<string, RoomRuntime>();

/** Bọc handler để lỗi nghiệp vụ không làm sập tiến trình. */
function safe<A extends unknown[]>(
  fn: (...args: A) => void | Promise<void>
): (...args: A) => void {
  return (...args: A) => {
    try {
      const result = fn(...args);
      if (result instanceof Promise) {
        result.catch((err) => console.error("[handler async]", err));
      }
    } catch (err) {
      console.error("[handler]", err);
    }
  };
}

function nowMs(): number {
  return Date.now();
}

/** Chuẩn hoá họ tên: 2–60 ký tự, gộp khoảng trắng thừa. */
function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 60) return null;
  return name;
}

function toPublicSession(s: SessionRuntime): PublicSession {
  return {
    id: s.id,
    name: s.name,
    role: s.role,
    joinTime: s.joinTime,
    camOn: s.camOn,
    micOn: s.micOn,
    camLock: s.camLock,
    micLock: s.micLock,
    handRaised: s.handRaised,
    screenSharing: s.screenSharing,
    online: s.online,
    rtt: s.rtt,
  };
}

function buildRoomSnapshot(room: RoomRuntime): RoomSnapshot {
  return {
    roomId: room.id,
    title: room.title,
    sessions: Array.from(room.sessions.values()).map(toPublicSession),
  };
}

/** Dựng danh sách phòng cho bảng điều khiển chủ web. */
function buildRoomsSummary(): RoomSummary[] {
  const list: RoomSummary[] = [];
  for (const room of rooms.values()) {
    let online = 0;
    for (const s of room.sessions.values()) if (s.online) online += 1;
    list.push({
      id: room.id,
      title: room.title,
      memberCount: room.sessions.size,
      onlineCount: online,
      lastActivity: room.lastActivity,
    });
  }
  // Phòng hoạt động gần nhất đứng trước.
  list.sort((a, b) => b.lastActivity - a.lastActivity);
  return list;
}

/* ========================================================================== */
/* 5. GIAO TIẾP CƠ SỞ DỮ LIỆU (fire-and-forget, không chặn luồng realtime)     */
/* ========================================================================== */

/** Đảm bảo bản ghi phiên tồn tại trong DB (upsert) — phục vụ khoá ngoại. */
async function ensureSessionRow(
  room: RoomRuntime,
  session: SessionRuntime
): Promise<void> {
  await prisma.session.upsert({
    where: { id: session.id },
    create: {
      id: session.id,
      roomId: room.id,
      name: session.name,
      role: session.role,
      joinedAt: new Date(session.joinTime),
    },
    update: { name: session.name, role: session.role, leftAt: null },
  });
}

interface RecordEventOptions {
  room: RoomRuntime;
  /** Phiên liên quan (người gây ra hoặc người nhận hành động). */
  session?: SessionRuntime | null;
  type: string;
  detail?: string | null;
  severity?: Severity;
}

/**
 * Ghi một sự kiện vào nhật ký hoạt động và phát trực tiếp tới bảng điều
 * khiển chủ web đang mở. Hàm chạy nền (không await) để không trễ realtime.
 */
function recordEvent(opts: RecordEventOptions): void {
  const { room, session, type } = opts;
  const severity = opts.severity ?? EVENT_SEVERITY[type] ?? "info";
  const sessionName = session ? session.name : null;
  const sessionId = session ? session.id : null;

  // 1) Phát realtime tới kênh quản trị NGAY LẬP TỨC.
  const payload: EventPayload = {
    // ID âm TẠM nhưng ĐỘC NHẤT (bộ đếm đếm xuống 1-2-3…) — trước đây dùng
    // -nowMs() khiến 2 sự kiện cùng mili-giây trùng ID → React key trùng lặp.
    id: --tempEventSeq,
    roomId: room.id,
    sessionId,
    sessionName,
    type,
    detail: opts.detail ?? null,
    severity,
    ts: nowMs(),
  };
  io.to(adminsChannel(room.id)).emit("admin:event", { event: payload });

  // 2) Lưu DB chạy nền — nếu session chưa có row thì upsert trước.
  (async () => {
    try {
      if (session) await ensureSessionRow(room, session);
      await prisma.event.create({
        data: {
          roomId: room.id,
          sessionId,
          sessionName: sessionName ?? "",
          type,
          detail: opts.detail ?? null,
          severity,
        },
      });
    } catch (err) {
      console.error("[recordEvent]", type, err);
    }
  })();
}

/** Phát danh sách phòng mới nhất tới mọi socket chủ web đã xác thực. */
function ownersBroadcast(): void {
  io.to(OWNERS_ROOM).emit("rooms:update", { rooms: buildRoomsSummary() });
}

/* ========================================================================== */
/* 5b. TỰ KẾT THÚC KHI PHÒNG TRỐNG (không còn ai trong cuộc họp)              */
/* ========================================================================== */

/** Bộ đếm ID âm cho sự kiện phát realtime — độc nhất trong vòng đời tiến trình. */
let tempEventSeq = 0;

/** Phòng còn ai (thành viên hoặc chủ phòng) đang trực tuyến không? */
function hasOnlineMember(room: RoomRuntime): boolean {
  for (const s of room.sessions.values()) {
    if (s.online && s.role !== "admin") return true;
  }
  return false;
}

/** Trong phòng có NGƯỜI DUYỆT (chủ phòng/chủ web) đang trực tuyến không? */
function hasOnlineModerator(room: RoomRuntime): boolean {
  for (const s of room.sessions.values()) {
    if (s.online && (s.role === "host" || s.role === "admin")) return true;
  }
  return false;
}

/** Huỷ bộ đếm tự kết thúc (khi có người quay lại phòng kịp lúc). */
function clearAutoCloseTimer(room: RoomRuntime): void {
  if (room.autoCloseTimer) {
    clearTimeout(room.autoCloseTimer);
    room.autoCloseTimer = null;
  }
}

/**
 * Đặt lịch TỰ NGHỈ nếu phòng ĐÃ TỪNG có người mà giờ trống trơn:
 * hết AUTO_CLOSE_EMPTY_MS giây vẫn không ai online → dọn phòng khỏi
 * bộ nhớ (liên kết vẫn sống — mở lại sẽ hồi sinh). Có người quay lại
 * kịp → huỷ lịch. Phòng CHƯA từng có ai tham gia thì chưa phải là
 * "cuộc họp" — để quét phòng trống 30 phút lo (như cũ).
 */
function scheduleAutoCloseIfEmpty(room: RoomRuntime): void {
  if (!room.everHadMember) return;
  if (hasOnlineMember(room)) {
    clearAutoCloseTimer(room);
    return;
  }
  if (room.autoCloseTimer) return; // đã hẹn giờ rồi — không đặt thêm
  const timer = setTimeout(() => {
    room.autoCloseTimer = null;
    if (!rooms.has(room.id)) return; // phòng đã đóng bởi luồng khác (TAN LỚP…)
    if (hasOnlineMember(room)) return; // có người quay lại kịp
    closeRoomAutomatically(room);
  }, AUTO_CLOSE_EMPTY_MS);
  room.autoCloseTimer = timer;
  timer.unref?.();
}

/**
 * DỌN PHÒNG TRỐNG (tự nghỉ) — không còn ai trong cuộc họp: ghi nhật ký,
 * báo mọi socket còn trong phòng ("room:closed"), dọn phòng con socket.io
 * và xoá runtime khỏi RAM. KHÔNG đánh dấu closedAt trong DB — liên kết
 * phòng vẫn dùng được; ai mở lại sẽ hồi sinh phòng ngay (chỉ TAN LỚP
 * của chủ web mới đóng vĩnh viễn).
 */
function closeRoomAutomatically(room: RoomRuntime): void {
  const title = room.title || "Phòng học";
  recordEvent({
    room,
    session: null,
    type: "meeting-auto-ended",
    detail: `Buổi học "${title}" tự nghỉ — không còn ai trong phòng (liên kết vẫn hoạt động)`,
    severity: "critical",
  });

  const reason = `Lớp "${title}" hiện không còn ai. Liên kết vẫn hoạt động — hãy thử lại sau chút.`;
  // Báo cho mọi socket còn trong phòng (chủ web đang xem, phiên vừa quay lại…).
  io.to(room.id).emit("room:closed", { roomId: room.id, reason });
  io.to(adminsChannel(room.id)).emit("room:closed", { roomId: room.id, reason });
  // Mời những người đang chờ duyệt trước cửa ra ngoài (chủ phòng không có
  // để duyệt) — họ có thể mở lại liên kết bất cứ lúc nào sau đó.
  for (const pending of room.pendingJoins.values()) {
    io.to(pending.socketId).emit("room:closed", { roomId: room.id, reason });
  }
  room.pendingJoins.clear();

  // Dọn các phiên còn sót (đều offline): gỡ socket khỏi phòng con socket.io.
  for (const session of room.sessions.values()) {
    if (session.socketId) {
      const target = io.sockets.sockets.get(session.socketId);
      if (target) {
        (target.data as Record<string, unknown>) = {};
        target.leave(room.id);
        target.leave(adminsChannel(room.id));
      }
    }
  }

  clearAutoCloseTimer(room);
  rooms.delete(room.id);
  // KHÔNG set closedAt — tự nghỉ chỉ dọn RAM; phòng hồi sinh từ DB khi
  // có người mở lại liên kết (getRoomRuntime / GET /api/rooms/:id lo phần đó).
  ownersBroadcast();
  console.log(
    `[room ${room.id.slice(0, 8)}] TỰ NGHỈ — phòng trống ${Math.round(
      AUTO_CLOSE_EMPTY_MS / 1000
    )} giây, dọn khỏi bộ nhớ (liên kết vẫn hoạt động)`
  );
}

/* ========================================================================== */
/* 6. EXPRESS REST — CỔNG 3004                                                */
/* ========================================================================== */

const app = express();
app.use(express.json({ limit: "256kb" }));

// Cho phép mọi origin: toàn bộ client gọi qua Caddy gateway cùng origin,
// nhưng vẫn mở header CORS để tiện kiểm thử độc lập.
app.use((req: Request, res: Response, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

/** Kiểm tra sức khoẻ dịch vụ. */
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "khanhmeet-signaling", ts: nowMs() });
});

/**
 * TẠO LỚP HỌC MỚI
 * Body: { title?: string }
 * Trả về: { ok, room: { id, title }, hostKey }
 *   hostKey — KHOÁ CHỦ PHÒNG: chỉ trả MỘT LẦN cho người tạo phòng; máy người
 *   tạo lưu trong localStorage và dùng để vào lớp với vai trò "host".
 *   Ai chỉ có liên kết phòng (không có hostKey) đều là thành viên thường
 *   và PHẢI ĐƯỢC CHỦ PHÒNG DUYỆT mới vào được lớp.
 */
app.post("/api/rooms", (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { title?: unknown };
  const title =
    typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";

  const roomId = randomUUID();
  const hostKey = randomBytes(24).toString("hex");

  // Tạo runtime trong RAM để phòng sẵn sàng nhận kết nối ngay lập tức.
  rooms.set(roomId, {
    id: roomId,
    title,
    hostKey,
    pendingJoins: new Map(),
    sessions: new Map(),
    chat: [],
    lastActivity: nowMs(),
    everHadMember: false,
    autoCloseTimer: null,
  });

  // Lưu DB chạy nền — nếu thất bại (rất hiếm) vẫn ghi log, runtime vẫn hoạt động.
  prisma.room
    .create({ data: { id: roomId, title, hostKey } })
    .catch((err) => console.error("[createRoom db]", err));

  ownersBroadcast(); // Bảng điều khiển chủ web thấy phòng mới ngay
  console.log(`[room] Đã tạo lớp học ${roomId} "${title || "(không tên)"}" (kèm khoá chủ phòng)`);
  res.status(201).json({ ok: true, room: { id: roomId, title }, hostKey });
});

/**
 * TRA CỨU THÔNG TIN PHÒNG (công khai) — dùng cho sảnh chờ trước khi vào.
 */
app.get("/api/rooms/:id", async (req: Request, res: Response) => {
  const roomId = req.params.id;
  let runtime = rooms.get(roomId);
  if (!runtime) {
    // Thử "hồi sinh" runtime từ DB (dịch vụ có thể vừa khởi động lại, hoặc
    // phòng vừa tự nghỉ vì không còn ai). Phòng đã TAN LỚP (closedAt) sẽ
    // không hồi sinh — liên kết chết vĩnh viễn.
    const row = await prisma.room.findUnique({ where: { id: roomId } });
    if (!row || row.closedAt) {
      res.json({ ok: true, exists: false });
      return;
    }
    runtime = {
      id: row.id,
      title: row.title,
      hostKey: row.hostKey ?? null,
      pendingJoins: new Map(),
      sessions: new Map(),
      chat: [],
      lastActivity: nowMs(),
      everHadMember: false,
      autoCloseTimer: null,
    };
    rooms.set(roomId, runtime);
  }
  const activeCount = Array.from(runtime.sessions.values()).filter(
    (s) => s.online
  ).length;
  const hostOnline = Array.from(runtime.sessions.values()).some(
    (s) => s.online && s.role === "host"
  );
  res.json({
    ok: true,
    exists: true,
    room: {
      id: runtime.id,
      title: runtime.title,
      activeCount,
      hostOnline,
      waitingCount: runtime.pendingJoins.size,
      /** true = có người duyệt ĐANG TRỰC TUYẾN → người mới phải chờ duyệt.
       *  Chủ phòng chưa vào lớp thì KHÔNG chờ (vào thẳng, chủ phòng vào sau
       *  vẫn đuổi/tắt mic được) — tránh thành viên kẹt màn chờ mãi mãi. */
      approvalRequired: runtime.hostKey !== null && hasOnlineModerator(runtime),
    },
  });
});

// Chuẩn hoá 404 về JSON thay vì stack trace HTML.
app.use((_req: Request, res: Response) => {
  res.status(404).json({ ok: false, error: "not-found" });
});

/* ========================================================================== */
/* 7. SOCKET.IO — CỔNG 3003 (path "/" theo chuẩn gateway)                     */
/* ========================================================================== */

const httpServer = createServer();
/**
 * CHẾ ĐỘ DEPLOY MỘT CỔNG (Railway/Render/Fly…):
 *   Đặt biến môi trường PORT → dịch vụ gộp Express REST + Socket.IO vào CÙNG
 *   một máy chủ HTTP (REST tại /api/*, Socket.IO tại path "/socket.io").
 *   Nền tảng deploy chỉ mở 1 cổng công khai nên đây là chế độ bắt buộc khi
 *   chạy thật; máy chủ client nối thẳng theo NEXT_PUBLIC_SIGNALING_URL.
 * KHÔNG đặt PORT → giữ nguyên kiến trúc hai cổng 3003/3004 path "/"
 *   (chuẩn chạy local qua Caddy gateway / trung chuyển Next.js).
 */
const DEPLOY_PORT = process.env.PORT ? Number(process.env.PORT) : 0;
const httpServerAll = DEPLOY_PORT ? createServer(app) : httpServer;
const io = new SocketIOServer(httpServerAll, {
  // Local: path "/" (Caddy gateway chuyển tiếp theo query XTransformPort,
  // engine.io chấp nhận mọi đường dẫn). Deploy: path "/socket.io" chuẩn.
  path: DEPLOY_PORT ? "/socket.io" : "/",
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

interface SocketContext {
  roomId: string;
  sessionId: string;
  role: Role;
}

/** Đọc ngữ cảnh đã xác thực gắn trên socket (sau khi join phòng thành công). */
function ctxOf(socket: Socket): SocketContext | null {
  const ctx = (socket.data ?? {}) as Partial<SocketContext>;
  if (ctx && typeof ctx.roomId === "string" && typeof ctx.sessionId === "string" && ctx.role) {
    return ctx as SocketContext;
  }
  return null;
}

/** Lấy runtime phòng; nếu chưa có trong RAM thì hồi sinh từ DB. */
async function getRoomRuntime(roomId: string): Promise<RoomRuntime | null> {
  const cached = rooms.get(roomId);
  if (cached) return cached;
  const row = await prisma.room.findUnique({ where: { id: roomId } });
  if (!row || row.closedAt) return null; // đã tan lớp — không hồi sinh
  const runtime: RoomRuntime = {
    id: row.id,
    title: row.title,
    hostKey: row.hostKey ?? null,
    pendingJoins: new Map(),
    sessions: new Map(),
    chat: [],
    lastActivity: nowMs(),
    // Hồi sinh sau khởi động lại dịch vụ: bộ nhớ RAM đã mất nên chưa biết
    // phòng này từng có người — coi như "chưa từng" cho đến khi có người vào.
    everHadMember: false,
    autoCloseTimer: null,
  };
  rooms.set(roomId, runtime);
  return runtime;
}

function broadcastRoomState(room: RoomRuntime): void {
  io.to(room.id).emit("room:state", buildRoomSnapshot(room));
}

/* --------------------- HÀNG CHỜ "GÕ CỬA LỚP" --------------------------- */

/** Phát yêu cầu vào lớp tới MỌI chủ phòng đang trực tuyến trong phòng. */
function notifyHostsNewRequest(room: RoomRuntime, entry: PendingJoin): void {
  const request = {
    sessionId: entry.sessionId,
    name: entry.name,
    requestedAt: entry.requestedAt,
  };
  for (const s of room.sessions.values()) {
    if (s.role === "host" && s.online && s.socketId) {
      io.to(s.socketId).emit("host:join-request", { request });
    }
  }
}

/** Phát "người xin vào đã rút lui / hết chờ" tới chủ phòng. */
function notifyHostsCancelRequest(room: RoomRuntime, sessionId: string): void {
  for (const s of room.sessions.values()) {
    if (s.role === "host" && s.online && s.socketId) {
      io.to(s.socketId).emit("host:join-cancel", { sessionId });
    }
  }
}

/** Phát danh sách "gõ cửa lớp" tới MỌI chủ web đang xem phòng
 *  (console chủ web cũng có nút Đồng ý/Từ chối — không ai phải chờ vô ích). */
function broadcastPending(room: RoomRuntime): void {
  const requests = Array.from(room.pendingJoins.values()).map((pj) => ({
    sessionId: pj.sessionId,
    name: pj.name,
    requestedAt: pj.requestedAt,
  }));
  io.to(adminsChannel(room.id)).emit("admin:pending", { requests });
}

/** Xoá mọi yêu cầu chờ của một socket (khi socket ngắt kết nối giữa chừng). */
function cleanupPendingBySocket(socketId: string): void {
  for (const room of rooms.values()) {
    for (const [sid, pj] of room.pendingJoins) {
      if (pj.socketId === socketId) {
        room.pendingJoins.delete(sid);
        notifyHostsCancelRequest(room, sid);
        broadcastPending(room);
      }
    }
  }
}

/** Gỡ 1 phiên khỏi phòng: broadcast, ghi DB, dọn socket. */
function removeSession(
  room: RoomRuntime,
  sessionId: string,
  reason: "left" | "kicked",
  reasonText?: string
): void {
  const session = room.sessions.get(sessionId);
  if (!session) return;

  room.sessions.delete(sessionId);
  room.lastActivity = nowMs();

  // Ngắt socket gắn với phiên (nếu còn) và xoá ngữ cảnh để disconnect
  // sau đó không còn tác dụng phụ.
  if (session.socketId) {
    const target = io.sockets.sockets.get(session.socketId);
    if (target) {
      if (reason === "kicked") {
        target.emit("kicked", {
          reason: reasonText ?? "Quản trị viên web đã mời bạn ra khỏi phòng học.",
        });
      }
      (target.data as Record<string, unknown>) = {};
      target.leave(room.id);
      target.leave(adminsChannel(room.id));
      if (reason === "kicked") target.disconnect(true);
    }
  }

  io.to(room.id).emit("peer:offline", {
    sessionId,
    name: session.name,
    reason,
  });
  broadcastRoomState(room);
  ownersBroadcast();

  recordEvent({
    room,
    session,
    type: reason === "kicked" ? "kicked" : "leave",
    detail:
      reason === "kicked"
        ? (reasonText ?? "Bị quản trị viên mời ra khỏi phòng")
        : "Rời phòng học",
  });

  // Cập nhật DB: đánh dấu giờ rời.
  prisma.session
    .update({ where: { id: sessionId }, data: { leftAt: new Date() } })
    .catch((err) => console.error("[markLeft]", err));

  // Người vừa đi có thể là người CUỐI CÙNG → hẹn giờ tự kết thúc cuộc họp
  // nếu sau 60 giây vẫn không ai (kể cả kết nối lại) ở lại trong phòng.
  scheduleAutoCloseIfEmpty(room);
}

/* ---------------------- XỬ LÝ KẾT NỐI SOCKET MỚI ------------------------- */

io.on("connection", (socket: Socket) => {
  console.log(`[io] Kết nối mới: ${socket.id}`);

  /* =========================== OWNER:AUTH =============================== */
  /**
   * Xác thực MÃ CHỦ WEB. Thành công → socket tham gia phòng con "::owners"
   * để nhận "rooms:update". Đây là CÁCH DUY NHẤT được cấp quyền quản trị —
   * người thường không có bất kỳ lối nào tới bảng điều khiển.
   */
  socket.on(
    "owner:auth",
    safe((payload: unknown, ack?: (res: unknown) => void) => {
      const reply = (res: unknown) => ack && ack(res);
      const p = (payload ?? {}) as { key?: unknown };
      if (!isOwnerCode(p.key)) {
        reply({ ok: false, error: "owner-key-invalid" });
        return;
      }
      socket.data.owner = true;
      socket.join(OWNERS_ROOM);
      reply({ ok: true, rooms: buildRoomsSummary() });
      console.log(`[owner] Chủ web đã xác thực (${socket.id})`);
    })
  );

  /* =========================== ROOM:JOIN ================================= */
  socket.on(
    "room:join",
    safe(async (payload: unknown, ack?: (res: unknown) => void) => {
      const p = (payload ?? {}) as {
        roomId?: unknown;
        name?: unknown;
        role?: unknown;
        ownerKey?: unknown;
        hostKey?: unknown;
        sessionId?: unknown;
        camOn?: unknown;
        micOn?: unknown;
      };

      const reply = (res: unknown) => ack && ack(res);

      // ---- 1. Kiểm tra phòng tồn tại (RAM hoặc hồi sinh từ DB) ----
      const roomId = typeof p.roomId === "string" ? p.roomId : "";
      if (!roomId) return reply({ ok: false, error: "room-not-found" });
      const room = await getRoomRuntime(roomId);
      if (!room) return reply({ ok: false, error: "room-not-found" });

      const role: Role =
        p.role === "admin" ? "admin" : p.role === "host" ? "host" : "member";
      const name = sanitizeName(p.name);
      if (!name) return reply({ ok: false, error: "name-required" });

      // ---- 2. Xác thực vai trò đặc quyền ----
      if (role === "admin") {
        // Admin = CHỦ WEB: xác thực bằng MÃ CHỦ WEB.
        if (!isOwnerCode(p.ownerKey)) {
          return reply({ ok: false, error: "owner-key-invalid" });
        }
      }
      if (role === "host") {
        // Host = CHỦ PHÒNG (người tạo cuộc họp): xác thực bằng KHOÁ CHỦ PHÒNG.
        const hostKey = typeof p.hostKey === "string" ? p.hostKey : "";
        if (!room.hostKey || hostKey !== room.hostKey) {
          return reply({ ok: false, error: "host-key-invalid" });
        }
      }

      // ---- 3. Giới hạn sĩ số (chỉ tính thành viên) ----
      if (role === "member" && room.sessions.size >= MAX_SESSIONS_PER_ROOM) {
        return reply({ ok: false, error: "room-full" });
      }

      // ---- 4. Tạo mới hoặc tái gắn phiên (kết nối lại sau rớt mạng) ----
      const requestedId =
        typeof p.sessionId === "string" && p.sessionId.length >= 8
          ? p.sessionId
          : randomUUID();

      let session = room.sessions.get(requestedId);
      const isReconnect = Boolean(session);

      // ---- 4b. THÀNH VIÊN MỚI vào lớp → CHỜ DUYỆT (chỉ khi CÓ NGƯỜI DUYỆT online) ----
      // Chủ phòng/chủ web đang trong lớp → người mới gõ cửa chờ duyệt.
      // KHÔNG ai duyệt đang online (chủ phòng chưa vào/mất mạng) → vào thẳng:
      // không ai bấm "Đồng ý" được thì bắt chờ chỉ khiến họ kẹt màn chờ vĩnh viễn;
      // chủ phòng vào sau vẫn toàn quyền (tắt mic, tắt cam, mời ra lớp).
      // Người đã được duyệt trước đó (phiên còn trong phòng) kết nối lại
      // bình thường — không phải xin duyệt lần nữa.
      if (role === "member" && !session && room.hostKey && hasOnlineModerator(room)) {
        room.pendingJoins.set(requestedId, {
          sessionId: requestedId,
          name,
          socketId: socket.id,
          requestedAt: nowMs(),
          camOn: p.camOn !== false,
          micOn: p.micOn !== false,
        });
        room.lastActivity = nowMs();
        recordEvent({
          room,
          session: null,
          type: "join-request",
          detail: `${name} xin vào lớp — chờ chủ phòng duyệt`,
        });
        notifyHostsNewRequest(room, room.pendingJoins.get(requestedId)!);
        broadcastPending(room);
        console.log(
          `[room ${room.id.slice(0, 8)}] ${name} Xin vào lớp — chờ chủ phòng duyệt`
        );
        // ok + pending: client chuyển sang màn "Đang chờ chủ phòng duyệt…".
        return reply({ ok: true, pending: true });
      }

      if (!session) {
        session = {
          id: requestedId,
          name,
          role,
          socketId: null,
          joinTime: nowMs(),
          camOn: role === "member" ? p.camOn !== false : true,
          micOn: role === "member" ? p.micOn !== false : true,
          camLock: "none",
          micLock: "none",
          handRaised: false,
          screenSharing: false,
          online: false,
          rtt: null,
          lastBeat: nowMs(),
        };
        room.sessions.set(requestedId, session);
      } else {
        // Kết nối lại: cập nhật tên (có thể gõ lại), vai trò, mốc giờ, media.
        session.name = name;
        session.role = role;
        session.joinTime = nowMs();
        session.online = true;
        session.socketId = socket.id;
        session.lastBeat = nowMs();
        if (role === "member") {
          // KẸP THEO KHOÁ THIẾT BỊ còn hiệu lực: CẤM → tắt dù khai báo bật;
          // BẬT LUÔN → bật (client sẽ nhận lệnh bật ngay bên dưới để mở
          // thiết bị thật). Cấm là cấm luôn, kể cả sau khi rớt mạng quay lại.
          session.camOn =
            session.camLock === "off"
              ? false
              : session.camLock === "on"
                ? true
                : p.camOn !== false;
          session.micOn =
            session.micLock === "off"
              ? false
              : session.micLock === "on"
                ? true
                : p.micOn !== false;
        }
      }

      // Nếu có socket "zombie" cũ đang giữ phiên này → cướp lại sạch sẽ.
      if (session.socketId && session.socketId !== socket.id) {
        const zombie = io.sockets.sockets.get(session.socketId);
        if (zombie) {
          (zombie.data as Record<string, unknown>) = {};
          zombie.leave(room.id);
          zombie.leave(adminsChannel(room.id));
          zombie.disconnect(true);
        }
      }

      session.socketId = socket.id;
      session.online = true;

      // Có người (thành viên/chủ phòng) online → ghi dấu phòng ĐÃ từng có
      // người (đủ điều kiện tự kết thúc khi hết người) và huỷ lịch tự kết thúc.
      if (role !== "admin") {
        room.everHadMember = true;
        clearAutoCloseTimer(room);
      }

      // ---- 5. Gắn ngữ cảnh & cho socket tham gia các phòng con ----
      (socket.data as Record<string, unknown>) = {
        roomId: room.id,
        sessionId: session.id,
        role,
      };
      socket.join(room.id);
      if (role === "admin") socket.join(adminsChannel(room.id));

      room.lastActivity = nowMs();

      // ---- 6. Ghi DB (đảm bảo row phiên tồn tại) + sự kiện vào phòng ----
      await ensureSessionRow(room, session).catch((err) =>
        console.error("[ensureSessionRow]", err)
      );
      recordEvent({
        room,
        session,
        type: isReconnect ? "rejoin" : "join",
        detail:
          role === "admin"
            ? "Chủ web mở bảng điều khiển xem phòng"
            : role === "host"
              ? isReconnect
                ? "Chủ phòng kết nối lại sau gián đoạn"
                : "Chủ phòng vào lớp"
              : isReconnect
                ? "Kết nối lại sau gián đoạn mạng"
                : "Thành viên vào lớp học",
      });

      // ---- 7. Phản hồi cho người vừa join + thông báo cho cả phòng ----
      const snapshot = buildRoomSnapshot(room);
      reply({
        ok: true,
        session: toPublicSession(session),
        room: { ...snapshot, recentChat: room.chat.slice(-50) },
      });

      // KẸP KHOÁ THIẾT BỊ một lần nữa cho client vừa (re)join:
      //   • CẤM      → hạ thiết bị xuống tắt NGAY (dẹp track còn bật).
      //   • BẬT LUÔN → gửi lệnh bật ngay để client mở/đính thiết bị thật.
      if (session.socketId) {
        if (session.camLock === "off") {
          io.to(session.socketId).emit("force:cam-off", {
            by: "Chủ phòng",
            locked: true,
          });
        } else if (session.camLock === "on") {
          io.to(session.socketId).emit("force:cam-on", {
            by: "Chủ phòng",
          });
        }
        if (session.micLock === "off") {
          io.to(session.socketId).emit("force:mic-off", {
            by: "Chủ phòng",
            locked: true,
          });
        } else if (session.micLock === "on") {
          io.to(session.socketId).emit("force:mic-on", {
            by: "Chủ phòng",
          });
        }
      }

      socket.to(room.id).emit("peer:online", { session: toPublicSession(session) });
      broadcastRoomState(room);
      ownersBroadcast();

      // Chủ web vừa mở phòng → gửi ngay danh sách "gõ cửa" hiện tại
      // để console có nút duyệt nếu chủ phòng chưa vào lớp.
      if (role === "admin") {
        socket.emit("admin:pending", {
          requests: Array.from(room.pendingJoins.values()).map((pj) => ({
            sessionId: pj.sessionId,
            name: pj.name,
            requestedAt: pj.requestedAt,
          })),
        });
      }

      // CHỦ PHÒNG vừa vào lớp → đẩy TOÀN BỘ hàng chờ "gõ cửa" cho họ duyệt.
      if (role === "host") {
        for (const entry of room.pendingJoins.values()) {
          socket.emit("host:join-request", {
            request: {
              sessionId: entry.sessionId,
              name: entry.name,
              requestedAt: entry.requestedAt,
            },
          });
        }
      }

      console.log(
        `[room ${room.id.slice(0, 8)}] ${name} (${role}) ${isReconnect ? "kết nối lại" : "đã vào"} — hiện có ${room.sessions.size} phiên`
      );
    })
  );

  /* =========================== ROOM:LEAVE (rời chủ động) ================== */
  socket.on(
    "room:leave",
    safe(() => {
      const ctx = ctxOf(socket);
      if (!ctx) return;
      const room = rooms.get(ctx.roomId);
      if (!room) return;
      removeSession(room, ctx.sessionId, "left");
    })
  );

  /* =========================== STATE:UPDATE ============================== */
  /**
   * Thành viên cập nhật trạng thái cam/mic/giơ tay/chia sẻ màn hình.
   * Tắt cam/mic là TẮT THẬT phía client (track.enabled=false) — máy chủ
   * chỉ ghi nhật ký để bảng điều khiển chủ web hiển thị đúng trạng thái.
   *
   * MÁY CHỦ LÀ TRỌNG TÀI KHOÁ THIẾT BỊ: nếu thiết bị đang bị KHOÁ
   * (camLock/micLock ≠ "none") thì yêu cầu ngược chiều khoá bị TỪ CHỐI:
   *   • Bị CẤM ("off")  mà xin BẬT     → chặn + ghi "cam-blocked/mic-blocked".
   *   • Bị BẬT LUÔN ("on") mà xin TẮT  → chặn + ghi tương tự.
   * Client hợp lệ đã tự chặn sẵn; lớp này đón những client bị sửa/lách.
   */
  socket.on(
    "state:update",
    safe((payload: unknown) => {
      const ctx = ctxOf(socket);
      if (!ctx) return;
      const room = rooms.get(ctx.roomId);
      if (!room) return;
      const session = room.sessions.get(ctx.sessionId);
      if (!session) return;

      const p = (payload ?? {}) as Record<string, unknown>;
      const bool = (v: unknown): boolean | null =>
        typeof v === "boolean" ? v : null;

      room.lastActivity = nowMs();

      // --- Camera: chặn vi phạm khoá, cho phép những thay đổi hợp lệ ---
      const cam = bool(p.camOn);
      if (cam !== null && cam !== session.camOn) {
        if ((cam && session.camLock === "off") || (!cam && session.camLock === "on")) {
          // Vi phạm khoá → TỪ CHỐI, giữ nguyên trạng thái, ghi bằng chứng.
          recordEvent({
            room,
            session,
            type: "cam-blocked",
            severity: "warning",
            detail: cam
              ? `${session.name} cố BẬT camera khi đang bị CẤM — đã chặn`
              : `${session.name} cố TẮT camera khi bị chủ phòng BẬT LUÔN — đã chặn`,
          });
          if (session.socketId) {
            io.to(session.socketId).emit("lock:rejected", {
              device: "cam",
              action: cam ? "on" : "off",
            });
          }
        } else {
          session.camOn = cam;
          recordEvent({
            room,
            session,
            type: cam ? "cam-on" : "cam-off",
            detail: cam ? "Bật camera" : "Tắt camera",
          });
        }
      }
      // --- Micro: chặn vi phạm khoá, cho phép những thay đổi hợp lệ ---
      const mic = bool(p.micOn);
      if (mic !== null && mic !== session.micOn) {
        if ((mic && session.micLock === "off") || (!mic && session.micLock === "on")) {
          recordEvent({
            room,
            session,
            type: "mic-blocked",
            severity: "warning",
            detail: mic
              ? `${session.name} cố BẬT micro khi đang bị CẤM — đã chặn`
              : `${session.name} cố TẮT micro khi bị chủ phòng BẬT LUÔN — đã chặn`,
          });
          if (session.socketId) {
            io.to(session.socketId).emit("lock:rejected", {
              device: "mic",
              action: mic ? "on" : "off",
            });
          }
        } else {
          session.micOn = mic;
          recordEvent({
            room,
            session,
            type: mic ? "mic-on" : "mic-off",
            detail: mic ? "Bật micro" : "Tắt micro",
          });
        }
      }
      const hand = bool(p.handRaised);
      if (hand !== null && hand !== session.handRaised) {
        session.handRaised = hand;
        recordEvent({
          room,
          session,
          type: hand ? "hand-raised" : "hand-lowered",
          detail: hand ? "Giơ tay phát biểu" : "Hạ tay",
        });
      }
      const share = bool(p.screenSharing);
      if (share !== null && share !== session.screenSharing) {
        session.screenSharing = share;
        recordEvent({
          room,
          session,
          type: share ? "screen-share-start" : "screen-share-stop",
          detail: share ? "Bắt đầu chia sẻ màn hình" : "Dừng chia sẻ màn hình",
        });
      }

      broadcastRoomState(room);
    })
  );

  /* ================= DEVICE:ACQUIRE-FAILED (báo lỗi mở thiết bị) ========== */
  /**
   * Client nhận lệnh BẬT LUÔN nhưng không mở được thiết bị (không có cam,
   * bị chiếm dụng, thiếu quyền) → báo về để chủ phòng/chủ web biết trong
   * nhật ký (sự kiện "device-error").
   */
  socket.on(
    "device:acquire-failed",
    safe((payload: unknown) => {
      const ctx = ctxOf(socket);
      if (!ctx) return;
      const room = rooms.get(ctx.roomId);
      if (!room) return;
      const session = room.sessions.get(ctx.sessionId);
      if (!session) return;
      const p = (payload ?? {}) as { device?: unknown; reason?: unknown };
      const device = p.device === "mic" ? "mic" : "cam";
      const reason =
        typeof p.reason === "string" ? p.reason.slice(0, 140) : "không rõ nguyên nhân";
      recordEvent({
        room,
        session,
        type: "device-error",
        severity: "warning",
        detail: `Không mở được ${device === "cam" ? "camera" : "micro"} theo lệnh của chủ phòng: ${reason}`,
      });
    })
  );

  /* =========================== CHAT:SEND ================================= */
  socket.on(
    "chat:send",
    safe((payload: unknown) => {
      const ctx = ctxOf(socket);
      if (!ctx) return;
      const room = rooms.get(ctx.roomId);
      if (!room) return;
      const session = room.sessions.get(ctx.sessionId);
      if (!session) return;

      const p = (payload ?? {}) as { text?: unknown };
      const text =
        typeof p.text === "string" ? p.text.trim().slice(0, MAX_CHAT_LENGTH) : "";
      if (!text) return;

      const msg: ChatMessage = {
        id: randomUUID(),
        sessionId: session.id,
        name: session.name,
        text,
        ts: nowMs(),
      };
      room.chat.push(msg);
      if (room.chat.length > MAX_CHAT_HISTORY) room.chat.shift();
      room.lastActivity = nowMs();
      io.to(room.id).emit("chat:message", msg);
    })
  );

  /* =========================== WEBRTC:SIGNAL (trung chuyển) ============== */
  /**
   * Trung chuyển gói tin điều phối WebRTC (offer/answer/ICE/bye) giữa hai
   * peer trong cùng phòng. Máy chủ KHÔNG giải mã nội dung — chỉ định tuyến
   * theo sessionId để đảm bảo đúng người nhận.
   */
  socket.on(
    "webrtc:signal",
    safe((payload: unknown) => {
      const ctx = ctxOf(socket);
      if (!ctx) return;
      const room = rooms.get(ctx.roomId);
      if (!room) return;

      const p = (payload ?? {}) as {
        to?: unknown;
        media?: unknown;
        kind?: unknown;
        data?: unknown;
      };
      const to = typeof p.to === "string" ? p.to : "";
      const media: SignalMedia = p.media === "screen" ? "screen" : "cam";
      const kind: SignalKind =
        p.kind === "offer" || p.kind === "answer" || p.kind === "ice" || p.kind === "bye"
          ? p.kind
          : "ice";
      if (!to || p.data === undefined) return;

      const target = room.sessions.get(to);
      if (!target || !target.online || !target.socketId) return;

      io.to(target.socketId).emit("webrtc:signal", {
        from: ctx.sessionId,
        media,
        kind,
        data: p.data,
      });
    })
  );

  /* =========================== HEARTBEAT 24/24 =========================== */
  /**
   * Client gửi nhịp tim mỗi ~4 giây. Máy chủ echo lại dấu thời gian để
   * client tự tính RTT; client báo RTT ngược về và giá trị này hiển thị
   * trên từng ô CCTV của bảng điều khiển chủ web.
   */
  socket.on(
    "heartbeat",
    safe((payload: unknown) => {
      const ctx = ctxOf(socket);
      const p = (payload ?? {}) as { t?: unknown };
      const t = typeof p.t === "number" ? p.t : nowMs();
      socket.emit("heartbeat:ack", { t });
      if (!ctx) return;
      const room = rooms.get(ctx.roomId);
      const session = room?.sessions.get(ctx.sessionId);
      if (room && session) session.lastBeat = nowMs();
    })
  );

  socket.on(
    "rtt:report",
    safe((payload: unknown) => {
      const ctx = ctxOf(socket);
      if (!ctx) return;
      const room = rooms.get(ctx.roomId);
      const session = room?.sessions.get(ctx.sessionId);
      if (!room || !session) return;
      const p = (payload ?? {}) as { rtt?: unknown };
      const rtt = Math.max(0, Math.min(9999, Number(p.rtt) || 0));
      session.rtt = Math.round(rtt);
      // Broadcast trạng thái (nhẹ) để dashboard cập nhật chỉ số ping.
      broadcastRoomState(room);
    })
  );

  /* =========================== CÁC HÀNH ĐỘNG ĐIỀU HÀNH ==================== */

  /** Kiểm tra socket hiện tại có phải quản trị viên đã xác thực của phòng không. */
  function isAdminOf(socket: Socket, roomId: string): boolean {
    const ctx = ctxOf(socket);
    return Boolean(ctx && ctx.role === "admin" && ctx.roomId === roomId);
  }

  /**
   * Kiểm tra quyền ĐIỀU HÀNH TRONG LỚP: CHỦ PHÒNG (host) hoặc CHỦ WEB (admin).
   * Cả hai đều được: mời ra khỏi lớp (kick), tắt mic, tắt camera từ xa.
   */
  function isModeratorOf(socket: Socket, roomId: string): boolean {
    const ctx = ctxOf(socket);
    return Boolean(
      ctx &&
      ctx.roomId === roomId &&
      (ctx.role === "admin" || ctx.role === "host")
    );
  }

  /** Người điều hành có thể tác động lên phiên đích nào? */
  function canActOn(actorRole: Role, target: SessionRuntime): boolean {
    if (target.role === "admin") return false; // Không bao giờ đụng tới chủ web.
    if (actorRole === "admin") return true; // Chủ web: quyền tối cao trong lớp.
    return target.role === "member"; // Chủ phòng: chỉ tác động lên thành viên.
  }

  /** Nhãn thân thiện của người điều hành (hiển thị cho thành viên bị tác động). */
  function moderatorLabel(role: Role): string {
    return role === "host" ? "Chủ phòng" : "Quản trị viên web";
  }

  /** Gửi cảnh báo tới một thành viên cụ thể. */
  socket.on(
    "admin:warning",
    safe((payload: unknown, ack?: (res: unknown) => void) => {
      const p = (payload ?? {}) as { to?: unknown; message?: unknown };
      const reply = (res: unknown) => ack && ack(res);
      const ctx = ctxOf(socket);
      if (!ctx) return reply({ ok: false, error: "not-in-room" });
      const room = rooms.get(ctx.roomId);
      if (!room || !isAdminOf(socket, ctx.roomId))
        return reply({ ok: false, error: "forbidden" });

      const to = typeof p.to === "string" ? p.to : "";
      const message =
        typeof p.message === "string" ? p.message.trim().slice(0, MAX_WARNING_LENGTH) : "";
      const target = room.sessions.get(to);
      if (!message || !target || !target.online || !target.socketId)
        return reply({ ok: false, error: "target-unavailable" });

      io.to(target.socketId).emit("warning", { message, from: "Quản trị viên web" });
      recordEvent({
        room,
        session: target,
        type: "warning-sent",
        detail: `Chủ web gửi cảnh báo: "${message}"`,
      });
      reply({ ok: true });
    })
  );

  /** Gửi cảnh báo đồng loạt tới toàn bộ thành viên. */
  socket.on(
    "admin:broadcast-warning",
    safe((payload: unknown, ack?: (res: unknown) => void) => {
      const p = (payload ?? {}) as { message?: unknown };
      const reply = (res: unknown) => ack && ack(res);
      const ctx = ctxOf(socket);
      if (!ctx) return reply({ ok: false, error: "not-in-room" });
      const room = rooms.get(ctx.roomId);
      if (!room || !isAdminOf(socket, ctx.roomId))
        return reply({ ok: false, error: "forbidden" });

      const message =
        typeof p.message === "string" ? p.message.trim().slice(0, MAX_WARNING_LENGTH) : "";
      if (!message) return reply({ ok: false, error: "message-required" });

      let count = 0;
      for (const s of room.sessions.values()) {
        if (s.role === "member" && s.online && s.socketId) {
          io.to(s.socketId).emit("warning", { message, from: "Quản trị viên web" });
          recordEvent({
            room,
            session: s,
            type: "warning-sent",
            detail: `Chủ web cảnh báo toàn phòng: "${message}"`,
          });
          count += 1;
        }
      }
      reply({ ok: true, count });
    })
  );

  /**
   * MỜI RA KHỎI LỚP (kick) — quyền của CHỦ PHÒNG & CHỦ WEB.
   * Không thể mời chủ web khác ra; chủ phòng chỉ mời được thành viên.
   */
  socket.on(
    "admin:kick",
    safe((payload: unknown, ack?: (res: unknown) => void) => {
      const p = (payload ?? {}) as { to?: unknown };
      const reply = (res: unknown) => ack && ack(res);
      const ctx = ctxOf(socket);
      if (!ctx) return reply({ ok: false, error: "not-in-room" });
      const room = rooms.get(ctx.roomId);
      if (!room || !isModeratorOf(socket, ctx.roomId))
        return reply({ ok: false, error: "forbidden" });

      const to = typeof p.to === "string" ? p.to : "";
      const target = room.sessions.get(to);
      if (!target || !canActOn(ctx.role, target))
        return reply({ ok: false, error: "target-unavailable" });

      const label = moderatorLabel(ctx.role);
      removeSession(
        room,
        to,
        "kicked",
        `${label} đã mời bạn ra khỏi lớp học.`
      );
      reply({ ok: true });
    })
  );

  /**
   * ĐIỀU KHIỂN CAMERA THÀNH VIÊN — quyền của CHỦ PHÒNG & CHỦ WEB (3 chế độ,
   * theo yêu cầu CEO: "BẬT là BẬT LUÔN, CẤM là CẤM LUÔN"):
   *   • mode "on"   : BẬT LUÔN — camera bật NGAY trên máy thành viên (client
   *                   tự mở thiết bị), khoá ở trạng thái bật (không tự tắt).
   *   • mode "off"  : CẤM — camera tắt NGAY + thành viên KHÔNG thể tự bật
   *                   lại (mọi cố gắng bị máy chủ chặn và ghi nhật ký).
   *   • mode "free" : TRẢ QUYỀN — thành viên tự chủ lại camera của mình.
   * Khoá có hiệu lực NGAY LẬP TỨC và còn hiệu lực khi họ rớt mạng vào lại.
   */
  socket.on(
    "admin:cam-control",
    safe((payload: unknown, ack?: (res: unknown) => void) => {
      const p = (payload ?? {}) as { to?: unknown; mode?: unknown };
      const reply = (res: unknown) => ack && ack(res);
      const ctx = ctxOf(socket);
      if (!ctx) return reply({ ok: false, error: "not-in-room" });
      const room = rooms.get(ctx.roomId);
      if (!room || !isModeratorOf(socket, ctx.roomId))
        return reply({ ok: false, error: "forbidden" });

      const to = typeof p.to === "string" ? p.to : "";
      const mode: DeviceLock =
        p.mode === "on" ? "on" : p.mode === "off" ? "off" : "none";
      const target = room.sessions.get(to);
      if (!target || !canActOn(ctx.role, target))
        return reply({ ok: false, error: "target-unavailable" });

      const by = moderatorLabel(ctx.role);
      target.camLock = mode;

      if (mode === "on") {
        // BẬT LUÔN: camera bật ngay lập tức (client mở track/thiết bị thật).
        const wasOff = !target.camOn;
        target.camOn = true;
        if (target.online && target.socketId) {
          io.to(target.socketId).emit("force:cam-on", { by });
        }
        recordEvent({
          room,
          session: target,
          type: "cam-forced-on",
          severity: "warning",
          detail: wasOff
            ? `${by} BẬT camera của ${target.name} (bật luôn — không thể tự tắt)`
            : `${by} khoá camera của ${target.name} ở trạng thái BẬT`,
        });
      } else if (mode === "off") {
        // CẤM: camera tắt ngay lập tức + khoá — không tự bật lại được.
        const wasOn = target.camOn;
        target.camOn = false;
        if (target.online && target.socketId) {
          io.to(target.socketId).emit("force:cam-off", { by, locked: true });
        }
        recordEvent({
          room,
          session: target,
          type: "cam-forbidden",
          severity: "warning",
          detail: wasOn
            ? `${by} CẤM camera của ${target.name} (đã tắt — không thể tự bật lại)`
            : `${by} CẤM camera của ${target.name} (đang tắt, khoá luôn)`,
        });
      } else {
        // TRẢ QUYỀN: mở khoá, thiết bị giữ nguyên trạng thái hiện tại.
        if (target.online && target.socketId) {
          io.to(target.socketId).emit("cam:released", { by });
        }
        recordEvent({
          room,
          session: target,
          type: "cam-released",
          detail: `${by} trả quyền điều khiển camera cho ${target.name}`,
        });
      }

      broadcastRoomState(room);
      reply({ ok: true });
    })
  );

  /**
   * ĐIỀU KHIỂN MICRO THÀNH VIÊN — quyền của CHỦ PHÒNG & CHỦ WEB (3 chế độ,
   * hoàn toàn đối xứng với admin:cam-control: BẬT LUÔN / CẤM / TRẢ QUYỀN).
   */
  socket.on(
    "admin:mic-control",
    safe((payload: unknown, ack?: (res: unknown) => void) => {
      const p = (payload ?? {}) as { to?: unknown; mode?: unknown };
      const reply = (res: unknown) => ack && ack(res);
      const ctx = ctxOf(socket);
      if (!ctx) return reply({ ok: false, error: "not-in-room" });
      const room = rooms.get(ctx.roomId);
      if (!room || !isModeratorOf(socket, ctx.roomId))
        return reply({ ok: false, error: "forbidden" });

      const to = typeof p.to === "string" ? p.to : "";
      const mode: DeviceLock =
        p.mode === "on" ? "on" : p.mode === "off" ? "off" : "none";
      const target = room.sessions.get(to);
      if (!target || !canActOn(ctx.role, target))
        return reply({ ok: false, error: "target-unavailable" });

      const by = moderatorLabel(ctx.role);
      target.micLock = mode;

      if (mode === "on") {
        const wasOff = !target.micOn;
        target.micOn = true;
        if (target.online && target.socketId) {
          io.to(target.socketId).emit("force:mic-on", { by });
        }
        recordEvent({
          room,
          session: target,
          type: "mic-forced-on",
          severity: "warning",
          detail: wasOff
            ? `${by} BẬT micro của ${target.name} (bật luôn — không thể tự tắt)`
            : `${by} khoá micro của ${target.name} ở trạng thái BẬT`,
        });
      } else if (mode === "off") {
        const wasOn = target.micOn;
        target.micOn = false;
        if (target.online && target.socketId) {
          io.to(target.socketId).emit("force:mic-off", { by, locked: true });
        }
        recordEvent({
          room,
          session: target,
          type: "mic-forbidden",
          severity: "warning",
          detail: wasOn
            ? `${by} CẤM micro của ${target.name} (đã tắt tiếng — không thể tự bật lại)`
            : `${by} CẤM micro của ${target.name} (đang tắt, khoá luôn)`,
        });
      } else {
        if (target.online && target.socketId) {
          io.to(target.socketId).emit("mic:released", { by });
        }
        recordEvent({
          room,
          session: target,
          type: "mic-released",
          detail: `${by} trả quyền điều khiển micro cho ${target.name}`,
        });
      }

      broadcastRoomState(room);
      reply({ ok: true });
    })
  );

  /* =========================== DUYỆT / TỪ CHỐI VÀO LỚP ==================== */

  /**
   * ĐỒNG Ý cho người đang chờ trước cửa vào lớp — quyền của CHỦ PHÒNG & CHỦ WEB.
   * Máy chủ tự gắn phiên, đưa socket người đó vào phòng rồi bung sự kiện
   * "join:approved" để client của họ rời màn chờ duyệt vào thẳng lớp.
   */
  socket.on(
    "host:admit",
    safe((payload: unknown, ack?: (res: unknown) => void) => {
      const p = (payload ?? {}) as { sessionId?: unknown };
      const reply = (res: unknown) => ack && ack(res);
      const ctx = ctxOf(socket);
      if (!ctx) return reply({ ok: false, error: "not-in-room" });
      const room = rooms.get(ctx.roomId);
      if (!room || !isModeratorOf(socket, ctx.roomId))
        return reply({ ok: false, error: "forbidden" });

      const sid = typeof p.sessionId === "string" ? p.sessionId : "";
      const pending = room.pendingJoins.get(sid);
      if (!pending) return reply({ ok: false, error: "target-unavailable" });

      const targetSocket = io.sockets.sockets.get(pending.socketId);
      if (!targetSocket || !targetSocket.connected) {
        room.pendingJoins.delete(sid);
        return reply({ ok: false, error: "target-unavailable" });
      }
      if (room.sessions.size >= MAX_SESSIONS_PER_ROOM) {
        return reply({ ok: false, error: "room-full" });
      }

      room.pendingJoins.delete(sid);
      broadcastPending(room);
      // Báo MỌI chủ phòng trong lớp xoá thẻ "xin vào" (kể cả khi chính
      // chủ web bấm duyệt — chủ phòng không còn thấy người đã được vào).
      notifyHostsCancelRequest(room, sid);

      // Dựng phiên thành viên (đã được duyệt) và gắn vào socket đang chờ.
      // cam/mic lấy theo KHAI BÁO lúc gõ cửa (vào không camera thì đúng luôn
      // trạng thái tắt — trước đây gán cứng true khiến nút "yêu cầu bật
      // camera" của chủ phòng không hiện đúng).
      const session: SessionRuntime = {
        id: sid,
        name: pending.name,
        role: "member",
        socketId: pending.socketId,
        joinTime: nowMs(),
        camOn: pending.camOn,
        micOn: pending.micOn,
        camLock: "none",
        micLock: "none",
        handRaised: false,
        screenSharing: false,
        online: true,
        rtt: null,
        lastBeat: nowMs(),
      };
      room.sessions.set(sid, session);
      room.everHadMember = true;
      clearAutoCloseTimer(room);
      room.lastActivity = nowMs();

      // Báo cả lớp TRƯỚC khi đưa socket mới vào kênh phòng (tránh người
      // vừa vào tự nhận toast "đã vào phòng" của chính mình).
      socket.to(room.id).emit("peer:online", { session: toPublicSession(session) });

      (targetSocket.data as Record<string, unknown>) = {
        roomId: room.id,
        sessionId: sid,
        role: "member",
      };
      targetSocket.join(room.id);

      recordEvent({
        room,
        session,
        type: "join",
        detail: `Được ${moderatorLabel(ctx.role)} duyệt vào lớp`,
      });

      // Bung sự kiện cho người đang chờ: vào lớp ngay lập tức.
      targetSocket.emit("join:approved", {
        ok: true,
        session: toPublicSession(session),
        room: { ...buildRoomSnapshot(room), recentChat: room.chat.slice(-50) },
      });

      broadcastRoomState(room);
      ownersBroadcast();
      console.log(
        `[room ${room.id.slice(0, 8)}] ĐÃ DUYỆT ${pending.name} vào lớp (bởi ${moderatorLabel(ctx.role)})`
      );
      reply({ ok: true, name: pending.name });
    })
  );

  /** TỪ CHỐI người đang chờ trước cửa — quyền của CHỦ PHÒNG & CHỦ WEB. */
  socket.on(
    "host:deny",
    safe((payload: unknown, ack?: (res: unknown) => void) => {
      const p = (payload ?? {}) as { sessionId?: unknown };
      const reply = (res: unknown) => ack && ack(res);
      const ctx = ctxOf(socket);
      if (!ctx) return reply({ ok: false, error: "not-in-room" });
      const room = rooms.get(ctx.roomId);
      if (!room || !isModeratorOf(socket, ctx.roomId))
        return reply({ ok: false, error: "forbidden" });

      const sid = typeof p.sessionId === "string" ? p.sessionId : "";
      const pending = room.pendingJoins.get(sid);
      if (!pending) return reply({ ok: false, error: "target-unavailable" });

      room.pendingJoins.delete(sid);
      broadcastPending(room);
      notifyHostsCancelRequest(room, sid);
      recordEvent({
        room,
        session: null,
        type: "join-denied",
        detail: `${pending.name} bị ${moderatorLabel(ctx.role).toLowerCase()} từ chối vào lớp`,
        severity: "warning",
      });

      const targetSocket = io.sockets.sockets.get(pending.socketId);
      if (targetSocket) {
        targetSocket.emit("join:denied", {
          reason: "Chủ phòng đã từ chối yêu cầu vào lớp của bạn.",
        });
        targetSocket.disconnect(true);
      }
      console.log(
        `[room ${room.id.slice(0, 8)}] TỪ CHỐI ${pending.name} vào lớp`
      );
      reply({ ok: true, name: pending.name });
    })
  );

  /**
   * TAN LỚP: kết thúc buổi học cho cả phòng — đuổi toàn bộ thành viên,
   * đóng phòng VĨNH VIỄN (liên kết cũ không thể dùng lại) và ghi nhật ký.
   */
  socket.on(
    "admin:end-meeting",
    safe((_payload: unknown, ack?: (res: unknown) => void) => {
      const reply = (res: unknown) => ack && ack(res);
      const ctx = ctxOf(socket);
      if (!ctx) return reply({ ok: false, error: "not-in-room" });
      const room = rooms.get(ctx.roomId);
      if (!room || !isAdminOf(socket, ctx.roomId))
        return reply({ ok: false, error: "forbidden" });

      const memberIds = Array.from(room.sessions.values())
        .filter((s) => s.role !== "admin")
        .map((s) => s.id);
      const actor = room.sessions.get(ctx.sessionId) ?? null;

      recordEvent({
        room,
        session: actor,
        type: "meeting-ended",
        detail: `Chủ web kết thúc buổi học cho cả lớp (${memberIds.length} người)`,
      });

      const endText = "Chủ web đã kết thúc buổi học cho cả lớp.";
      for (const id of memberIds) {
        removeSession(room, id, "kicked", endText);
      }

      // Người đang chờ duyệt trước cửa cũng nhận tin lớp đã tan.
      for (const pending of room.pendingJoins.values()) {
        io.to(pending.socketId).emit("room:closed", {
          roomId: room.id,
          reason: endText,
        });
      }
      room.pendingJoins.clear();

      // Đóng phòng vĩnh viễn: xoá runtime + đánh dấu closedAt trong DB.
      clearAutoCloseTimer(room);
      rooms.delete(room.id);
      prisma.room
        .update({ where: { id: room.id }, data: { closedAt: new Date() } })
        .catch((err) => console.error("[end-meeting db]", err));
      ownersBroadcast();

      console.log(
        `[room ${room.id.slice(0, 8)}] Đã TAN LỚP — đuổi ${memberIds.length} thành viên, đóng phòng vĩnh viễn`
      );
      reply({ ok: true, kicked: memberIds.length });
    })
  );

  /** Thêm ghi chú nhanh về một thành viên (lưu vĩnh viễn). */
  socket.on(
    "admin:note:add",
    safe((payload: unknown, ack?: (res: unknown) => void) => {
      const p = (payload ?? {}) as { targetSessionId?: unknown; content?: unknown };
      const reply = (res: unknown) => ack && ack(res);
      const ctx = ctxOf(socket);
      if (!ctx) return reply({ ok: false, error: "not-in-room" });
      const room = rooms.get(ctx.roomId);
      if (!room || !isAdminOf(socket, ctx.roomId))
        return reply({ ok: false, error: "forbidden" });

      const targetSessionId =
        typeof p.targetSessionId === "string" ? p.targetSessionId : "";
      const content =
        typeof p.content === "string" ? p.content.trim().slice(0, MAX_NOTE_LENGTH) : "";
      if (!targetSessionId || !content)
        return reply({ ok: false, error: "invalid-payload" });

      const actor = room.sessions.get(ctx.sessionId);
      const authorName = actor ? actor.name : "Quản trị viên web";

      (async () => {
        try {
          // Đảm bảo phiên đích có row trong DB (thành viên có thể đã rời phòng).
          let targetName = "";
          const targetRuntime = room.sessions.get(targetSessionId);
          if (targetRuntime) {
            await ensureSessionRow(room, targetRuntime);
            targetName = targetRuntime.name;
          } else {
            const row = await prisma.session.findUnique({
              where: { id: targetSessionId },
            });
            targetName = row ? row.name : "Không rõ";
          }

          const note = await prisma.note.create({
            data: {
              roomId: room.id,
              targetSessionId,
              targetName,
              authorName,
              content,
            },
          });

          const payloadNote: NotePayload = {
            id: note.id,
            roomId: note.roomId,
            targetSessionId: note.targetSessionId,
            targetName: note.targetName,
            authorName: note.authorName,
            content: note.content,
            ts: note.createdAt.getTime(),
          };
          io.to(adminsChannel(room.id)).emit("admin:note:added", {
            note: payloadNote,
          });
          reply({ ok: true, note: payloadNote });
        } catch (err) {
          console.error("[note:add]", err);
          reply({ ok: false, error: "db-error" });
        }
      })();
    })
  );

  /** Lấy danh sách ghi chú của phòng (chủ web). */
  socket.on(
    "admin:notes:list",
    safe((_payload: unknown, ack?: (res: unknown) => void) => {
      const reply = (res: unknown) => ack && ack(res);
      const ctx = ctxOf(socket);
      if (!ctx) return reply({ ok: false, error: "not-in-room" });
      const room = rooms.get(ctx.roomId);
      if (!room || !isAdminOf(socket, ctx.roomId))
        return reply({ ok: false, error: "forbidden" });

      (async () => {
        const notes = await prisma.note.findMany({
          where: { roomId: room.id },
          orderBy: { createdAt: "asc" },
          take: 500,
        });
        reply({
          ok: true,
          notes: notes.map<NotePayload>((n) => ({
            id: n.id,
            roomId: n.roomId,
            targetSessionId: n.targetSessionId,
            targetName: n.targetName,
            authorName: n.authorName,
            content: n.content,
            ts: n.createdAt.getTime(),
          })),
        });
      })().catch((err) => {
        console.error("[notes:list]", err);
        reply({ ok: false, error: "db-error" });
      });
    })
  );

  /** Lấy lịch sử sự kiện (chủ web) — dùng khi mở một phòng trong console. */
  socket.on(
    "admin:events:list",
    safe((payload: unknown, ack?: (res: unknown) => void) => {
      const p = (payload ?? {}) as { limit?: unknown };
      const reply = (res: unknown) => ack && ack(res);
      const ctx = ctxOf(socket);
      if (!ctx) return reply({ ok: false, error: "not-in-room" });
      const room = rooms.get(ctx.roomId);
      if (!room || !isAdminOf(socket, ctx.roomId))
        return reply({ ok: false, error: "forbidden" });

      const limit = Math.max(1, Math.min(500, Number(p.limit) || 300));
      (async () => {
        // Truy vấn mới nhất trước rồi đảo ngược để hiển thị theo dòng thời gian.
        const events = await prisma.event.findMany({
          where: { roomId: room.id },
          orderBy: { createdAt: "desc" },
          take: limit,
        });
        const list = events
          .slice()
          .reverse()
          .map<EventPayload>((e) => ({
            id: e.id,
            roomId: e.roomId,
            sessionId: e.sessionId,
            sessionName: e.sessionName || null,
            type: e.type,
            detail: e.detail,
            severity: (e.severity as Severity) ?? "info",
            ts: e.createdAt.getTime(),
          }));
        reply({ ok: true, events: list });
      })().catch((err) => {
        console.error("[events:list]", err);
        reply({ ok: false, error: "db-error" });
      });
    })
  );

  /* =========================== DISCONNECT ================================ */
  socket.on(
    "disconnect",
    safe((reason: string) => {
      const ctx = ctxOf(socket);
      console.log(`[io] Ngắt kết nối ${socket.id} (${reason})`);

      // Socket này có thể đang "gõ cửa lớp" (chờ chủ phòng duyệt) →
      // rút yêu cầu khỏi hàng chờ và báo chủ phòng biết.
      cleanupPendingBySocket(socket.id);

      if (!ctx) return; // Chủ web chưa vào phòng nào — không có gì để dọn.

      const room = rooms.get(ctx.roomId);
      if (!room) return;
      const session = room.sessions.get(ctx.sessionId);
      if (!session || session.socketId !== socket.id) return; // phiên đã được gắn sang socket khác

      // Đánh dấu offline nhưng GIỮ phiên trong RAM để chờ kết nối lại.
      session.online = false;
      session.socketId = null;
      room.lastActivity = nowMs();

      io.to(room.id).emit("peer:offline", {
        sessionId: session.id,
        name: session.name,
        reason: "disconnected",
      });
      broadcastRoomState(room);
      ownersBroadcast();

      recordEvent({
        room,
        session,
        type: "disconnected",
        detail: `Mất kết nối (${reason}) — chờ kết nối lại`,
      });

      prisma.session
        .update({ where: { id: session.id }, data: { leftAt: new Date() } })
        .catch(() => undefined);

      // Mất kết nối của người cuối → hẹn giờ tự kết thúc nếu không ai
      // kết nối lại trong 60 giây (kể cả phiên offline trong RAM).
      scheduleAutoCloseIfEmpty(room);
    })
  );
});

/* ========================================================================== */
/* 8. DỌN DẸP PHÒNG TRỐNG & SESSION ZOMBIE (chống rò rỉ bộ nhớ 24/24)          */
/* ========================================================================== */

/** Quét mỗi 60 giây: session offline quá 5 phút không quay lại → rời hẳn. */
setInterval(() => {
  const now = nowMs();
  for (const room of rooms.values()) {
    const staleIds: string[] = [];
    for (const s of room.sessions.values()) {
      if (!s.online && now - s.lastBeat > STALE_OFFLINE_MS) staleIds.push(s.id);
    }
    if (staleIds.length === 0) continue;
    for (const id of staleIds) {
      const session = room.sessions.get(id);
      if (!session) continue;
      room.sessions.delete(id);
      io.to(room.id).emit("peer:offline", {
        sessionId: id,
        name: session.name,
        reason: "left",
      });
      recordEvent({
        room,
        session,
        type: "leave",
        detail: "Mất kết nối lâu — đã rời phòng học",
      });
      prisma.session
        .update({ where: { id }, data: { leftAt: new Date() } })
        .catch(() => undefined);
      console.log(
        `[sweep] Dọn session zombie ${session.name} khỏi phòng ${room.id.slice(0, 8)}`
      );
    }
    room.lastActivity = now;
    broadcastRoomState(room);
    ownersBroadcast();
    scheduleAutoCloseIfEmpty(room);
  }
}, 60 * 1000).unref?.();

setInterval(() => {
  const now = nowMs();
  let changed = false;
  for (const [id, room] of rooms) {
    const hasOnline = Array.from(room.sessions.values()).some((s) => s.online);
    if (!hasOnline && now - room.lastActivity > ROOM_IDLE_MS) {
      clearAutoCloseTimer(room);
      rooms.delete(id);
      changed = true;
      console.log(`[sweep] Đã dọn phòng trống ${id} khỏi bộ nhớ`);
    }
  }
  if (changed) ownersBroadcast();
}, 10 * 60 * 1000).unref?.();

/* ========================================================================== */
/* 9. KHỞI ĐỘNG HAI MÁY CHỦ HTTP                                             */
/* ========================================================================== */

if (DEPLOY_PORT) {
  /* ---- CHẾ ĐỘ DEPLOY: MỘT cổng chung cho REST + Socket.IO ---- */
  httpServerAll.listen(DEPLOY_PORT, () => {
    console.log(`✔ Deploy một cổng : http://localhost:${DEPLOY_PORT}`);
    console.log(`✔ REST API       : ${"/api/*"} · Socket.IO: /socket.io/`);
    console.log("✔ Dịch vụ lớp học trực tuyến đã sẵn sàng chạy 24/24.");
    console.log("✔ Vai trò: member (chờ duyệt) · host (chủ phòng) · admin (chủ web).");
    if (process.env.OWNER_CODES) {
      console.log(`✔ Mã chủ web (OWNER_CODES): ${OWNER_CODES.join(" / ")}`);
    } else {
      console.log(
        `⚠ CHƯA đặt OWNER_CODES — mã chủ web NGẪU NHIÊN cho lần chạy này: ${OWNER_CODES.join(" / ")}`
      );
      console.log(
        "  → Muốn mã cố định: đặt OWNER_CODES=ABC-123 trong biến môi trường của nền tảng deploy."
      );
    }
  });
} else {
  /* ---- CHẾ ĐỘ LOCAL: hai cổng 3003 (Socket.IO) + 3004 (REST) ---- */
  app.listen(REST_PORT, () => {
    console.log(`✔ REST API   : http://localhost:${REST_PORT}/api/health`);
  });

  httpServerAll.listen(SIGNALING_PORT, () => {
    console.log(`✔ Socket.IO  : ws://localhost:${SIGNALING_PORT}/ (path "/")`);
    console.log("✔ Dịch vụ lớp học trực tuyến đã sẵn sàng chạy 24/24.");
    console.log("✔ Vai trò: member (chờ duyệt) · host (chủ phòng) · admin (chủ web).");
    if (process.env.OWNER_CODES) {
      console.log(
        `✔ Mã chủ web (OWNER_CODES): ${OWNER_CODES.join(" / ")}`
      );
    } else {
      console.log(
        `⚠ CHƯA đặt biến môi trường OWNER_CODES — mã chủ web NGẪU NHIÊN cho lần chạy này: ${OWNER_CODES.join(" / ")}`
      );
      console.log(
        "  → Muốn mã cố định: đặt OWNER_CODES=ABC-123 trong file .env hoặc biến môi trường."
      );
    }
  });
}

/* ---- Tắt máy chủ nhẹ nhàng (giữ dữ liệu an toàn) ---- */
function shutdown(signal: string) {
  console.log(`\nNhận tín hiệu ${signal} — đang đóng dịch vụ...`);
  io.close();
  httpServerAll.close();
  prisma
    .$disconnect()
    .finally(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
