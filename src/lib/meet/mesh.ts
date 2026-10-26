/**
 * ============================================================================
 *  KhanhMeet — TRÌNH QUẢN LÝ KẾT NỐI WEBRTC MESH (PEER MESH)
 * ----------------------------------------------------------------------------
 *  Mỗi cặp (peer, loại media) có một RTCPeerConnection riêng:
 *    • media "cam"    : luồng camera/micro chính (có sẵn mọi người).
 *    • media "screen" : luồng chia sẻ màn hình (chỉ tồn tại khi đang chia sẻ).
 *
 *  Chia sẻ màn hình được tinh chỉnh để MƯỢT nhất có thể (tối thiểu 60 fps):
 *    • contentHint = "motion" — bộ mã ưu tiên fps cho nội dung động.
 *    • Sender đặt maxBitrate 5 Mbps + maxFramerate 60 — đủ cho 1080p@60fps.
 *    • degradationPreference = "balanced" — khi áp lực băng thông, giảm
 *      độ phân giải và fps từ từ thay vì đứng hình.
 *
 *  Quy tắc đàm phán (tất định — xem shouldInitiateCam trong types.ts):
 *    • Bên chủ động gọi connectTo()/connectScreenTo() → tạo offer.
 *    • Bên còn lại chỉ phản hồi offer bằng answer.
 *    • Vậy không bao giờ xảy ra tình trạng "glare" (hai offer đua nhau).
 *
 *  Kỹ thuật an toàn được áp dụng:
 *    • Hàng đợi ICE candidates đến khi setRemoteDescription xong (pendingIce).
 *    • ICE restart đúng 1 lần khi kết nối "failed" (chống vòng lặp vô hạn).
 *    • Nhận offer trùng/lỗi thời → đóng peer cũ, tạo mới rồi xử lý (tự phục hồi).
 *    • "bye" để báo peer đối tác ngừng chia sẻ màn hình một cách sạch sẽ.
 * ============================================================================
 */

import {
  ICE_SERVERS,
  type PublicSession,
  type Role,
  type SignalKind,
  type SignalMedia,
  type IncomingSignal,
} from "./types";

export interface PeerMeshOptions {
  /** sessionId của chính mình. */
  selfId: string;
  /** Vai trò của mình (giám thị không bao giờ chủ động offer). */
  selfRole: Role;
  /** Luồng camera/mic cục bộ (null nếu tham gia không có thiết bị). */
  localStream: MediaStream | null;
  /** Gửi gói signaling tới peer khác (đường truyền qua Socket.IO). */
  sendSignal: (
    to: string,
    media: SignalMedia,
    kind: SignalKind,
    data?: unknown
  ) => void;
  /** Báo về khi có luồng remote mới / luồng remote bị đóng (stream = null). */
  onRemoteStream: (
    sessionId: string,
    media: SignalMedia,
    stream: MediaStream | null
  ) => void;
  /** Báo về khi trạng thái kết nối của một peer thay đổi. */
  onPeerState: (
    sessionId: string,
    media: SignalMedia,
    state: RTCPeerConnectionState
  ) => void;
}

/** Trạng thái nội bộ của một peer connection. */
interface PeerEntry {
  pc: RTCPeerConnection;
  media: SignalMedia;
  /** true = tôi là bên tạo offer cho kết nối này. */
  initiator: boolean;
  /** Ứng viên ICE đến trước remote description phải xếp hàng chờ. */
  pendingIce: RTCIceCandidateInit[];
  remoteReady: boolean;
  /** Đã thử ICE restart lần nào chưa (chỉ cho phép 1 lần tự phục hồi). */
  restartTried: boolean;
  /** Đang trong quá trình tạo offer (chặn offer song song). */
  makingOffer: boolean;
}

export class PeerMesh {
  /** Danh sách peer: khóa dạng `${sessionId}|${media}`. */
  private peers = new Map<string, PeerEntry>();
  private destroyed = false;

  constructor(private opts: PeerMeshOptions) {}

  /**
   * Cập nhật sessionId của chính mình.
   * Dùng bởi bảng điều khiển chủ web: mỗi phòng được chọn có sessionId khác
   * nhau (ổn định theo phòng) — mesh cần biết đúng id để lọc tín hiệu của tự
   * mình và bỏ qua kết nối tới chính mình.
   */
  setSelfId(id: string): void {
    this.opts.selfId = id;
  }

  /* ---------------------------------------------------------------------- */
  /* TIỆN ÍCH NỘI BỘ                                                         */
  /* ---------------------------------------------------------------------- */

  private key(sessionId: string, media: SignalMedia): string {
    return `${sessionId}|${media}`;
  }

  private get(sessionId: string, media: SignalMedia): PeerEntry | undefined {
    return this.peers.get(this.key(sessionId, media));
  }

  /** Tạo RTCPeerConnection trống + gắn mọi callback theo dõi. */
  private createPc(
    sessionId: string,
    media: SignalMedia,
    initiator: boolean
  ): PeerEntry {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    const entry: PeerEntry = {
      pc,
      media,
      initiator,
      pendingIce: [],
      remoteReady: false,
      restartTried: false,
      makingOffer: false,
    };

    /* --- 1. Gửi ICE candidate về cho peer qua kênh signaling --- */
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.opts.sendSignal(sessionId, media, "ice", ev.candidate.toJSON());
      }
    };

    /* --- 2. Nhận luồng media từ phía xa --- */
    pc.ontrack = (ev) => {
      // Ưu tiên MediaStream do phía gửi gắn kèm (MSID trong SDP);
      // nếu thiếu (một số trình duyệt legacy) thì tự dựng từ track.
      const stream =
        ev.streams[0] ?? new MediaStream([ev.track]);
      this.opts.onRemoteStream(sessionId, media, stream);
    };

    /* --- 3. Theo dõi & báo cáo trạng thái kết nối --- */
    pc.onconnectionstatechange = () => {
      this.opts.onPeerState(sessionId, media, pc.connectionState);

      if (pc.connectionState === "failed") {
        // Chỉ bên chủ động được khởi động lại ICE (tránh hai bên cùng làm).
        if (entry.initiator && !entry.restartTried) {
          entry.restartTried = true;
          this.restartIce(sessionId, entry).catch((err) =>
            console.error("[mesh] ICE restart thất bại:", err)
          );
        }
      }
    };

    this.peers.set(this.key(sessionId, media), entry);
    return entry;
  }

  /**
   * Gắn track cục bộ vào peer connection.
   * Nếu không có track (tham gia không thiết bị) và mình là bên tạo offer,
   * thêm transceiver recvonly để SDP vẫn có m-line hợp lệ.
   */
  private attachLocalTracks(entry: PeerEntry, isOfferer: boolean): void {
    const stream = this.opts.localStream;
    if (stream) {
      for (const track of stream.getTracks()) {
        entry.pc.addTrack(track, stream);
      }
    }
    const hasVideo = entry.pc.getSenders().some((s) => s.track?.kind === "video");
    const hasAudio = entry.pc.getSenders().some((s) => s.track?.kind === "audio");
    if (isOfferer && !hasVideo) {
      entry.pc.addTransceiver("video", { direction: "recvonly" });
    }
    if (isOfferer && !hasAudio) {
      entry.pc.addTransceiver("audio", { direction: "recvonly" });
    }
  }

  /** Đóng MỘT peer connection (hoặc mọi media của một session) và báo UI xoá luồng. */
  closePeer(sessionId: string, media?: SignalMedia): void {
    if (media) {
      const entry = this.get(sessionId, media);
      if (entry) this.teardown(entry, sessionId);
      return;
    }
    // Không chỉ định media → đóng cả "cam" lẫn "screen" của session này.
    for (const key of Array.from(this.peers.keys())) {
      if (key.startsWith(`${sessionId}|`)) {
        const entry = this.peers.get(key);
        if (entry) this.teardown(entry, sessionId);
      }
    }
  }

  /** Đóng toàn bộ peer (dùng khi rời phòng hoặc kết nối lại từ đầu). */
  closeAll(): void {
    for (const [key, entry] of Array.from(this.peers.entries())) {
      const [sessionId] = key.split("|");
      this.teardown(entry, sessionId);
    }
  }

  private teardown(entry: PeerEntry, sessionId: string): void {
    this.peers.delete(this.key(sessionId, entry.media));
    try {
      entry.pc.onicecandidate = null;
      entry.pc.ontrack = null;
      entry.pc.onconnectionstatechange = null;
      entry.pc.close();
    } catch {
      // Peer có thể đã đóng — bỏ qua lỗi đóng kép.
    }
    this.opts.onRemoteStream(sessionId, entry.media, null);
    this.opts.onPeerState(sessionId, entry.media, "closed");
  }

  /** Hủy bỏ toàn bộ tài nguyên (rời cuộc họp). */
  destroy(): void {
    this.destroyed = true;
    this.closeAll();
  }

  /* ---------------------------------------------------------------------- */
  /* BÊN CHỦ ĐỘNG: TẠO KẾT NỐI + OFFER                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Chủ động kết nối luồng "cam" tới một session khác.
   * Được gọi khi: peer mới vào phòng và theo quy tắc mình là bên chủ động.
   */
  async connectTo(session: PublicSession): Promise<void> {
    if (this.destroyed || session.id === this.opts.selfId) return;
    // Đã có kết nối rồi → bỏ qua (tránh trùng lặp khi room:state phát lại).
    if (this.get(session.id, "cam")) return;

    const entry = this.createPc(session.id, "cam", true);
    this.attachLocalTracks(entry, true);
    await this.makeOffer(session.id, entry);
  }

  /**
   * Chủ động gửi luồng chia sẻ màn hình tới một session.
   * Người chia sẻ LUÔN là bên chủ động với mọi người trong phòng
   * (kể cả chủ web) — gọi mỗi khi bắt đầu chia sẻ hoặc có người mới vào.
   */
  async connectScreenTo(
    session: PublicSession,
    screenStream: MediaStream
  ): Promise<void> {
    if (this.destroyed || session.id === this.opts.selfId) return;
    if (this.get(session.id, "screen")) return;

    const entry = this.createPc(session.id, "screen", true);
    for (const track of screenStream.getTracks()) {
      // Gợi ý bộ mã ưu tiên FPS ("motion") — chia sẻ mượt, tối thiểu 60 fps.
      if (track.kind === "video") {
        (track as MediaStreamTrack & { contentHint?: string }).contentHint =
          "motion";
      }
      entry.pc.addTrack(track, screenStream);
    }
    // Nâng chất lượng gửi: 5 Mbps + 60fps + giảm dần thay vì đứng hình.
    this.tuneScreenSenders(entry);
    await this.makeOffer(session.id, entry);
  }

  /**
   * Tinh chỉnh RTCRtpSender cho luồng chia sẻ màn hình:
   *  - maxBitrate 5.000.000 bps  : đủ cho 1080p60, hình sắc nét.
   *  - maxFramerate 60            : chuyển động mượt (yêu cầu tối thiểu 60 fps).
   *  - degradationPreference      : khi mạng yếu giảm chất lượng TỪ TỪ
   *    ("balanced") thay vì sacrifice hoàn toàn fps hay độ phân giải.
   * Chạy trong try/catch: trình duyệt cũ không hỗ trợ vẫn hoạt động bình thường.
   */
  private tuneScreenSenders(entry: PeerEntry): void {
    for (const sender of entry.pc.getSenders()) {
      if (sender.track?.kind !== "video") continue;
      try {
        // lib.dom mô hình hoá getParameters() kiểu cũ (thiếu encodings) —
        // ép về RTCRtpSendParameters đúng theo đặc tả W3C hiện hành.
        const params = sender.getParameters() as RTCRtpSendParameters & {
          degradationPreference?: string;
        };
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = 5_000_000;
        params.encodings[0].maxFramerate = 60;
        params.degradationPreference = "balanced";
        void sender
          .setParameters(params)
          .catch((err) =>
            console.warn("[mesh] setParameters màn hình lỗi:", err)
          );
      } catch (err) {
        console.warn("[mesh] tuneScreenSenders lỗi:", err);
      }
    }
  }

  /** Tạo offer, setLocalDescription rồi gửi đi. */
  private async makeOffer(sessionId: string, entry: PeerEntry): Promise<void> {
    if (entry.makingOffer) return;
    entry.makingOffer = true;
    try {
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      this.opts.sendSignal(sessionId, entry.media, "offer", offer);
    } catch (err) {
      console.error("[mesh] Tạo offer lỗi:", err);
      this.teardown(entry, sessionId);
    } finally {
      entry.makingOffer = false;
    }
  }

  /** ICE restart (tự phục hồi một lần khi kết nối failed). */
  private async restartIce(sessionId: string, entry: PeerEntry): Promise<void> {
    if (this.destroyed) return;
    try {
      const offer = await entry.pc.createOffer({ iceRestart: true });
      await entry.pc.setLocalDescription(offer);
      this.opts.sendSignal(sessionId, entry.media, "offer", offer);
      console.log(`[mesh] Đã gửi ICE restart tới ${sessionId} (${entry.media})`);
    } catch (err) {
      console.error("[mesh] restartIce lỗi:", err);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* BÊN THỤ ĐỘNG / TRUNG CHUYỂN: XỬ LÝ TÍN HIỆU TỪ SERVER                   */
  /* ---------------------------------------------------------------------- */

  /** Điểm vào duy nhất xử lý gói signaling nhận được. */
  async handleSignal(sig: IncomingSignal): Promise<void> {
    if (this.destroyed) return;
    if (sig.from === this.opts.selfId) return;

    switch (sig.kind) {
      case "offer":
        await this.handleOffer(sig);
        break;
      case "answer":
        await this.handleAnswer(sig);
        break;
      case "ice":
        this.handleIce(sig);
        break;
      case "bye":
        this.handleBye(sig);
        break;
    }
  }

  /**
   * Nhận OFFER: nếu đã có peer cũ (offer lỗi thời sau khi kết nối lại)
   * thì đóng cái cũ, tạo cái mới, rồi mới áp dụng offer — tự phục hồi
   * mọi trạng thái lệch pha giữa hai trình duyệt.
   */
  private async handleOffer(sig: IncomingSignal): Promise<void> {
    const offer = sig.data as RTCSessionDescriptionInit;
    if (!offer || typeof offer.type !== "string") return;

    const existing = this.get(sig.from, sig.media);
    if (existing) {
      this.teardown(existing, sig.from);
    }

    const entry = this.createPc(sig.from, sig.media, false);
    this.attachLocalTracks(entry, false); // answerer: gắn track trước createAnswer

    try {
      await entry.pc.setRemoteDescription(
        new RTCSessionDescription(offer as RTCSessionDescriptionInit)
      );
      entry.remoteReady = true;
      await this.flushIce(entry);

      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      this.opts.sendSignal(sig.from, sig.media, "answer", answer);
    } catch (err) {
      console.error("[mesh] Xử lý offer lỗi:", err);
      this.teardown(entry, sig.from);
    }
  }

  /** Nhận ANSWER (bên chủ động hoàn tất đàm phán). */
  private async handleAnswer(sig: IncomingSignal): Promise<void> {
    const entry = this.get(sig.from, sig.media);
    if (!entry || !entry.initiator) return; // không chờ answer → bỏ qua
    const answer = sig.data as RTCSessionDescriptionInit;
    if (!answer || typeof answer.type !== "string") return;
    try {
      await entry.pc.setRemoteDescription(
        new RTCSessionDescription(answer as RTCSessionDescriptionInit)
      );
      entry.remoteReady = true;
      await this.flushIce(entry);
    } catch (err) {
      console.error("[mesh] Xử lý answer lỗi:", err);
    }
  }

  /** Nhận ICE candidate — xếp hàng nếu remote description chưa sẵn sàng. */
  private handleIce(sig: IncomingSignal): void {
    const candidate = sig.data as RTCIceCandidateInit | null;
    if (!candidate) return;

    let entry = this.get(sig.from, sig.media);
    if (!entry) {
      // Candidate đến trước offer (trường hợp hiếm) — tạo "vỏ" peer chờ offer.
      entry = this.createPc(sig.from, sig.media, false);
      this.attachLocalTracks(entry, false);
    }
    if (!entry.remoteReady) {
      entry.pendingIce.push(candidate);
      return;
    }
    entry.pc
      .addIceCandidate(new RTCIceCandidate(candidate))
      .catch((err) => console.warn("[mesh] addIceCandidate lỗi:", err));
  }

  /** Nhận "bye": peer đối tác đã ngừng chia sẻ màn hình / đóng kết nối. */
  private handleBye(sig: IncomingSignal): void {
    const entry = this.get(sig.from, sig.media);
    if (entry) this.teardown(entry, sig.from);
  }

  /** Xả hàng đợi ICE sau khi remote description đã sẵn sàng. */
  private async flushIce(entry: PeerEntry): Promise<void> {
    while (entry.pendingIce.length > 0) {
      const candidate = entry.pendingIce.shift();
      if (!candidate) break;
      try {
        await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn("[mesh] flushIce lỗi:", err);
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* CẬP NHẬT THIẾT BỊ (đổi camera/micro giữa cuộc họp)                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Thay track cục bộ bằng luồng mới (đổi thiết bị) mà KHÔNG cần đàm phán lại:
   * RTCRtpSender.replaceTrack hoán đổi track ngầm trên cùng m-line SDP.
   */
  replaceLocalStream(newStream: MediaStream | null): void {
    this.opts.localStream = newStream;
    for (const entry of this.peers.values()) {
      if (entry.media !== "cam") continue;
      const senders = entry.pc.getSenders();
      const newVideo = newStream?.getVideoTracks()[0] ?? null;
      const newAudio = newStream?.getAudioTracks()[0] ?? null;

      for (const sender of senders) {
        if (sender.track?.kind === "video" && newVideo) {
          sender.replaceTrack(newVideo).catch((err) =>
            console.error("[mesh] replaceTrack video lỗi:", err)
          );
        } else if (sender.track?.kind === "audio" && newAudio) {
          sender.replaceTrack(newAudio).catch((err) =>
            console.error("[mesh] replaceTrack audio lỗi:", err)
          );
        }
      }
    }
  }

  /** Thông báo mesh biết luồng màn hình cục bộ đã dừng (để không offer nữa). */
  markScreenStopped(): void {
    // Đóng mọi peer "screen" mình đang gửi đi + báo bye cho các bên nhận.
    for (const [key, entry] of Array.from(this.peers.entries())) {
      if (entry.media !== "screen" || !entry.initiator) continue;
      const sessionId = key.split("|")[0];
      this.opts.sendSignal(sessionId, "screen", "bye");
      this.teardown(entry, sessionId);
    }
  }

  /**
   * Peer "cam" này đã có ĐƯỜNG GỬI (sender) của loại track chưa?
   * Dùng khi vừa mở camera/micro giữa cuộc họp: peer nào chưa có đường gửi
   * loại này thì phải dựng lại kết nối (offer mới) — replaceTrack một mình
   * không tạo ra m-line mới.
   */
  hasSenderOf(sessionId: string, kind: "video" | "audio"): boolean {
    const entry = this.get(sessionId, "cam");
    if (!entry) return false;
    return entry.pc.getSenders().some((s) => s.track?.kind === kind);
  }
}
