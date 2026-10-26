/**
 * ============================================================================
 *  KhanhMeet — OWNER CLIENT (PHÍA CHỦ WEB / NGƯỜI SÁNG TẠO TRANG WEB)
 * ----------------------------------------------------------------------------
 *  Bảng điều khiển dành RIÊNG cho chủ web — mở bằng MÃ CHỦ WEB nhập tại
 *  ô nhỏ góc trái dưới trang chủ (không có liên kết nào dẫn tới):
 *    • Xác thực bằng MÃ CHỦ WEB — máy chủ so khớp trong danh sách OWNER_CODES.
 *    • Nhận danh sách TOÀN BỘ phòng học đang hoạt động ("rooms:update").
 *    • Chọn một phòng → tham gia như thành viên recvonly (không gửi cam/mic),
 *      xuất hiện công khai trong danh sách người tham gia của phòng đó.
 *    • Nhận trực tiếp luồng WebRTC (cam + màn hình) của mọi thành viên,
 *      kèm RTT, trạng thái cam/mic, giơ tay, chia sẻ màn hình.
 *    • Nhật ký hoạt động realtime + lịch sử từ SQLite; ghi chú theo thành viên.
 *    • Cảnh báo cá nhân / đồng loạt; TẮT TIẾNG / TẮT CAMERA từ xa;
 *      đuổi khỏi phòng; TAN LỚP (kết thúc buổi học, đóng phòng vĩnh viễn).
 * ============================================================================
 */

import type { Socket } from "socket.io-client";
import { StateEmitter } from "./emitter";
import { createSignalingSocket } from "./signaling";
import { PeerMesh } from "./mesh";
import {
  generateId,
  type ChatMessage,
  type DeviceLock,
  type EventPayload,
  type JoinAck,
  type JoinRequestPayload,
  type NotePayload,
  type OwnerAuthAck,
  type PublicSession,
  type RoomSnapshot,
  type RoomSummary,
  type SignalKind,
  type SignalMedia,
} from "./types";

/** Trạng thái đầy đủ của bảng điều khiển chủ web. */
export interface OwnerState {
  phase: "connecting" | "authed" | "error";
  error: string | null;
  /** sessionId trong phòng đang xem (rỗng nếu chưa chọn phòng). */
  selfId: string;
  socketConnected: boolean;
  /** Danh sách phòng học đang hoạt động. */
  rooms: RoomSummary[];
  /** Phòng đang mở để xem trực tiếp (null = chưa chọn). */
  activeRoomId: string | null;
  roomTitle: string;
  sessions: PublicSession[];
  /** Luồng cam/mic của từng thành viên, khóa = sessionId. */
  streams: Record<string, MediaStream>;
  /** Luồng chia sẻ màn hình của từng thành viên, khóa = sessionId. */
  screens: Record<string, MediaStream>;
  /** Trạng thái RTCPeerConnection (luồng cam) theo sessionId. */
  peerStates: Record<string, RTCPeerConnectionState>;
  /** Nhật ký hoạt động (lịch sử + realtime, tối đa 500 mục hiển thị). */
  events: EventPayload[];
  /** Ghi chú của chủ web. */
  notes: NotePayload[];
  chat: ChatMessage[];
  rtt: number | null;
  /** Thông báo nổi ngắn (VD: phòng đang xem vừa tự kết thúc vì trống). */
  notice: string | null;
  /** Hàng chờ "gõ cửa lớp" của phòng đang xem (chủ web duyệt được luôn). */
  pendingJoins: JoinRequestPayload[];
}

export interface OwnerClientOptions {
  /** MÃ CHỦ WEB (do người sáng tạo web nắm giữ). */
  ownerKey: string;
  /** Tên hiển thị của chủ web trong danh sách người tham gia. */
  name?: string;
}

const HEARTBEAT_INTERVAL_MS = 4000;

/** Kết quả ack tổng quát từ máy chủ. */
interface GenericAck {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export class OwnerClient extends StateEmitter<OwnerState> {
  private socket: Socket | null = null;
  private mesh: PeerMesh;
  /** sessionId hiện tại trong phòng đang xem (đổi theo phòng được chọn). */
  private sessionId = "";
  private activeRoom = "";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private everAuthed = false;

  constructor(private opts: OwnerClientOptions) {
    super({
      phase: "connecting",
      error: null,
      selfId: "",
      socketConnected: false,
      rooms: [],
      activeRoomId: null,
      roomTitle: "",
      sessions: [],
      streams: {},
      screens: {},
      peerStates: {},
      events: [],
      notes: [],
      chat: [],
      rtt: null,
      notice: null,
      pendingJoins: [],
    });

    // Chủ web KHÔNG có luồng media (localStream = null) → mesh tự thêm
    // transceiver recvonly khi cần; vai trò admin không bao giờ chủ động offer.
    this.mesh = new PeerMesh({
      selfId: "pending",
      selfRole: "admin",
      localStream: null,
      sendSignal: (to, media, kind, data) => {
        this.socket?.emit("webrtc:signal", { to, media, kind, data });
      },
      onRemoteStream: (sessionId, media, stream) => {
        if (media === "cam") {
          const next = { ...this.state.streams };
          if (stream) next[sessionId] = stream;
          else delete next[sessionId];
          this.setState({ streams: next });
        } else {
          const next = { ...this.state.screens };
          if (stream) next[sessionId] = stream;
          else delete next[sessionId];
          this.setState({ screens: next });
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
  /* KẾT NỐI & XÁC THỰC KHOÁ CHỦ WEB                                         */
  /* ---------------------------------------------------------------------- */

  connect(): void {
    const socket = createSignalingSocket();
    this.socket = socket;

    socket.on("connect", () => {
      this.setState({ socketConnected: true, error: null });
      // Mỗi lần socket nối lại đều phải xác thực khoá chủ web từ đầu.
      this.emitAuth();
    });

    socket.on("disconnect", () => {
      this.setState({ socketConnected: false });
    });

    socket.on("connect_error", () => {
      this.setState({ socketConnected: false });
    });

    socket.on("rooms:update", (payload: { rooms?: RoomSummary[] }) => {
      if (payload?.rooms) this.setState({ rooms: payload.rooms });
    });

    socket.on("room:state", (snap: RoomSnapshot) => {
      if (!snap || snap.roomId !== this.activeRoom) return;
      const prevById = new Map(this.state.sessions.map((s) => [s.id, s]));

      // Dọn những phiên đã rời hẳn khỏi phòng.
      for (const prev of prevById.values()) {
        if (!snap.sessions.some((s) => s.id === prev.id)) {
          this.dropStreamsOf(prev.id);
        }
      }

      this.setState({
        sessions: snap.sessions,
        roomTitle: snap.title,
      });
    });

    socket.on("peer:offline", (payload: { sessionId: string; reason: string }) => {
      if (payload?.reason === "disconnected") return; // giữ luồng chờ kết nối lại
      if (payload?.sessionId) this.dropStreamsOf(payload.sessionId);
    });

    socket.on("webrtc:signal", (sig: {
      from: string;
      media: SignalMedia;
      kind: SignalKind;
      data?: unknown;
    }) => {
      void this.mesh.handleSignal(sig);
    });

    socket.on("chat:message", (msg: ChatMessage) => {
      this.setState({ chat: [...this.state.chat, msg].slice(-300) });
    });

    socket.on("admin:event", (payload: { event?: EventPayload }) => {
      const ev = payload?.event;
      if (!ev) return;
      // Chống trùng lặp: nếu sự kiện có ID này đã có trong danh sách thì bỏ
      // qua (phòng khi server phát lại sau khi kết nối lại, tránh React key trùng).
      if (this.state.events.some((e) => e.id === ev.id && e.ts === ev.ts)) {
        return;
      }
      this.setState({
        events: [...this.state.events, ev].slice(-500),
      });
    });

    socket.on("admin:note:added", (payload: { note?: NotePayload }) => {
      if (!payload?.note) return;
      this.setState({ notes: [...this.state.notes, payload.note] });
    });

    /* Danh sách "gõ cửa lớp" của phòng đang xem (chủ web duyệt được luôn). */
    socket.on("admin:pending", (payload: { requests?: JoinRequestPayload[] }) => {
      if (!Array.isArray(payload?.requests)) return;
      this.setState({ pendingJoins: payload.requests });
    });

    /* Phòng đang xem vừa bị đóng (TAN LỚP hoặc TỰ KẾT THÚC vì không còn
       ai trong phòng) → rời phòng, dọn dữ liệu và hiện thông báo ngắn. */
    socket.on("room:closed", (payload: { roomId?: string; reason?: string }) => {
      if (!payload?.roomId || payload.roomId !== this.activeRoom) return;
      this.clearActiveRoom();
      this.setState({
        notice: payload.reason ?? "Phòng học đã kết thúc.",
      });
    });

    /* Heartbeat chủ web (đo RTT đường truyền của chính mình). */
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

  /** Xác thực khoá chủ web; thành công → vào lại phòng đang xem (nếu có). */
  private emitAuth(): void {
    if (!this.socket) return;
    this.socket.emit(
      "owner:auth",
      { key: this.opts.ownerKey },
      (ack: OwnerAuthAck) => {
        if (ack?.ok) {
          this.everAuthed = true;
          this.setState({ phase: "authed", error: null });
          if (ack.rooms) this.setState({ rooms: ack.rooms });
          // Socket vừa nối lại → dựng lại mesh & vào lại phòng đang xem.
          this.mesh.closeAll();
          this.clearRoomData();
          if (this.activeRoom) this.emitJoin(this.activeRoom);
        } else {
          this.setState({
            phase: "error",
            error:
              "Mã không đúng. Chỉ người sáng tạo web mới nắm giữ mã này.",
          });
        }
      }
    );
  }

  /* ---------------------------------------------------------------------- */
  /* CHỌN PHÒNG ĐỂ XEM                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Mở một phòng trong bảng điều khiển: rời phòng cũ (nếu có) rồi tham gia
   * phòng mới với vai trò admin — mọi thành viên trong phòng thấy chủ web
   * xuất hiện trong danh sách người tham gia (minh bạch, không ẩn mình).
   */
  selectRoom(roomId: string): void {
    if (!this.socket || !this.socket.connected) return;
    if (roomId === this.activeRoom) return; // đã đang mở

    // Rời phòng cũ một cách lịch sự.
    if (this.activeRoom) {
      try {
        this.socket.emit("room:leave");
      } catch {
        // Bỏ qua — socket có thể đã đóng.
      }
      this.mesh.closeAll();
    }
    this.clearRoomData();
    this.activeRoom = roomId;
    this.setState({ activeRoomId: roomId });
    this.emitJoin(roomId);
  }

  /** Xoá mọi dữ liệu của phòng cũ khỏi state (giữ danh sách phòng). */
  private clearRoomData(): void {
    this.setState({
      selfId: "",
      roomTitle: "",
      sessions: [],
      streams: {},
      screens: {},
      peerStates: {},
      events: [],
      notes: [],
      chat: [],
      pendingJoins: [],
    });
  }

  /**
   * Bỏ chọn phòng hiện tại: rời phòng + dọn mesh + xoá state.
   * Dùng sau khi TAN LỚP hoặc khi chủ chủ động muốn dừng xem một phòng.
   */
  clearActiveRoom(): void {
    if (this.activeRoom) {
      try {
        this.socket?.emit("room:leave");
      } catch {
        // Bỏ qua — socket có thể đã đóng.
      }
    }
    this.mesh.closeAll();
    this.activeRoom = "";
    this.clearRoomData();
    this.setState({ activeRoomId: null });
  }

  /** Tham gia phòng với vai trò admin (đã qua xác thực mã chủ web). */
  private emitJoin(roomId: string): void {
    if (!this.socket) return;

    // sessionId ổn định THEO PHÒNG trong sessionStorage → tải lại trang
    // hoặc chuyển đi rồi quay lại vẫn là "mình" trong phòng đó.
    const storageKey = `km-admin:${roomId}`;
    try {
      const saved = sessionStorage.getItem(storageKey);
      this.sessionId = saved && saved.length >= 8 ? saved : generateId();
      sessionStorage.setItem(storageKey, this.sessionId);
    } catch {
      this.sessionId = generateId();
    }
    this.mesh.setSelfId(this.sessionId);

    this.socket.emit(
      "room:join",
      {
        roomId,
        name: this.opts.name || "Quản trị viên web",
        role: "admin",
        ownerKey: this.opts.ownerKey,
        sessionId: this.sessionId,
      },
      (ack: JoinAck) => {
        if (ack?.ok && ack.room) {
          this.setState({
            selfId: this.sessionId,
            roomTitle: ack.room.title,
            sessions: ack.room.sessions,
            chat: ack.room.recentChat ?? [],
          });
          // Tải lịch sử sự kiện + ghi chú ngay khi mở phòng.
          this.requestEventHistory();
          this.requestNotes();
        } else if (ack?.error === "owner-key-invalid") {
          this.setState({
            phase: "error",
            error: "Mã không đúng.",
          });
        } else if (ack?.error === "room-not-found") {
          // Phòng đã bị đóng (TAN LỚP / tự kết thúc vì trống): không phá cả
          // bảng điều khiển — chỉ bỏ chọn phòng đang xem và báo ngắn.
          this.clearActiveRoom();
          this.setState({
            notice: "Phòng đã bị đóng — có thể buổi học vừa kết thúc.",
          });
        }
      }
    );
  }

  /** Xoá mọi luồng WebRTC của một thành viên khỏi dashboard. */
  private dropStreamsOf(sessionId: string): void {
    this.mesh.closePeer(sessionId);
    const streams = { ...this.state.streams };
    const screens = { ...this.state.screens };
    const peerStates = { ...this.state.peerStates };
    delete streams[sessionId];
    delete screens[sessionId];
    delete peerStates[sessionId];
    this.setState({ streams, screens, peerStates });
  }

  /* ---------------------------------------------------------------------- */
  /* TẢI DỮ LIỆU LỊCH SỬ                                                     */
  /* ---------------------------------------------------------------------- */

  private requestEventHistory(): void {
    this.socket?.emit(
      "admin:events:list",
      { limit: 300 },
      (ack: { ok: boolean; events?: EventPayload[] }) => {
        if (ack?.ok && Array.isArray(ack.events)) {
          this.setState({ events: ack.events });
        }
      }
    );
  }

  private requestNotes(): void {
    this.socket?.emit(
      "admin:notes:list",
      {},
      (ack: { ok: boolean; notes?: NotePayload[] }) => {
        if (ack?.ok && Array.isArray(ack.notes)) {
          this.setState({ notes: ack.notes });
        }
      }
    );
  }

  /* ---------------------------------------------------------------------- */
  /* HÀNH ĐỘNG CỦA CHỦ WEB                                                   */
  /* ---------------------------------------------------------------------- */

  /** Gọi ack của socket gói thành Promise cho UI await tiện lợi. */
  private call<T extends GenericAck>(
    event: string,
    payload: Record<string, unknown>
  ): Promise<T> {
    return new Promise((resolve) => {
      if (!this.socket?.connected) {
        resolve({ ok: false, error: "Mất kết nối máy chủ" } as T);
        return;
      }
      this.socket.emit(event, payload, (ack: T) => {
        resolve(ack ?? ({ ok: false } as T));
      });
    });
  }

  /** Gửi cảnh báo tới MỘT thành viên. */
  sendWarning(sessionId: string, message: string): Promise<GenericAck> {
    return this.call<GenericAck>("admin:warning", { to: sessionId, message });
  }

  /** Gửi cảnh báo tới TOÀN BỘ thành viên trong phòng đang xem. */
  broadcastWarning(message: string): Promise<GenericAck> {
    return this.call<GenericAck>("admin:broadcast-warning", { message });
  }

  /** Mời một thành viên ra khỏi phòng. */
  kick(sessionId: string): Promise<GenericAck> {
    return this.call<GenericAck>("admin:kick", { to: sessionId });
  }

  /**
   * ĐIỀU KHIỂN CAMERA một thành viên (3 chế độ — CEO: "BẬT là BẬT LUÔN,
   * CẤM là CẤM LUÔN"): "on" = bật NGAY + khoá bật; "off" = cấm (tắt NGAY
   * + không tự bật lại được); "free" = trả quyền cho thành viên.
   */
  camControl(sessionId: string, mode: DeviceLock): Promise<GenericAck> {
    return this.call<GenericAck>("admin:cam-control", { to: sessionId, mode });
  }

  /** ĐIỀU KHIỂN MICRO một thành viên — đối xứng camControl. */
  micControl(sessionId: string, mode: DeviceLock): Promise<GenericAck> {
    return this.call<GenericAck>("admin:mic-control", { to: sessionId, mode });
  }

  /** ĐỒNG Ý cho người đang chờ trước cửa vào lớp (quyền chủ web). */
  admitJoin(sessionId: string): Promise<GenericAck> {
    return this.call<GenericAck>("host:admit", { sessionId });
  }

  /** TỪ CHỐI người đang chờ trước cửa (quyền chủ web). */
  denyJoin(sessionId: string): Promise<GenericAck> {
    return this.call<GenericAck>("host:deny", { sessionId });
  }

  /** TAN LỚP: kết thúc buổi học, đuổi hết thành viên và đóng phòng vĩnh viễn. */
  endMeeting(): Promise<GenericAck> {
    return this.call<GenericAck>("admin:end-meeting", {});
  }

  /** Thêm ghi chú nhanh về một thành viên (lưu vĩnh viễn). */
  addNote(targetSessionId: string, content: string): Promise<GenericAck> {
    return this.call<GenericAck>("admin:note:add", {
      targetSessionId,
      content,
    });
  }

  /** Gửi tin nhắn chat (chủ web cũng trò chuyện được trong phòng). */
  sendChat(text: string): void {
    const trimmed = text.trim().slice(0, 1000);
    if (!trimmed || !this.socket?.connected) return;
    this.socket.emit("chat:send", { text: trimmed });
  }

  /** Tắt thông báo nổi sau khi toast tự ẩn. */
  clearNotice(): void {
    if (this.state.notice !== null) this.setState({ notice: null });
  }

  /* ---------------------------------------------------------------------- */
  /* DỌN DẸN                                                                 */
  /* ---------------------------------------------------------------------- */

  destroy(): void {
    try {
      this.socket?.emit("room:leave");
    } catch {
      // Bỏ qua — socket có thể đã đóng.
    }
    this.mesh.destroy();
    this.socket?.disconnect();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
