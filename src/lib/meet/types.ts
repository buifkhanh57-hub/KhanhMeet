/**
 * ============================================================================
 *  LỚP HỌC TRỰC TUYẾN — KIỂU DỮ LIỆU DÙNG CHUNG GIỮA CLIENT VÀ DỊCH VỤ SIGNALING
 * ----------------------------------------------------------------------------
 *  File này phải GIỮ ĐỒNG BỘ 1-1 với khai báo interface bên trong
 *  `mini-services/signaling/index.ts`. Mọi thay đổi phải cập nhật cả hai nơi.
 * ============================================================================
 */

/**
 * Vai trò người dùng:
 *  - "member" — thành viên (học sinh): phải được CHỦ PHÒNG duyệt mới vào lớp.
 *  - "host"   — CHỦ PHÒNG (người tạo cuộc họp): duyệt vào lớp, kick, tắt mic/cam.
 *  - "admin"  — CHỦ WEB (người sáng tạo trang web): bảng điều khiển riêng.
 */
export type Role = "member" | "admin" | "host";

/**
 * KHOÁ ĐIỀU KHIỂN THIẾT BỊ (cam/mic) — theo yêu cầu CEO:
 * "BẬT là BẬT LUÔN, CẤM là CẤM LUÔN":
 *  - "none" : Tự do — thành viên tự bật/tắt thiết bị của mình.
 *  - "on"   : BẬT LUÔN — người điều hành bật thiết bị NGAY trên máy thành
 *             viên và khoá ở trạng thái bật (thành viên không tự tắt được).
 *  - "off"  : CẤM — thiết bị bị tắt NGAY và thành viên không thể tự bật lại
 *             (mọi cố gắng lách đều bị MÁY CHỦ chặn và ghi nhật ký).
 */
export type DeviceLock = "none" | "on" | "off";

/** Nhãn tiếng Việt của từng vai trò (hiển thị trên UI). */
export const ROLE_LABELS: Record<Role, string> = {
  member: "Thành viên",
  host: "Chủ phòng",
  admin: "Quản trị viên web",
};

/** Mức độ nghiêm trọng của sự kiện trong nhật ký hoạt động. */
export type Severity = "info" | "warning" | "critical";

/** Loại luồng media trong kết nối WebRTC. */
export type SignalMedia = "cam" | "screen";

/** Loại gói tin signaling WebRTC. */
export type SignalKind = "offer" | "answer" | "ice" | "bye";

/** Thông tin phiên người tham gia (dạng công khai, phát cho cả phòng). */
export interface PublicSession {
  id: string;
  name: string;
  role: Role;
  /** Thời điểm tham gia (Unix ms) — cập nhật khi kết nối lại. */
  joinTime: number;
  /** Camera đang bật. */
  camOn: boolean;
  /** Micro đang bật. */
  micOn: boolean;
  /** Khoá điều khiển camera hiện hành (none = tự do; on = bật luôn; off = cấm). */
  camLock: DeviceLock;
  /** Khoá điều khiển micro hiện hành (none = tự do; on = bật luôn; off = cấm). */
  micLock: DeviceLock;
  handRaised: boolean;
  screenSharing: boolean;
  /** Còn kết nối socket hay không (false = rớt mạng, chờ kết nối lại). */
  online: boolean;
  /** Độ trễ mạng (RTT, ms) do chính client đo qua heartbeat. */
  rtt: number | null;
}

/** Một tin nhắn chat trong phòng. */
export interface ChatMessage {
  id: string;
  sessionId: string;
  name: string;
  text: string;
  ts: number;
}

/** Ảnh chụp nhanh trạng thái phòng (phát qua sự kiện `room:state`). */
export interface RoomSnapshot {
  roomId: string;
  title: string;
  sessions: PublicSession[];
}

/** Ảnh chụp nhanh kèm lịch sử chat — chỉ trả về trong ACK của `room:join`. */
export interface RoomSnapshotWithChat extends RoomSnapshot {
  recentChat: ChatMessage[];
}

/** Tóm tắt một phòng trong danh sách của bảng điều khiển chủ web. */
export interface RoomSummary {
  id: string;
  title: string;
  memberCount: number;
  onlineCount: number;
  lastActivity: number;
}

/** Khoá lỗi có thể trả về khi tham gia phòng. */
export type JoinErrorKey =
  | "room-not-found"
  | "name-required"
  | "owner-key-invalid"
  | "host-key-invalid"
  | "room-full";

/** Kết quả tham gia phòng (ACK của `room:join`). */
export interface JoinAck {
  ok: boolean;
  /** true = đang CHỜ CHỦ PHÒNG DUYỆT (chưa vào được lớp). */
  pending?: boolean;
  error?: JoinErrorKey;
  session?: PublicSession;
  room?: RoomSnapshotWithChat;
}

/** Yêu cầu vào lớp đang chờ chủ phòng duyệt (phát tới host qua `host:join-request`). */
export interface JoinRequestPayload {
  sessionId: string;
  name: string;
  /** Thời điểm gõ cửa lớp (Unix ms). */
  requestedAt: number;
}

/** Kết quả xác thực mã chủ web (ACK của `owner:auth`). */
export interface OwnerAuthAck {
  ok: boolean;
  error?: "owner-key-invalid";
  rooms?: RoomSummary[];
}

/** Gói tin signaling gửi đi (client → server → peer đích). */
export interface OutgoingSignal {
  to: string;
  media: SignalMedia;
  kind: SignalKind;
  data?: unknown;
}

/** Gói tin signaling nhận về (server → client). */
export interface IncomingSignal {
  from: string;
  media: SignalMedia;
  kind: SignalKind;
  data?: unknown;
}

/** Một sự kiện trong nhật ký hoạt động của phòng. */
export interface EventPayload {
  id: number;
  roomId: string;
  sessionId: string | null;
  sessionName: string | null;
  type: string;
  detail: string | null;
  severity: Severity;
  ts: number;
}

/** Một ghi chú nhanh của chủ web về thành viên. */
export interface NotePayload {
  id: number;
  roomId: string;
  targetSessionId: string;
  targetName: string;
  authorName: string;
  content: string;
  ts: number;
}

/** Kết quả REST GET /api/rooms/:id — dùng ở sảnh chờ. */
export interface RoomInfoResponse {
  ok: boolean;
  exists: boolean;
  room?: {
    id: string;
    title: string;
    activeCount: number;
    /** Chủ phòng đang trực tuyến trong lớp chưa? */
    hostOnline?: boolean;
    /** Số người đang chờ được duyệt vào lớp. */
    waitingCount?: number;
    /** true = có người duyệt (chủ phòng/chủ web) ĐANG TRỰC TUYẾN → người mới
     *  PHẢI ĐƯỢC DUYỆT. Không ai duyệt online → vào thẳng, không chờ. */
    approvalRequired?: boolean;
  };
}

/** Kết quả REST POST /api/rooms — tạo phòng mới (trả về khoá chủ phòng). */
export interface CreateRoomResponse {
  ok: boolean;
  room?: {
    id: string;
    title: string;
  };
  /**
   * KHOÁ CHỦ PHÒNG — chỉ trả cho người tạo phòng đúng một lần; máy họ lưu
   * localStorage và dùng để vào lớp với vai trò "host". Không chia sẻ khoá
   * này cho bất kỳ ai — người có mỗi liên kết phòng là thành viên thường.
   */
  hostKey?: string;
  error?: string;
}

/* ========================================================================== */
/* CẤU HÌNH KẾT NỐI                                                          */
/* ========================================================================== */

/** Cổng Socket.IO của dịch vụ signaling (qua gateway: ?XTransformPort=3003). */
export const SIGNALING_PORT = 3003;

/** Cổng REST của dịch vụ signaling (qua gateway: ?XTransformPort=3004). */
export const REST_PORT = 3004;

/**
 * Máy chủ ICE giúp WebRTC xuyên NAT:
 *  • STUN: tìm địa chỉ công cộng — đủ khi hai máy cùng mạng LAN/WiFi.
 *  • TURN: TRUNG CHUYỂN thật sự khi hai máy khác mạng (điện thoại 4G ↔ WiFi
 *    nhà, NAT đối xứng, tường lửa công ty…) — không có TURN thì KHÔNG nghe,
 *    KHÔNG thấy nhau. Dùng Open Relay Project (miễn phí, mở cho mọi người,
 *    chạy cả UDP lẫn TCP trên cổng 80/443 nên xuyên được hầu hết tường lửa).
 */
export const ICE_SERVERS: RTCIceServer[] = [
  {
    urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun.cloudflare.com:3478",
    ],
  },
  {
    urls: [
      "turn:openrelay.metered.ca:80",
      "turn:openrelay.metered.ca:80?transport=tcp",
      "turn:openrelay.metered.ca:443",
      "turn:openrelay.metered.ca:443?transport=tcp",
    ],
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

/** Sinh UUID an toàn (fallback cho trình duyệt cũ không có crypto.randomUUID). */
export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * QUY TẮC XÁC ĐỊNH BÊN CHỦ ĐỘNG TẠO OFFER (chống glare / đua offer):
 *   1. Chủ web (admin) KHÔNG BAO GIỜ chủ động (chỉ nhận — người khác gửi tới).
 *   2. Thành viên & CHỦ PHÒNG luôn chủ động kết nối tới chủ web.
 *   3. Giữa hai người còn lại (thành viên/chủ phòng): người có sessionId
 *      nhỏ hơn (so sánh chuỗi) chủ động.
 * Quy tắc mang tính tất định (deterministic) nên hai phía không bao giờ
 * đồng thời gửi offer cho nhau — kể cả khi kết nối lại sau rớt mạng.
 */
export function shouldInitiateCam(
  selfId: string,
  selfRole: Role,
  other: Pick<PublicSession, "id" | "role">
): boolean {
  if (selfRole === "admin") return false; // Chủ web chỉ nhận offer
  if (other.role === "admin") return true; // Người khác luôn chủ động tới chủ web
  return selfId < other.id; // Hai người thường: id nhỏ hơn chủ động
}

/** Mô tả thân thiện cho từng loại sự kiện (hiển thị trên bảng điều khiển). */
export const EVENT_LABELS: Record<string, string> = {
  join: "Vào phòng",
  rejoin: "Kết nối lại",
  leave: "Rời phòng",
  disconnected: "Mất kết nối",
  kicked: "Bị mời ra khỏi phòng",
  "cam-on": "Bật camera",
  "cam-off": "Tắt camera",
  "mic-on": "Bật micro",
  "mic-off": "Tắt micro",
  "screen-share-start": "Bắt đầu chia sẻ màn hình",
  "screen-share-stop": "Dừng chia sẻ màn hình",
  "hand-raised": "Giơ tay",
  "hand-lowered": "Hạ tay",
  "warning-sent": "Gửi cảnh báo",
  "forced-mute": "Bị tắt tiếng từ xa",
  "forced-cam-off": "Bị tắt camera từ xa",
  "cam-request": "Yêu cầu bật camera",
  "cam-request-denied": "Từ chối yêu cầu bật camera",
  // Điều khiển thiết bị mới (BẬT LUÔN / CẤM / TRẢ QUYỀN):
  "cam-forced-on": "Bật camera từ xa (bật luôn)",
  "cam-forbidden": "Cấm camera",
  "cam-released": "Trả quyền camera",
  "mic-forced-on": "Bật micro từ xa (bật luôn)",
  "mic-forbidden": "Cấm micro",
  "mic-released": "Trả quyền micro",
  "cam-blocked": "Chặn thao tác camera",
  "mic-blocked": "Chặn thao tác micro",
  "device-error": "Lỗi mở thiết bị",
  "join-request": "Xin vào lớp (chờ duyệt)",
  "join-denied": "Bị từ chối vào lớp",
  "meeting-ended": "Tan lớp (kết thúc buổi học)",
  "meeting-auto-ended": "Tự kết thúc (phòng trống)",
};

/** Nhãn mức độ nghiêm trọng. */
export const SEVERITY_LABELS: Record<Severity, string> = {
  info: "Thông tin",
  warning: "Cảnh báo",
  critical: "Nghiêm trọng",
};
