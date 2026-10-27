/**
 * ============================================================================
 *  LỚP HỌC TRỰC TUYẾN — MEETING CLIENT (PHÍA NGƯỜI DÙNG)
 * ----------------------------------------------------------------------------
 *  Toàn bộ logic thời gian thực của một người trong lớp học:
 *    • Kết nối socket + tự động tham gia lại (auto-rejoin) sau rớt mạng.
 *    • Quản lý WebRTC mesh (qua PeerMesh) cho luồng cam/mic + chia sẻ màn hình.
 *    • Heartbeat 4s/lần đo RTT — hiển thị cho chủ web và cho chính mình.
 *    • Chat, giơ tay, bật/tắt cam-mic (tắt THẬT — track.enabled=false).
 *    • KHOÁ THIẾT BỊ từ chủ phòng/chủ web (theo yêu cầu CEO: "BẬT là BẬT
 *      LUÔN, CẤM là CẤM LUÔN"): nhận lệnh bật/tắt NGAY; khi bị khoá thì
 *      nút bật/tắt của mình bị chặn (máy chủ cũng chặn + ghi nhật ký).
 *    • Chia sẻ màn hình mượt (tối thiểu 60 fps): getDisplayMedia 1080p@60,
 *      contentHint "motion", sender 5 Mbps (xem mesh.ts).
 *    • THÀNH VIÊN vào lớp CÓ CHỦ PHÒNG → pha "waiting" chờ duyệt;
 *      bị từ chối → pha "denied"; được duyệt → vào thẳng lớp.
 *    • CHỦ PHÒNG (host): duyệt/từ chối người xin vào, ĐUỔI (kick), điều
 *      khiển cam/mic thành viên (bật luôn / cấm / trả quyền) từ xa.
 *    • Nhận cảnh báo/đuổi ra khỏi lớp từ chủ web (quyền tối cao).
 * ============================================================================
 */

import type { Socket } from "socket.io-client";
import { StateEmitter } from "./emitter";
import { createSignalingSocket, fetchIceServers } from "./signaling";
import { PeerMesh } from "./mesh";
import { playAlertBeep } from "./audio-meter";
import { ICE_SERVERS } from "./types";
import {
  generateId,
  shouldInitiateCam,
  type ChatMessage,
  type DeviceLock,
  type JoinAck,
  type JoinRequestPayload,
  type PublicSession,
  type Role,
  type RoomSnapshot,
  type RoomSnapshotWithChat,
  type SignalKind,
  type SignalMedia,
} from "./types";

/** Một thông báo nổi (toast) hiển thị trong phòng. */
export interface ToastItem {
  id: string;
  kind: "info" | "warning" | "success" | "error";
  message: string;
  /** Thời điểm tạo (Unix ms). */
  ts: number;
  /** Toast dính — không tự biến mất. */
  sticky?: boolean;
  /** Phải bấm "Đã hiểu" để tắt (dành cho cảnh báo của chủ web). */
  requireAck?: boolean;
}

/** Trạng thái đầy đủ của phiên học phía người dùng. */
export interface MeetingState {
  phase:
    | "joining"
    | "connected"
    | "reconnecting"
    | "left"
    | "kicked"
    | "error"
    | "waiting" // Đang chờ CHỦ PHÒNG duyệt vào lớp.
    | "denied"; // Bị chủ phòng từ chối vào lớp.
  error: string | null;
  /** Lỗi kết nối tạm thời (mất mạng) — hiển thị banner nhưng không rời phòng. */
  connectionError: string | null;
  selfId: string;
  roomTitle: string;
  sessions: PublicSession[];
  chat: ChatMessage[];
  unreadChat: number;
  localStream: MediaStream | null;
  /** Luồng cam/mic remote, khóa = sessionId. */
  remoteStreams: Record<string, MediaStream>;
  /** Luồng chia sẻ màn hình remote, khóa = sessionId. */
  screenStreams: Record<string, MediaStream>;
  myScreenStream: MediaStream | null;
  /** Trạng thái RTCPeerConnection theo sessionId (luồng cam). */
  peerStates: Record<string, RTCPeerConnectionState>;
  camOn: boolean;
  micOn: boolean;
  /** Khoá điều khiển camera của CHÍNH MÌNH (none = tự do; on = bị chủ phòng
   *  bật luôn — không tự tắt được; off = bị cấm — không tự bật được). */
  camLock: DeviceLock;
  /** Khoá điều khiển micro của chính mình (ý nghĩa như camLock). */
  micLock: DeviceLock;
  handRaised: boolean;
  rtt: number | null;
  socketConnected: boolean;
  toasts: ToastItem[];
  /** Mình là CHỦ PHÒNG (người tạo cuộc họp)? */
  isHost: boolean;
  /** Hàng chờ "gõ cửa lớp" — chỉ chủ phòng dùng. */
  joinRequests: JoinRequestPayload[];
  /** Thời điểm bắt đầu chờ duyệt (Unix ms) — null nếu không đang chờ. */
  waitingSince: number | null;
}

export interface MeetingClientOptions {
  roomId: string;
  name: string;
  /** Vai trò: "member" (mặc định) hoặc "host" (người tạo cuộc họp). */
  role?: Role;
  /** KHOÁ CHỦ PHÒNG — dùng khi role = "host" để chứng minh mình là chủ. */
  hostKey?: string | null;
  /** Luồng getUserMedia lấy ở sảnh chờ (null nếu vào phòng không thiết bị). */
  localStream: MediaStream | null;
  initialCamOn: boolean;
  initialMicOn: boolean;
}

const HEARTBEAT_INTERVAL_MS = 4000;

export class MeetingClient extends StateEmitter<MeetingState> {
  private socket: Socket | null = null;
  private mesh: PeerMesh;
  private sessionId: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Đã từng join thành công (phân biệt lần đầu với lần kết nối lại). */
  private everJoined = false;
  /** Đang chủ động rời phòng — bỏ mọi nghiệp vụ dọn dẹp thừa. */
  private leaving = false;
  /** Những sessionId mình đã thiết lập/khai báo kết nối (chống đàm phán trùng). */
  private connectedIds = new Set<string>();
  /** Loại thiết bị đang trong quá trình xin mở (chống bấm dồn tạo nhiều getUserMedia). */
  private acquiring = new Set<"video" | "audio">();
  /** Loại thiết bị đang mở THEO LỆNH BẬT LUÔN của chủ phòng — nếu thất bại
   *  thì báo về máy chủ ghi sự kiện "device-error" cho chủ phòng biết. */
  private forcedAcquire = new Set<"video" | "audio">();
  /** Lần dựng lại kết nối WebRTC gần nhất theo sessionId (cooldown 15 giây). */
  private rebuildAt = new Map<string, number>();

  /**
   * Danh sách STUN/TURN dùng khi tạo peer connection mới. Bắt đầu bằng danh
   * sách tĩnh mặc định, rồi TỰ NẠP danh sách tốt hơn từ máy chủ signaling
   * (Cloudflare TURN nếu chủ web cấu hình) ngay khi trang vừa tải — trước khi
   * các peer xuất hiện. Lỗi mạng → giữ nguyên mặc định, không chặn vào lớp.
   */
  private iceServers: RTCIceServer[] = ICE_SERVERS;

  constructor(private opts: MeetingClientOptions) {
    super({
      phase: "joining",
      error: null,
      connectionError: null,
      selfId: "",
      roomTitle: "",
      sessions: [],
      chat: [],
      unreadChat: 0,
      localStream: opts.localStream,
      remoteStreams: {},
      screenStreams: {},
      myScreenStream: null,
      peerStates: {},
      camOn: opts.initialCamOn,
      micOn: opts.initialMicOn,
      handRaised: false,
      rtt: null,
      socketConnected: false,
      toasts: [],
      isHost: opts.role === "host",
      joinRequests: [],
      waitingSince: null,
      camLock: "none",
      micLock: "none",
    });

    // sessionId ổn định lưu theo phòng trong sessionStorage → tải lại trang
    // (F5) giữa buổi học sẽ TỰ ĐỘNG kết nối lại đúng phiên cũ.
    const storageKey = `km-session:${opts.roomId}`;
    try {
      const saved = sessionStorage.getItem(storageKey);
      this.sessionId = saved && saved.length >= 8 ? saved : generateId();
      sessionStorage.setItem(storageKey, this.sessionId);
    } catch {
      this.sessionId = generateId();
    }

    this.mesh = new PeerMesh({
      selfId: this.sessionId,
      selfRole: opts.role === "host" ? "host" : "member",
      getIceServers: () => this.iceServers,
      localStream: opts.localStream,
      sendSignal: (to, media, kind, data) => {
        this.socket?.emit("webrtc:signal", { to, media, kind, data });
      },
      onRemoteStream: (sessionId, media, stream) => {
        if (media === "cam") {
          const next = { ...this.state.remoteStreams };
          if (stream) next[sessionId] = stream;
          else delete next[sessionId];
          this.setState({ remoteStreams: next });
        } else {
          const next = { ...this.state.screenStreams };
          if (stream) next[sessionId] = stream;
          else delete next[sessionId];
          this.setState({ screenStreams: next });
        }
      },
      onPeerState: (sessionId, media, pcState) => {
        if (media !== "cam") return;
        this.setState({
          peerStates: { ...this.state.peerStates, [sessionId]: pcState },
        });
      },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* KẾT NỐI & THAM GIA PHÒNG                                                */
  /* ---------------------------------------------------------------------- */

  connect(): void {
    // Nạp danh sách STUN/TURN mới nhất từ máy chủ signaling (nếu chủ web đã
    // cấu hình Cloudflare TURN thì đây là đường truyền bền nhất cho các mạng
    // NAT khó ở Việt Nam). Không chặn luồng vào lớp — PC nào tạo trước lúc
    // nạp xong dùng danh sách mặc định, các PC sau dùng danh sách mới.
    fetchIceServers()
      .then((servers) => {
        if (servers && servers.length > 0) this.iceServers = servers;
      })
      .catch(() => {
        /* Giữ danh sách mặc định. */
      });

    const socket = createSignalingSocket();
    this.socket = socket;

    /* --- Socket đã kết nối (cả lần đầu và các lần kết nối lại) --- */
    socket.on("connect", () => {
      this.setState({ socketConnected: true, connectionError: null });
      if (this.everJoined) {
        // KẾT NỐI LẠI: dựng lại WebRTC từ đầu cho tất định, rồi join lại
        // với đúng sessionId cũ → máy chủ tái gắn phiên, không mất dấu.
        this.mesh.closeAll();
        this.connectedIds.clear();
        // Xoá CẢ DANH SÁCH PHIÊN CŨ: nếu còn sót, applyRoomState thấy mọi
        // người là "đã có sẵn" → không dựng lại kết nối nào → mesh trống
        // trơn → vào lại KHÔNG THẤY, KHÔNG NGHE được ai (lỗi đã bị báo).
        this.setState({
          remoteStreams: {},
          screenStreams: {},
          peerStates: {},
          sessions: [],
        });
        this.emitJoin();
      } else {
        // Lần đầu kết nối — tham gia phòng ngay trên nền tảng vừa nối xong.
        this.emitJoin();
      }
    });

    socket.on("disconnect", (reason) => {
      this.setState({ socketConnected: false });
      if (this.state.phase === "connected") {
        this.setState({
          phase: "reconnecting",
          connectionError: `Mất kết nối tới máy chủ (${reason}) — đang thử lại…`,
        });
      }
    });

    socket.on("connect_error", () => {
      this.setState({
        socketConnected: false,
        connectionError:
          "Không kết nối được máy chủ — kiểm tra mạng, đang thử lại tự động…",
      });
    });

    /* --- Trạng thái phòng thay đổi (sessions/title) --- */
    socket.on("room:state", (snap: RoomSnapshot) => {
      this.applyRoomState(snap);
    });

    /* --- Có người mới vào / kết nối lại --- */
    socket.on("peer:online", (payload: { session: PublicSession }) => {
      if (!payload?.session) return;
      this.handlePeerOnline(payload.session);
    });

    /* --- Có người rời / mất mạng --- */
    socket.on(
      "peer:offline",
      (payload: { sessionId: string; name: string; reason: string }) => {
        if (!payload?.sessionId) return;
        this.handlePeerOffline(payload.sessionId, payload.name, payload.reason);
      }
    );

    /* --- Trung chuyển WebRTC --- */
    socket.on("webrtc:signal", (sig: {
      from: string;
      media: SignalMedia;
      kind: SignalKind;
      data?: unknown;
    }) => {
      void this.mesh.handleSignal(sig);
    });

    /* --- Chat --- */
    socket.on("chat:message", (msg: ChatMessage) => {
      this.setState({
        chat: [...this.state.chat, msg].slice(-300),
        unreadChat: this.state.unreadChat + 1,
      });
    });

    /* --- CẢNH BÁO từ chủ web: toast đỏ dính + bíp cảnh báo --- */
    socket.on("warning", (payload: { message: string }) => {
      playAlertBeep();
      this.pushToast({
        kind: "warning",
        message: `CẢNH BÁO TỪ CHỦ WEB: ${payload?.message ?? ""}`,
        sticky: true,
        requireAck: true,
      });
    });

    /* --- NGƯỜI ĐIỀU HÀNH (chủ phòng/chủ web) ĐIỀU KHIỂN THIẾT BỊ CỦA MÌNH ---
     * Theo yêu cầu CEO: "BẬT là BẬT LUÔN, CẤM là CẤM LUÔN" — lệnh tới là
     * thi hành NGAY trên máy mình (bật: mở thiết bị nếu chưa có; cấm: tắt
     * track thật). Kèm khoá: bị cấm thì không tự bật lại được, bị bật luôn
     * thì không tự tắt được (máy chủ cũng chặn — ở đây chỉ là UX + toast). */

    // BẬT LUÔN camera: bật track sẵn có, chưa có thì tự xin mở thiết bị.
    socket.on("force:cam-on", (payload: { by?: string }) => {
      this.setState({ camLock: "on" });
      const track = this.liveTracks("video")[0];
      if (track) {
        track.enabled = true;
        this.setState({ camOn: true });
        this.socket?.emit("state:update", { camOn: true });
      } else {
        // Chưa có camera sống → xin mở ngay giữa buổi họp.
        this.forcedAcquire.add("video");
        void this.acquireDevice("video");
      }
      this.pushToast({
        kind: "warning",
        message: `${payload?.by ?? "Chủ phòng"} đã BẬT camera của bạn (bật luôn — bạn không thể tự tắt).`,
      });
    });

    // CẤM camera: tắt NGAY + khoá — không thể tự bật lại.
    socket.on("force:cam-off", (payload: { by?: string; locked?: boolean }) => {
      const locked = payload?.locked !== false;
      for (const track of this.liveTracks("video")) track.enabled = false;
      this.setState({ camOn: false, camLock: locked ? "off" : "none" });
      this.socket?.emit("state:update", { camOn: false });
      this.pushToast({
        kind: locked ? "warning" : "info",
        message: locked
          ? `${payload?.by ?? "Chủ phòng"} đã CẤM camera của bạn — bạn không thể tự bật lại.`
          : `${payload?.by ?? "Chủ phòng"} đã tắt camera của bạn.`,
      });
    });

    // BẬT LUÔN micro (đối xứng với camera).
    socket.on("force:mic-on", (payload: { by?: string }) => {
      this.setState({ micLock: "on" });
      const track = this.liveTracks("audio")[0];
      if (track) {
        track.enabled = true;
        this.setState({ micOn: true });
        this.socket?.emit("state:update", { micOn: true });
      } else {
        this.forcedAcquire.add("audio");
        void this.acquireDevice("audio");
      }
      this.pushToast({
        kind: "warning",
        message: `${payload?.by ?? "Chủ phòng"} đã BẬT micro của bạn (bật luôn — bạn không thể tự tắt).`,
      });
    });

    // CẤM micro: tắt tiếng NGAY + khoá — không thể tự bật lại.
    socket.on("force:mic-off", (payload: { by?: string; locked?: boolean }) => {
      const locked = payload?.locked !== false;
      for (const track of this.liveTracks("audio")) track.enabled = false;
      this.setState({ micOn: false, micLock: locked ? "off" : "none" });
      this.socket?.emit("state:update", { micOn: false });
      this.pushToast({
        kind: locked ? "warning" : "info",
        message: locked
          ? `${payload?.by ?? "Chủ phòng"} đã CẤM micro của bạn — bạn không thể tự bật lại.`
          : `${payload?.by ?? "Chủ phòng"} đã tắt tiếng micro của bạn.`,
      });
    });

    // TRẢ QUYỀN: mở khoá thiết bị, mình tự chủ lại từ giờ.
    socket.on("cam:released", (payload: { by?: string }) => {
      this.setState({ camLock: "none" });
      this.pushToast({
        kind: "info",
        message: `${payload?.by ?? "Chủ phòng"} đã trả quyền điều khiển camera cho bạn.`,
      });
    });
    socket.on("mic:released", (payload: { by?: string }) => {
      this.setState({ micLock: "none" });
      this.pushToast({
        kind: "info",
        message: `${payload?.by ?? "Chủ phòng"} đã trả quyền điều khiển micro cho bạn.`,
      });
    });

    /* --- Máy chủ TỪ CHỐI thao tác vì vi phạm khoá (client bị sửa/lách) --- */
    socket.on(
      "lock:rejected",
      (payload: { device?: "cam" | "mic"; action?: "on" | "off" }) => {
        const dev =
          payload?.device === "mic" ? "micro" : "camera";
        const verb = payload?.action === "off" ? "tắt" : "bật";
        this.pushToast({
          kind: "error",
          message: `Không thể ${verb} ${dev} — thiết bị đang bị chủ phòng ${
            payload?.action === "off" ? "bật luôn" : "cấm"
          }.`,
        });
        // Đồng bộ lại theo máy chủ (trọng tài).
        this.syncSelfFromSessions();
      }
    );

    /* --- Bị mời ra khỏi lớp --- */
    socket.on("kicked", (payload: { reason: string }) => {
      this.setState({ phase: "kicked", error: payload?.reason ?? null });
      this.teardownMedia();
      this.mesh.destroy();
      this.socket?.disconnect();
    });

    /* --- CHỜ DUYỆT: chủ phòng vừa ĐỒNG Ý → vào lớp ngay --- */
    socket.on(
      "join:approved",
      (payload: { session?: PublicSession; room?: RoomSnapshotWithChat }) => {
        if (this.state.phase !== "waiting") return;
        this.handleJoinSuccess(payload ?? {}, !this.everJoined);
      }
    );

    /* --- CHỜ DUYỆT: bị TỪ CHỐI → màn hình "bị từ chối" --- */
    socket.on("join:denied", (payload: { reason?: string }) => {
      this.setState({
        phase: "denied",
        error:
          payload?.reason ?? "Chủ phòng đã từ chối yêu cầu vào lớp của bạn.",
      });
      this.teardownMedia();
      this.mesh.destroy();
      this.socket?.disconnect();
    });

    /* --- Lớp đã tan / phòng bị đóng khi mình còn trong lớp hoặc đang chờ --- */
    socket.on("room:closed", (payload: { reason?: string }) => {
      if (
        this.state.phase === "left" ||
        this.state.phase === "denied" ||
        this.state.phase === "error"
      ) {
        return;
      }
      this.setState({
        phase: "error",
        error: payload?.reason ?? "Buổi học đã kết thúc.",
      });
      this.teardownMedia();
      this.mesh.destroy();
      this.socket?.disconnect();
    });

    /* --- CHỦ PHÒNG: có người gõ cửa lớp (xin vào) --- */
    socket.on(
      "host:join-request",
      (payload: { request?: JoinRequestPayload }) => {
        const req = payload?.request;
        if (!req?.sessionId) return;
        const kept = this.state.joinRequests.filter(
          (r) => r.sessionId !== req.sessionId
        );
        this.setState({
          joinRequests: [
            ...kept,
            { sessionId: req.sessionId, name: req.name, requestedAt: req.requestedAt },
          ],
        });
        this.pushToast({
          kind: "info",
          message: `${req.name} xin vào lớp — mở "Người tham gia" để duyệt.`,
        });
      }
    );

    /* --- CHỦ PHÒNG: người xin vào đã rút lui / hết chờ --- */
    socket.on("host:join-cancel", (payload: { sessionId?: string }) => {
      if (!payload?.sessionId) return;
      this.setState({
        joinRequests: this.state.joinRequests.filter(
          (r) => r.sessionId !== payload.sessionId
        ),
      });
    });

    /* --- Heartbeat 24/24 --- */
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket?.connected) return;
      this.socket.emit("heartbeat", { t: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);

    socket.on("heartbeat:ack", (payload: { t: number }) => {
      const rtt = Math.max(0, Date.now() - (payload?.t ?? Date.now()));
      this.setState({ rtt });
      if (this.socket?.connected) {
        this.socket.emit("rtt:report", { rtt });
      }
    });
  }

  /**
   * Gửi yêu cầu tham gia phòng — gọi trên MỖI lần socket `connect`
   * (lần đầu và mọi lần kết nối lại; máy chủ xử lý idempotent theo sessionId).
   * Với vai trò "host" sẽ gửi kèm KHOÁ CHỦ PHÒNG để chứng minh quyền.
   */
  private emitJoin(): void {
    if (!this.socket) return;
    this.socket.emit(
      "room:join",
      {
        roomId: this.opts.roomId,
        name: this.opts.name,
        role: this.opts.role === "host" ? "host" : "member",
        hostKey: this.opts.hostKey ?? undefined,
        sessionId: this.sessionId,
        camOn: this.state.camOn,
        micOn: this.state.micOn,
      },
      (ack: JoinAck) => {
        // CHỜ CHỦ PHÒNG DUYỆT: giữ nguyên socket để nhận join:approved/denied.
        if (ack?.ok && ack.pending) {
          this.setState({
            phase: "waiting",
            waitingSince: Date.now(),
            error: null,
            connectionError: null,
          });
          return;
        }
        if (ack?.ok && ack.room) {
          this.handleJoinSuccess(ack, !this.everJoined);
        } else {
          const messages: Record<string, string> = {
            "room-not-found": "Không tìm thấy phòng — liên kết không đúng hoặc đã hết hạn.",
            "name-required": "Tên không hợp lệ, hãy thử tham gia lại.",
            "room-full": "Phòng đã đủ sĩ số tối đa.",
            "owner-key-invalid": "Không có quyền tham gia với vai trò này.",
            "host-key-invalid":
              "Khoá chủ phòng không còn hợp lệ — phòng có thể đã bị đóng.",
          };
          this.setState({
            phase: "error",
            error:
              messages[ack?.error ?? ""] ??
              "Không thể tham gia phòng. Vui lòng thử lại.",
          });
        }
      }
    );
  }

  /** Xử lý payload "vào lớp thành công" (từ ACK hoặc sự kiện join:approved). */
  private handleJoinSuccess(
    payload: { session?: PublicSession; room?: RoomSnapshotWithChat },
    firstJoin: boolean
  ): void {
    this.everJoined = true;
    this.setState({
      phase: "connected",
      selfId: this.sessionId,
      error: null,
      connectionError: null,
      waitingSince: null,
    });

    // Đồng bộ trạng thái cam/mic THẬT với máy chủ (máy chủ có thể đang ghi
    // mặc định bật trong khi mình vào lớp không có thiết bị).
    this.socket?.emit("state:update", {
      camOn: this.state.camOn,
      micOn: this.state.micOn,
    });
    if (payload.room?.recentChat) {
      this.setState({ chat: payload.room.recentChat });
    }
    // Áp dụng danh sách phiên hiện có (dựng WebRTC tới những người trước đó).
    if (payload.room) {
      this.applyRoomState(payload.room);
    }
    if (!firstJoin) {
      this.pushToast({
        kind: "success",
        message: "Đã tự động kết nối lại sau gián đoạn mạng.",
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* ĐỒNG BỘ DANH SÁCH SESSION & KẾT NỐI WEBRTC                              */
  /* ---------------------------------------------------------------------- */

  /** Áp dụng ảnh chụp phòng: cập nhật state + dựng WebRTC cho người mới. */
  private applyRoomState(snap: RoomSnapshot): void {
    if (!snap) return;
    const prevById = new Map(this.state.sessions.map((s) => [s.id, s]));

    // Người mới xuất hiện / online trở lại sau rớt mạng / kết nối WebRTC
    // đã chết → (re)kết nối theo quy tắc offer tất định.
    for (const session of snap.sessions) {
      if (session.id === this.sessionId) continue;
      if (!session.online) continue;
      const prev = prevById.get(session.id);
      const isNew = !prev;
      const backOnline = Boolean(prev && !prev.online && session.online);
      if (isNew || backOnline) {
        // Peer cũ của người vừa quay lại gần như chắc chắn đã chết — dọn
        // sạch rồi dựng lại để hai bên đồng bộ trạng thái đàm phán.
        if (backOnline) this.dropPeerCompletely(session.id);
        this.connectWith(session);
        continue;
      }
      // Kết nối "failed" (ICE restart không cứu được) → dựng lại, mỗi 15 giây
      // tối đa một lần cho một người (tránh vòng lặp dồn dập).
      const pcState = this.state.peerStates[session.id];
      if (pcState === "failed") {
        const last = this.rebuildAt.get(session.id) ?? 0;
        if (Date.now() - last > 15_000) {
          this.rebuildAt.set(session.id, Date.now());
          this.dropPeerCompletely(session.id);
          this.connectWith(session);
        }
      }
    }

    // Người biến khỏi danh sách → dọn kết nối & luồng.
    for (const prev of prevById.values()) {
      if (prev.id === this.sessionId) continue;
      if (!snap.sessions.some((s) => s.id === prev.id)) {
        this.dropPeerCompletely(prev.id);
        this.rebuildAt.delete(prev.id);
      }
    }

    this.setState({
      sessions: snap.sessions,
      roomTitle: snap.title,
    });

    // Đồng bộ KHOÁ THIẾT BỊ của chính mình theo máy chủ (trọng tài):
    // chủ phòng cấm/bật luôn khi mình đang load lại trang cũng phải ăn kịp.
    const self = snap.sessions.find((s) => s.id === this.sessionId);
    if (self && (self.camLock !== this.state.camLock || self.micLock !== this.state.micLock)) {
      this.setState({ camLock: self.camLock, micLock: self.micLock });
    }
  }

  /** Đồng bộ lại cam/mic/khoá của chính mình theo danh sách phiên mới nhất
   *  từ máy chủ (dùng khi máy chủ vừa TỪ CHỐI một thao tác vi phạm khoá). */
  private syncSelfFromSessions(): void {
    const self = this.state.sessions.find((s) => s.id === this.sessionId);
    if (!self) return;
    this.setState({
      camOn: self.camOn,
      micOn: self.micOn,
      camLock: self.camLock,
      micLock: self.micLock,
    });
  }

  /** Thiết lập kết nối cam (+screen nếu mình đang chia sẻ) tới một session. */
  private async connectWith(session: PublicSession): Promise<void> {
    if (session.id === this.sessionId) return;
    if (this.connectedIds.has(session.id)) return; // đã xử lý rồi
    this.connectedIds.add(session.id);
    const selfRole: Role = this.opts.role === "host" ? "host" : "member";
    if (shouldInitiateCam(this.sessionId, selfRole, session)) {
      await this.mesh.connectTo(session);
    }
    if (this.state.myScreenStream) {
      await this.mesh.connectScreenTo(session, this.state.myScreenStream);
    }
  }

  /** Xoá sạch một peer khỏi state + mesh (khi họ rời hẳn). */
  private dropPeerCompletely(sessionId: string): void {
    this.connectedIds.delete(sessionId);
    this.mesh.closePeer(sessionId);
    const remoteStreams = { ...this.state.remoteStreams };
    const screenStreams = { ...this.state.screenStreams };
    const peerStates = { ...this.state.peerStates };
    delete remoteStreams[sessionId];
    delete screenStreams[sessionId];
    delete peerStates[sessionId];
    this.setState({ remoteStreams, screenStreams, peerStates });
  }

  private handlePeerOnline(session: PublicSession): void {
    // peer:online có thể là người mới HOẶC người vừa kết nối lại sau rớt mạng.
    // Đóng peer cũ (nếu có) rồi dựng lại tất định theo quy tắc offer.
    this.mesh.closePeer(session.id);
    this.connectedIds.delete(session.id);
    const remoteStreams = { ...this.state.remoteStreams };
    const screenStreams = { ...this.state.screenStreams };
    delete remoteStreams[session.id];
    delete screenStreams[session.id];
    this.setState({ remoteStreams, screenStreams });
    void this.connectWith(session);
    this.pushToast({ kind: "info", message: `${session.name} đã vào phòng.` });
  }

  private handlePeerOffline(
    sessionId: string,
    name: string,
    reason: string
  ): void {
    if (reason === "disconnected") {
      // Mất socket nhưng WebRTC có thể vẫn đang chạy — KHÔNG đóng peer,
      // chỉ hiển thị trạng thái chờ (session.online=false qua room:state).
      this.pushToast({
        kind: "warning",
        message: `${name} mất kết nối — đang chờ kết nối lại…`,
      });
      return;
    }
    this.dropPeerCompletely(sessionId);
    this.pushToast({
      kind: "info",
      message:
        reason === "kicked"
          ? `${name} đã bị quản trị viên mời ra khỏi phòng.`
          : `${name} đã rời phòng học.`,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* CÁC HÀNH ĐỘNG CỦA THÀNH VIÊN                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Bật/tắt camera — TẮT THẬT: track.enabled=false khiến luồng gửi
   * khung hình đen cho mọi người (không có luồng ngầm nào phía sau).
   * BẬT lại mà không còn track sống (vào lớp chưa có camera / thiết bị vừa
   * mất / track đã "ended") → TỰ ĐỘNG xin mở camera mới rồi gắn vào mọi
   * peer — bấm liên tục cũng không bao giờ kẹt "không bật lại được".
   * ĐANG BỊ KHOÁ BỞI CHỦ PHÒNG → chặn tại chỗ + toast giải thích
   * (máy chủ cũng chặn — đây chỉ là lớp UX).
   */
  toggleCam(): void {
    if (this.state.camLock === "off") {
      this.pushToast({
        kind: "error",
        message: "Camera đang bị CHỦ PHÒNG CẤM — bạn không thể tự bật lại.",
      });
      return;
    }
    if (this.state.camLock === "on") {
      this.pushToast({
        kind: "warning",
        message:
          "Camera đang được chủ phòng BẬT LUÔN — bạn không thể tự tắt. Hãy nhắn chủ phòng nếu cần.",
      });
      return;
    }
    const next = !this.state.camOn;
    if (!next) {
      for (const track of this.liveTracks("video")) track.enabled = false;
      this.setState({ camOn: false });
      this.socket?.emit("state:update", { camOn: false });
      return;
    }
    const track = this.liveTracks("video")[0] ?? null;
    if (track) {
      track.enabled = true;
      this.setState({ camOn: true });
      this.socket?.emit("state:update", { camOn: true });
      return;
    }
    // Chưa có camera nào sống → xin mở thiết bị ngay giữa cuộc họp.
    void this.acquireDevice("video");
  }

  /** Bật/tắt micro — chống kẹt giống toggleCam + chặn khi bị khoá. */
  toggleMic(): void {
    if (this.state.micLock === "off") {
      this.pushToast({
        kind: "error",
        message: "Micro đang bị CHỦ PHÒNG CẤM — bạn không thể tự bật lại.",
      });
      return;
    }
    if (this.state.micLock === "on") {
      this.pushToast({
        kind: "warning",
        message:
          "Micro đang được chủ phòng BẬT LUÔN — bạn không thể tự tắt. Hãy nhắn chủ phòng nếu cần.",
      });
      return;
    }
    const next = !this.state.micOn;
    if (!next) {
      for (const track of this.liveTracks("audio")) track.enabled = false;
      this.setState({ micOn: false });
      this.socket?.emit("state:update", { micOn: false });
      return;
    }
    const track = this.liveTracks("audio")[0] ?? null;
    if (track) {
      track.enabled = true;
      this.setState({ micOn: true });
      this.socket?.emit("state:update", { micOn: true });
      return;
    }
    void this.acquireDevice("audio");
  }

  /** Các track CÒN SỐNG (readyState ≠ "ended") của một loại trong luồng cục bộ. */
  private liveTracks(kind: "video" | "audio"): MediaStreamTrack[] {
    const stream = this.state.localStream;
    if (!stream) return [];
    return (kind === "video" ? stream.getVideoTracks() : stream.getAudioTracks())
      .filter((t) => t.readyState !== "ended");
  }

  /**
   * XIN MỞ CAMERA/MICRO GIỮA CUỘC HỌP (khi vào lớp chưa có thiết bị hoặc
   * thiết bị vừa mất): getUserMedia đúng loại → gộp vào luồng hiện có →
   * replaceTrack cho mọi peer; peer nào chưa có đường gửi loại này thì dựng
   * lại kết nối cam (force offer) để track mới tới được tay mọi người.
   * Có cờ chống bấm dồn (mỗi loại chỉ xin một lần cùng lúc).
   */
  private async acquireDevice(kind: "video" | "audio"): Promise<void> {
    if (this.acquiring.has(kind)) return;
    this.acquiring.add(kind);
    try {
      const constraints: MediaStreamConstraints =
        kind === "video" ? { video: true, audio: false } : { video: false, audio: true };
      const partial = await navigator.mediaDevices.getUserMedia(constraints);
      const newTrack =
        kind === "video" ? partial.getVideoTracks()[0] : partial.getAudioTracks()[0];
      if (!newTrack) return;

      // Gộp track mới vào luồng cục bộ (giữ nguyên track loại kia).
      const oldStream = this.state.localStream;
      const keptTracks = (oldStream?.getTracks() ?? []).filter(
        (t) => t.kind !== kind
      );
      const merged = new MediaStream([...keptTracks, newTrack]);
      this.mesh.replaceLocalStream(merged);
      // Dừng track cũ cùng loại (track ended không dùng lại được).
      for (const t of oldStream?.getTracks() ?? []) {
        if (t.kind === kind) t.stop();
      }

      // Peer nào CHƯA CÓ đường gửi loại này (vào lớp lúc chưa có thiết bị →
      // không có m-line tương ứng) → replaceTrack không tới được → dựng lại
      // kết nối cam bằng offer mới mang đủ track.
      for (const session of this.state.sessions) {
        if (session.id === this.sessionId || !session.online) continue;
        if (!this.mesh.hasSenderOf(session.id, kind)) {
          this.mesh.closePeer(session.id, "cam");
          this.connectedIds.delete(session.id);
          await this.mesh.connectTo(session); // force offer — nhận bên kia tự dựng lại
          this.connectedIds.add(session.id);
        }
      }

      this.setState({
        localStream: merged,
        ...(kind === "video" ? { camOn: true } : { micOn: true }),
      });
      this.forcedAcquire.delete(kind); // Đã mở thành công theo lệnh — dọn cờ.
      this.socket?.emit(
        "state:update",
        kind === "video" ? { camOn: true } : { micOn: true }
      );
      this.pushToast({
        kind: "success",
        message:
          kind === "video"
            ? "Đã bật camera."
            : "Đã bật micro.",
      });
    } catch (err) {
      console.error("[meeting] mở thiết bị lỗi:", err);
      // Mở THEO LỆNH BẬT LUÔN của chủ phòng mà thất bại → báo về máy chủ
      // ghi nhật ký "device-error" để chủ phòng/chủ web nhìn thấy.
      if (this.forcedAcquire.has(kind)) {
        this.socket?.emit("device:acquire-failed", {
          device: kind === "video" ? "cam" : "mic",
          reason: err instanceof Error ? err.message : "không rõ",
        });
        this.forcedAcquire.delete(kind);
      }
      this.pushToast({
        kind: "error",
        message:
          kind === "video"
            ? "Không mở được camera — kiểm tra quyền truy cập hoặc thiết bị đang bị chiếm."
            : "Không mở được micro — kiểm tra quyền truy cập hoặc thiết bị đang bị chiếm.",
      });
    } finally {
      this.acquiring.delete(kind);
    }
  }

  /** Giơ tay / hạ tay — badge bàn tay vàng hiện trên ô video của mình. */
  toggleHand(): void {
    const handRaised = !this.state.handRaised;
    this.setState({ handRaised });
    this.socket?.emit("state:update", { handRaised });
  }

  /**
   * Bắt đầu chia sẻ màn hình (getDisplayMedia).
   * Rất mượt — TỐI THIỂU 60 FPS: yêu cầu 1080p@60; mesh đặt contentHint
   * "motion" + sender 5 Mbps + degradationPreference "balanced" (mesh.ts).
   */
  async startScreenShare(): Promise<void> {
    if (this.state.myScreenStream) return;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60, max: 60 },
        },
        audio: true, // Bao gồm cả âm thanh tab nếu người dùng chọn
      });
      this.setState({ myScreenStream: stream });
      for (const session of this.state.sessions) {
        if (session.id === this.sessionId || !session.online) continue;
        await this.mesh.connectScreenTo(session, stream);
      }
      this.socket?.emit("state:update", { screenSharing: true });
      // Người dùng bấm nút "Dừng chia sẻ" của chính trình duyệt.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        this.stopScreenShare();
      });
    } catch (err) {
      console.error("[meeting] getDisplayMedia lỗi:", err);
      this.pushToast({
        kind: "error",
        message: "Không thể bắt đầu chia sẻ màn hình (bị từ chối hoặc lỗi hệ thống).",
      });
    }
  }

  /** Dừng chia sẻ màn hình và báo mọi peer đóng luồng. */
  stopScreenShare(): void {
    const stream = this.state.myScreenStream;
    this.mesh.markScreenStopped();
    for (const track of stream?.getTracks() ?? []) track.stop();
    this.setState({ myScreenStream: null });
    this.socket?.emit("state:update", { screenSharing: false });
  }

  /**
   * Đổi thiết bị (camera/micro) giữa cuộc họp: getUserMedia thiết bị mới rồi
   * replaceTrack cho mọi peer — không cần đàm phán lại SDP (không giật hình).
   */
  async switchDevice(
    kind: "video" | "audio",
    deviceId: string
  ): Promise<boolean> {
    try {
      const constraints: MediaStreamConstraints =
        kind === "video"
          ? { video: { deviceId: { exact: deviceId } }, audio: false }
          : { video: false, audio: { deviceId: { exact: deviceId } } };
      const partial = await navigator.mediaDevices.getUserMedia(constraints);
      const newTrack =
        kind === "video"
          ? partial.getVideoTracks()[0]
          : partial.getAudioTracks()[0];
      if (!newTrack) return false;

      // Giữ trạng thái bật/tắt hiện tại cho track mới.
      newTrack.enabled =
        kind === "video" ? this.state.camOn : this.state.micOn;

      const oldStream = this.state.localStream;
      const keptTracks = (oldStream?.getTracks() ?? []).filter(
        (t) => t.kind !== kind
      );
      const merged = new MediaStream([...keptTracks, newTrack]);
      this.mesh.replaceLocalStream(merged);
      // Dừng các track cũ cùng loại sau khi đã thay xong.
      for (const t of oldStream?.getTracks() ?? []) {
        if (t.kind === kind) t.stop();
      }
      this.setState({ localStream: merged });
      return true;
    } catch (err) {
      console.error("[meeting] switchDevice lỗi:", err);
      this.pushToast({
        kind: "error",
        message: "Không chuyển được thiết bị. Vui lòng thử lại.",
      });
      return false;
    }
  }

  /** Gửi tin nhắn chat trong phòng. */
  sendChat(text: string): void {
    const trimmed = text.trim().slice(0, 1000);
    if (!trimmed || !this.socket?.connected) return;
    this.socket.emit("chat:send", { text: trimmed });
  }

  /** Đánh dấu đã đọc chat (đặt lại badge số tin chưa đọc). */
  markChatRead(): void {
    if (this.state.unreadChat !== 0) this.setState({ unreadChat: 0 });
  }

  /* ---------------------------------------------------------------------- */
  /* HÀNH ĐỘNG CỦA CHỦ PHÒNG (duyệt / từ chối / đuổi / tắt mic-cam từ xa)     */
  /* ---------------------------------------------------------------------- */

  /** ĐỒNG Ý cho người đang chờ trước cửa vào lớp. */
  admitJoin(sessionId: string): void {
    if (!this.socket?.connected) return;
    this.socket.emit(
      "host:admit",
      { sessionId },
      (ack: { ok?: boolean; name?: string }) => {
        if (ack?.ok) {
          this.setState({
            joinRequests: this.state.joinRequests.filter(
              (r) => r.sessionId !== sessionId
            ),
          });
          this.pushToast({
            kind: "success",
            message: `Đã duyệt ${ack.name ?? "thành viên"} vào lớp.`,
          });
        } else {
          this.pushToast({
            kind: "error",
            message: "Không duyệt được — người này có thể đã rời hàng chờ.",
          });
        }
      }
    );
  }

  /** TỪ CHỐI người đang chờ trước cửa. */
  denyJoin(sessionId: string): void {
    if (!this.socket?.connected) return;
    this.socket.emit(
      "host:deny",
      { sessionId },
      (ack: { ok?: boolean; name?: string }) => {
        if (ack?.ok) {
          this.setState({
            joinRequests: this.state.joinRequests.filter(
              (r) => r.sessionId !== sessionId
            ),
          });
          this.pushToast({
            kind: "info",
            message: `Đã từ chối ${ack.name ?? "yêu cầu"} vào lớp.`,
          });
        } else {
          this.pushToast({
            kind: "error",
            message: "Không xử lý được — yêu cầu có thể đã hết hạn.",
          });
        }
      }
    );
  }

  /** Mời một thành viên ra khỏi lớp (quyền chủ phòng & chủ web). */
  kickSession(sessionId: string): void {
    if (!this.socket?.connected) return;
    this.socket.emit("admin:kick", { to: sessionId }, (ack: { ok?: boolean }) => {
      if (ack?.ok) {
        this.pushToast({ kind: "info", message: "Đã mời thành viên ra khỏi lớp." });
      } else {
        this.pushToast({
          kind: "error",
          message: "Không mời được — người này có thể đã rời lớp.",
        });
      }
    });
  }

  /** Tắt tiếng micro một thành viên từ xa (luôn là TẮT THẬT). */
  forceMute(sessionId: string): void {
    this.micControl(sessionId, "off");
  }

  /** Tắt camera một thành viên từ xa (luôn là TẮT THẬT). */
  forceCamOff(sessionId: string): void {
    this.camControl(sessionId, "off");
  }

  /**
   * ĐIỀU KHIỂN CAMERA THÀNH VIÊN TỪ XA (chủ phòng) — 3 chế độ theo yêu cầu
   * CEO: "BẬT là BẬT LUÔN, CẤM là CẤM LUÔN":
   *   • "on"   : bật NGAY trên máy họ + khoá bật (họ không tự tắt được).
   *   • "off"  : cấm — tắt NGAY + khoá (họ không tự bật lại được).
   *   • "free" : trả quyền — họ tự chủ lại camera của mình.
   */
  camControl(sessionId: string, mode: DeviceLock): void {
    if (!this.socket?.connected) return;
    this.socket.emit(
      "admin:cam-control",
      { to: sessionId, mode },
      (ack: { ok?: boolean }) => {
        if (!ack?.ok) {
          this.pushToast({
            kind: "error",
            message: "Không điều khiển được camera — người này có thể đã rời lớp.",
          });
        }
      }
    );
  }

  /** ĐIỀU KHIỂN MICRO THÀNH VIÊN TỪ XA (chủ phòng) — đối xứng camControl. */
  micControl(sessionId: string, mode: DeviceLock): void {
    if (!this.socket?.connected) return;
    this.socket.emit(
      "admin:mic-control",
      { to: sessionId, mode },
      (ack: { ok?: boolean }) => {
        if (!ack?.ok) {
          this.pushToast({
            kind: "error",
            message: "Không điều khiển được micro — người này có thể đã rời lớp.",
          });
        }
      }
    );
  }

  /** Rút khỏi hàng chờ duyệt (người đang chờ chủ phòng bấm "Huỷ chờ"). */
  cancelWaiting(): void {
    this.leave();
  }

  /* ---------------------------------------------------------------------- */
  /* TOAST (THÔNG BÁO NỔI TRONG PHÒNG)                                       */
  /* ---------------------------------------------------------------------- */

  private pushToast(item: Omit<ToastItem, "id" | "ts">): void {
    const toast: ToastItem = { ...item, id: generateId(), ts: Date.now() };
    this.setState({ toasts: [...this.state.toasts, toast] });
    if (!toast.sticky && !toast.requireAck) {
      setTimeout(() => this.dismissToast(toast.id), 5000);
    }
  }

  /** Tắt một toast (nút X hoặc "Đã hiểu"). */
  dismissToast(id: string): void {
    this.setState({
      toasts: this.state.toasts.filter((t) => t.id !== id),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* RỜI PHÒNG & DỌN DẸP                                                     */
  /* ---------------------------------------------------------------------- */

  /** Dừng mọi track media cục bộ (cam, mic, màn hình). */
  private teardownMedia(): void {
    for (const track of this.state.localStream?.getTracks() ?? []) track.stop();
    for (const track of this.state.myScreenStream?.getTracks() ?? []) track.stop();
  }

  /** Rời cuộc họp chủ động (nút đỏ). */
  leave(): void {
    this.leaving = true;
    try {
      this.socket?.emit("room:leave");
    } catch {
      // Socket có thể đã chết — không quan trọng.
    }
    this.teardownMedia();
    this.mesh.destroy();
    this.socket?.disconnect();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.setState({ phase: "left" });
    // Xoá sessionId lưu — lần vào sau là phiên mới hoàn toàn.
    try {
      sessionStorage.removeItem(`km-session:${this.opts.roomId}`);
    } catch {
      // sessionStorage có thể bị chặn ở chế độ riêng tư.
    }
  }

  /** Dọn dẹp toàn bộ khi component unmount (tải trang, chuyển route…). */
  destroy(): void {
    if (
      this.leaving ||
      this.state.phase === "left" ||
      this.state.phase === "kicked" ||
      this.state.phase === "denied" ||
      this.state.phase === "error"
    ) {
      return; // leave()/handler đã dọn xong.
    }
    this.leave();
  }
}
