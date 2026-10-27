"use client";

/**
 * ============================================================================
 *  LỚP HỌC TRỰC TUYẾN — GIAO DIỆN LỚP HỌC CHÍNH
 * ----------------------------------------------------------------------------
 *  • Tỉ lệ video CHUẨN 16:9, không kéo dàn (aspect-video + object-fit).
 *  • Có người chia sẻ màn hình → bố cục TRÌNH CHIẾU (spotlight) chuẩn Meet.
 *  • CHỦ PHÒNG (host):
 *      - Thẻ nổi "X người xin vào lớp" góc phải dưới: Đồng ý / Từ chối.
 *      - Bảng "Người tham gia": điều khiển cam/mic từng thành viên
 *        (CEO: "BẬT là BẬT LUÔN, CẤM là CẤM LUÔN") + mời ra lớp.
 *      - Nút "Sao chép liên kết lớp" (tiêu đề vàng) — mời bạn học.
 *  • THÀNH VIÊN:
 *      - Vào lớp có chủ phòng → MÀN CHỜ DUYỆT (logo KhanhMeet + đồng hồ).
 *      - Bị từ chối → màn "Bị từ chối" (thử lại / về trang chủ).
 *      - Bị chủ phòng cấm/bật luôn thiết bị → nút đeo badge khoá vàng +
 *        toast giải thích khi bấm.
 *  • Toast: cảnh báo chủ web, giơ tay, kết nối lại, duyệt vào lớp…
 * ============================================================================
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  PhoneOff,
  RotateCcw,
  Home,
  WifiOff,
  X,
  MonitorStop,
  Clock,
  Users,
  Link2,
  Crown,
  DoorOpen,
  UserX,
  UserPlus,
  Loader2,
  Hourglass,
} from "lucide-react";
import { MeetingClient } from "@/lib/meet/meeting-client";
import { useClientState } from "@/hooks/use-client-state";
import { copyToClipboard } from "@/lib/meet/signaling";
import { VideoTile } from "./VideoTile";
import { ControlBar } from "./ControlBar";
import { SidePanel } from "./SidePanel";
import { BoardCard } from "./decor";

export interface MeetingRoomProps {
  roomId: string;
  name: string;
  stream: MediaStream | null;
  initialCamOn: boolean;
  initialMicOn: boolean;
  /** Khoá chủ phòng (null = vào với vai trò thành viên thường). */
  hostKey?: string | null;
  /** Quay lại sảnh chờ (tham gia lại). */
  onRejoin: () => void;
  /** Về trang chủ. */
  onHome: () => void;
}

/** Độ rộng ô video theo số người (ô luôn 16:9 nhờ aspect-video). */
function tileWidth(count: number): string {
  if (count <= 2) return "w-[min(100%,28rem)]";
  if (count <= 4) return "w-[min(100%,24rem)]";
  if (count <= 9) return "w-[min(100%,20rem)]";
  return "w-[min(100%,16rem)]";
}

/** Định dạng thời gian đã chờ mm:ss. */
function formatElapsed(from: number, now: number): string {
  const s = Math.max(0, Math.floor((now - from) / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function MeetingRoom(props: MeetingRoomProps) {
  const isHost = props.hostKey != null && props.hostKey.length >= 8;

  /* ---- Khởi tạo client MỘT LẦN khi mount (lazy initializer an toàn SSR). ---- */
  const [client] = useState(
    () =>
      new MeetingClient({
        roomId: props.roomId,
        name: props.name,
        localStream: props.stream,
        initialCamOn: props.initialCamOn,
        initialMicOn: props.initialMicOn,
        role: isHost ? "host" : "member",
        hostKey: props.hostKey ?? null,
      })
  );
  const state = useClientState(client);

  /* ---- Mở kết nối socket sau khi mount; dọn dẹp khi unmount. ---- */
  useEffect(() => {
    client.connect();
    return () => client.destroy();
  }, [client]);

  /* ---- Đồng hồ (cập nhật mỗi giây — cũng dùng cho bộ đếm thời gian chờ) ---- */
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  /* ---- Bảng điều khiển bên phải ---- */
  const [panel, setPanel] = useState<"chat" | "participants" | null>(null);

  const togglePanel = useCallback(
    (target: "chat" | "participants") => {
      setPanel((current) => (current === target ? null : target));
      if (target === "chat") client?.markChatRead();
    },
    [client]
  );

  const markChatRead = useCallback(() => client?.markChatRead(), [client]);

  /* ---- Sao chép liên kết lớp (mời bạn học) ---- */
  const [linkCopied, setLinkCopied] = useState(false);
  const shareLink = useCallback(async () => {
    const ok = await copyToClipboard(
      `${window.location.origin}/#/room/${props.roomId}`
    );
    if (ok) {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    }
  }, [props.roomId]);

  /* ---- Danh sách ô video (mọi người trừ chủ web — họ không truyền hình) ---- */
  const tiles = useMemo(() => {
    if (!state) return [];
    return state.sessions
      .filter((s) => s.role !== "admin")
      .slice()
      .sort((a, b) => a.joinTime - b.joinTime)
      .map((session) => {
        const isSelf = session.id === state.selfId;
        return {
          key: session.id,
          session,
          isSelf,
          stream: isSelf ? state.localStream : state.remoteStreams[session.id] ?? null,
          pcState: isSelf ? ("connected" as const) : state.peerStates[session.id],
        };
      });
  }, [state]);

  /* ---- Danh sách các luồng chia sẻ màn hình (mình + người khác) ---- */
  const screens = useMemo(() => {
    if (!state) return [] as Array<{ key: string; stream: MediaStream; label: string }>;
    const list: Array<{ key: string; stream: MediaStream; label: string }> = [];
    if (state.myScreenStream) {
      list.push({ key: "self-screen", stream: state.myScreenStream, label: "Màn hình của bạn" });
    }
    for (const [sessionId, stream] of Object.entries(state.screenStreams)) {
      const session = state.sessions.find((s) => s.id === sessionId);
      list.push({
        key: `screen-${sessionId}`,
        stream,
        label: `Màn hình của ${session?.name ?? "bạn học"}`,
      });
    }
    return list;
  }, [state]);

  /* ---- Trạng thái nút chia sẻ màn hình ---- */
  const toggleScreen = useCallback(() => {
    if (!client) return;
    if (client.getState().myScreenStream) client.stopScreenShare();
    else void client.startScreenShare();
  }, [client]);

  /* ================== CÁC MÀN CHỜ ================== */
  if (!state) {
    return (
      <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[#122019] text-[#a3bca6]">
        <div className="relative z-10 flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          <span className="text-sm">Đang kết nối tới lớp…</span>
        </div>
      </div>
    );
  }

  /* ---- CHỜ CHỦ PHÒNG DUYỆT (gõ cửa lớp) ---- */
  if (state.phase === "waiting") {
    const elapsed = state.waitingSince
      ? formatElapsed(state.waitingSince, now.getTime())
      : "00:00";
    return (
      <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-[#122019] px-6 text-center text-[#f2ead9]">
        <BoardCard className="meet-fade-up relative z-10 w-full max-w-md">
          <div className="p-8 sm:p-10">
            <span className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#eeb64e]/10 ring-1 ring-[#eeb64e]/25">
              <Hourglass className="h-8 w-8 text-[#eeb64e]" aria-hidden />
            </span>
            <h1 className="text-2xl font-semibold tracking-tight">
              Đang chờ chủ phòng duyệt…
            </h1>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[#a3bca6]">
              Yêu cầu vào lớp của bạn đã được gửi. Chủ phòng bấm
              “Đồng ý” là bạn vào ngay.
            </p>
            <p className="mt-5 text-4xl font-semibold tabular-nums tracking-wide text-[#eeb64e]">
              {elapsed}
            </p>
            <p className="mt-1 text-xs text-[#78917c]">
              đã chờ trước cửa lớp
            </p>
            <button
              onClick={() => client.cancelWaiting()}
              className="mt-6 flex h-11 items-center justify-center gap-2 rounded-full border border-[#35543f] px-6 text-sm text-[#f2ead9] transition hover:bg-[#24402f]"
            >
              <DoorOpen className="h-4 w-4" aria-hidden />
              Huỷ &amp; rời hàng chờ
            </button>
          </div>
        </BoardCard>
      </div>
    );
  }

  /* ---- BỊ CHỦ PHÒNG TỪ CHỐI ---- */
  if (state.phase === "denied") {
    return (
      <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-[#122019] px-6 text-center text-[#f2ead9]">
        <BoardCard className="meet-fade-up relative z-10 w-full max-w-md">
          <div className="p-8 sm:p-10">
            <span className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#e14b32]/12 ring-1 ring-[#e14b32]/30">
              <UserX className="h-8 w-8 text-[#ef7d63]" aria-hidden />
            </span>
            <h1 className="text-2xl font-semibold tracking-tight text-[#ef7d63]">
              Chủ phòng đã từ chối bạn vào lớp
            </h1>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[#a3bca6]">
              {state.error ?? "Yêu cầu vào lớp của bạn bị từ chối."}
            </p>
            <div className="mt-8 flex flex-col justify-center gap-2 sm:flex-row">
              <button
                onClick={props.onRejoin}
                className="flex h-11 items-center justify-center gap-2 rounded-full bg-[#e14b32] px-6 text-sm font-semibold text-[#fff6ee] shadow-lg shadow-black/25 hover:bg-[#ef5c42]"
              >
                <RotateCcw className="h-4 w-4" aria-hidden />
                Thử lại
              </button>
              <button
                onClick={props.onHome}
                className="flex h-11 items-center justify-center gap-2 rounded-full border border-[#35543f] px-6 text-sm text-[#f2ead9] transition hover:bg-[#24402f]"
              >
                <Home className="h-4 w-4" aria-hidden />
                Về trang chủ
              </button>
            </div>
          </div>
        </BoardCard>
      </div>
    );
  }

  /* ---- RỜI LỚP THÀNH CÔNG ---- */
  if (state.phase === "left") {
    return (
      <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-[#122019] px-6 text-center text-[#f2ead9]">
        <BoardCard className="meet-fade-up relative z-10 w-full max-w-md">
          <div className="p-8 sm:p-10">
            <span className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#8fce9e]/10 ring-1 ring-[#8fce9e]/25">
              <Check className="h-8 w-8 text-[#8fce9e]" aria-hidden />
            </span>
            <h1 className="text-2xl font-semibold tracking-tight">
              Bạn đã rời khỏi lớp học
            </h1>
            <div className="mt-8 flex flex-col justify-center gap-2 sm:flex-row">
              <button
                onClick={props.onRejoin}
                className="flex h-11 items-center justify-center gap-2 rounded-full bg-[#e14b32] px-6 text-sm font-semibold text-[#fff6ee] shadow-lg shadow-black/25 hover:bg-[#ef5c42]"
              >
                <RotateCcw className="h-4 w-4" aria-hidden />
                Tham gia lại
              </button>
              <button
                onClick={props.onHome}
                className="flex h-11 items-center justify-center gap-2 rounded-full border border-[#35543f] px-6 text-sm text-[#f2ead9] transition hover:bg-[#24402f]"
              >
                <Home className="h-4 w-4" aria-hidden />
                Về trang chủ
              </button>
            </div>
          </div>
        </BoardCard>
      </div>
    );
  }

  /* ---- BỊ MỜI RA KHỎI LỚP ---- */
  if (state.phase === "kicked") {
    return (
      <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-[#122019] px-6 text-center text-[#f2ead9]">
        <BoardCard className="meet-fade-up relative z-10 w-full max-w-md">
          <div className="p-8 sm:p-10">
            <span className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#e14b32]/15 ring-1 ring-[#ef7d63]/25">
              <PhoneOff className="h-8 w-8 text-[#ef7d63]" aria-hidden />
            </span>
            <h1 className="text-2xl font-semibold tracking-tight text-[#ef7d63]">
              Bạn đã bị mời ra khỏi lớp học
            </h1>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[#a3bca6]">
              {state.error ?? "Chủ phòng đã mời bạn ra khỏi lớp."}
            </p>
            <button
              onClick={props.onHome}
              className="mt-8 flex h-11 items-center justify-center gap-2 rounded-full bg-[#e14b32] px-6 text-sm font-semibold text-[#fff6ee] shadow-lg shadow-black/25 hover:bg-[#ef5c42] sm:mx-auto"
            >
              <Home className="h-4 w-4" aria-hidden />
              Về trang chủ
            </button>
          </div>
        </BoardCard>
      </div>
    );
  }

  /* ---- LỖI KHÔNG THAM GIA ĐƯỢC ---- */
  if (state.phase === "error") {
    return (
      <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-[#122019] px-6 text-center text-[#f2ead9]">
        <BoardCard className="meet-fade-up relative z-10 w-full max-w-md">
          <div className="p-8 sm:p-10">
            <span className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#eeb64e]/10 ring-1 ring-[#eeb64e]/25">
              <AlertTriangle className="h-8 w-8 text-[#eeb64e]" aria-hidden />
            </span>
            <h1 className="text-2xl font-semibold tracking-tight">
              Không thể vào lớp
            </h1>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[#a3bca6]">
              {state.error}
            </p>
            <div className="mt-8 flex flex-col justify-center gap-2 sm:flex-row">
              <button
                onClick={props.onRejoin}
                className="flex h-11 items-center justify-center gap-2 rounded-full bg-[#e14b32] px-6 text-sm font-semibold text-[#fff6ee] shadow-lg shadow-black/25 hover:bg-[#ef5c42]"
              >
                <RotateCcw className="h-4 w-4" aria-hidden />
                Thử lại
              </button>
              <button
                onClick={props.onHome}
                className="flex h-11 items-center justify-center gap-2 rounded-full border border-[#35543f] px-6 text-sm text-[#f2ead9] transition hover:bg-[#24402f]"
              >
                <Home className="h-4 w-4" aria-hidden />
                Về trang chủ
              </button>
            </div>
          </div>
        </BoardCard>
      </div>
    );
  }

  /* ================== GIAO DIỆN LỚP CHÍNH ================== */
  const spotlight = screens[0] ?? null;
  const connecting = state.phase === "joining" || state.phase === "reconnecting";
  const width = tileWidth(tiles.length);
  const requests = state.joinRequests;

  /* Một mình trong lớp nhưng ĐANG BẬT CAMERA → vẫn hiện ô video của chính
   * mình (đúng chuẩn Google Meet): người dùng thấy ngay camera hoạt động,
   * không thấy màn hình trống mà tưởng thiết bị hỏng. Tắt camera thì hiển thị
   * thiệp mời như trước. */
  const selfPreview = tiles.length === 1 && state.camOn && Boolean(state.localStream);

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-[#122019] text-[#f2ead9]">
      {/* ================= HEADER ================= */}
      <header className="relative z-10 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[#35543f]/60 bg-[#152a20]/60 px-3 sm:px-4">
        {/* Bên trái: đồng hồ + tên lớp */}
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <span className="flex items-center gap-1.5 text-sm font-medium text-[#a3bca6]">
            <Clock className="h-4 w-4" aria-hidden />
            {now.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}
          </span>
          <button
            className="min-w-0 truncate rounded-full bg-[#1b3327] px-3 py-1 text-xs text-[#a3bca6] ring-1 ring-[#35543f] transition hover:bg-[#24402f] hover:text-[#f2ead9]"
            onClick={() => void copyToClipboard(props.roomId)}
            title="Bấm để sao chép mã lớp"
          >
            {state.roomTitle ? `${state.roomTitle} · ` : ""}
            {props.roomId.slice(0, 8)}…
          </button>
        </div>

        {/* Giữa: chip trạng thái + huy hiệu chủ phòng */}
        <div className="hidden flex-1 items-center justify-center gap-2 md:flex">
          {state.isHost && (
            <span className="flex items-center gap-1.5 rounded-full bg-[#eeb64e]/15 px-3 py-1 text-xs font-semibold text-[#eeb64e] ring-1 ring-[#eeb64e]/30">
              <Crown className="h-3.5 w-3.5" aria-hidden />
              Chủ phòng
            </span>
          )}
          {!state.micOn && (
            <span className="rounded-full bg-[#e14b32]/15 px-3 py-1 text-xs font-medium text-[#ef7d63] ring-1 ring-[#e14b32]/25">
              Đang tắt tiếng
            </span>
          )}
          {!state.camOn && (
            <span className="rounded-full bg-[#e14b32]/15 px-3 py-1 text-xs font-medium text-[#ef7d63] ring-1 ring-[#e14b32]/25">
              Camera đã tắt
            </span>
          )}
          {state.myScreenStream && (
            <span className="flex items-center gap-1.5 rounded-full bg-[#eeb64e]/15 px-3 py-1 text-xs font-medium text-[#eeb64e] ring-1 ring-[#eeb64e]/25">
              <MonitorStop className="h-3.5 w-3.5" aria-hidden />
              Đang chia sẻ màn hình
            </span>
          )}
          {state.rtt !== null && state.rtt < 400 && (
            <span className="rounded-full bg-[#1b3327] px-3 py-1 text-xs text-[#a3bca6] ring-1 ring-[#35543f]">
              {state.rtt} ms
            </span>
          )}
        </div>

        {/* Phải: nút chia sẻ liên kết + số người (mobile) */}
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => void shareLink()}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition ${
              linkCopied
                ? "bg-[#8fce9e]/15 text-[#8fce9e] ring-1 ring-[#8fce9e]/40"
                : "bg-[#eeb64e]/12 text-[#eeb64e] ring-1 ring-[#eeb64e]/35 hover:bg-[#eeb64e]/20"
            }`}
            title="Sao chép liên kết lớp gửi cho bạn học"
          >
            <Link2 className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">
              {linkCopied ? "Đã sao chép!" : "Liên kết lớp"}
            </span>
          </button>
          <span className="flex items-center gap-1 text-xs text-[#a3bca6] md:hidden">
            <Users className="h-4 w-4" aria-hidden />
            {state.sessions.length}
          </span>
        </div>
      </header>

      {/* Banner mỏng cảnh báo mất kết nối */}
      {connecting && (
        <div className="relative z-10 flex shrink-0 items-center justify-center gap-2 bg-[#e14b32]/15 px-4 py-1.5 text-xs text-[#ef7d63]">
          <WifiOff className="h-3.5 w-3.5" aria-hidden />
          {state.connectionError ?? "Đang kết nối tới máy chủ…"}
        </div>
      )}

      {/* ================= THÂN: VIDEO + PANEL ================= */}
      <div className="relative flex min-h-0 flex-1">
        <main className="relative flex min-h-0 flex-1 flex-col">
          <div className="meet-scroll relative z-10 min-h-0 flex-1 overflow-y-auto p-2 sm:p-3">
            {spotlight ? (
              /* ----- Bố cục TRÌNH CHIẾU khi có chia sẻ màn hình ----- */
              <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row">
                <div className="flex min-h-0 flex-1 items-center justify-center">
                  <VideoTile
                    stream={spotlight.stream}
                    name={spotlight.label}
                    camOn
                    micOn={false}
                    label={spotlight.label}
                    isSelf={spotlight.key === "self-screen"}
                    fit="contain"
                    className="h-full w-full"
                  />
                </div>
                <div className="meet-scroll flex shrink-0 gap-3 overflow-x-auto pb-1 lg:w-52 lg:flex-col lg:overflow-x-visible lg:overflow-y-auto lg:pb-0">
                  {tiles.map((tile) => (
                    <VideoTile
                      key={tile.key}
                      stream={tile.stream}
                      name={tile.session.name}
                      role={tile.session.role}
                      isSelf={tile.isSelf}
                      camOn={tile.session.camOn}
                      micOn={tile.session.micOn}
                      handRaised={tile.session.handRaised}
                      online={tile.session.online}
                      pcState={tile.pcState}
                      className="w-40 shrink-0 lg:w-full"
                    />
                  ))}
                </div>
              </div>
            ) : tiles.length > 1 || selfPreview ? (
              /* ----- LƯỚI NGƯỜI: flex-wrap, mỗi hàng tự căn giữa ----- */
              <div className="flex min-h-full">
                <div className="m-auto flex w-full max-w-6xl flex-wrap justify-center gap-3">
                  {tiles.map((tile) => (
                    <VideoTile
                      key={tile.key}
                      stream={tile.stream}
                      name={tile.session.name}
                      role={tile.session.role}
                      isSelf={tile.isSelf}
                      camOn={tile.session.camOn}
                      micOn={tile.session.micOn}
                      handRaised={tile.session.handRaised}
                      online={tile.session.online}
                      pcState={tile.pcState}
                      className={width}
                    />
                  ))}
                </div>
              </div>
            ) : (
              /* ----- Đang một mình trong lớp: thiệp mời ----- */
              <div className="flex min-h-full items-center justify-center">
                <BoardCard className="meet-fade-up w-full max-w-md">
                  <div className="p-6 text-center sm:p-8">
                    <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#8fce9e]/10 ring-1 ring-[#8fce9e]/25">
                      <Users className="h-7 w-7 text-[#8fce9e]" aria-hidden />
                    </span>
                    <p className="text-lg font-semibold">
                      {state.isHost
                        ? "Lớp đã mở — mời bạn học vào thôi!"
                        : "Đang chờ mọi người vào lớp…"}
                    </p>
                    <p className="mt-1.5 text-sm leading-relaxed text-[#a3bca6]">
                      Gửi liên kết lớp cho bạn học.
                      {state.isHost
                        ? " Họ sẽ gõ cửa và bạn bấm “Đồng ý” để cho vào."
                        : ""}
                    </p>
                    <button
                      onClick={() => void shareLink()}
                      className="mx-auto mt-5 flex h-11 items-center justify-center gap-2 rounded-full bg-[#e14b32] px-6 text-sm font-semibold text-[#fff6ee] shadow-lg shadow-black/25 hover:bg-[#ef5c42]"
                    >
                      <Link2 className="h-4 w-4" aria-hidden />
                      {linkCopied ? "Đã sao chép liên kết!" : "Sao chép liên kết lớp"}
                    </button>
                    <p className="mt-4 text-xs text-[#78917c]">
                      Mã lớp: <span className="font-mono">{props.roomId.slice(0, 8)}…</span>
                    </p>
                  </div>
                </BoardCard>
              </div>
            )}
          </div>

          {/* ================= THẺ NGƯỜI XIN VÀO LỚP (CHỦ PHÒNG) ================= */}
          {state.isHost && requests.length > 0 && (
            <div className="absolute bottom-[5.75rem] right-3 z-30 w-[min(92vw,21.5rem)] sm:right-5">
              <BoardCard className="meet-toast-enter shadow-2xl shadow-black/50">
                <div className="p-4">
                  <p className="flex items-center gap-2 text-sm font-semibold text-[#eeb64e]">
                    <UserPlus className="h-4 w-4" aria-hidden />
                    {requests.length} người xin vào lớp
                  </p>
                  {/* Luôn hiển thị TOÀN BỘ yêu cầu (danh sách cuộn được) —
                      lớp đông có nhiều người gõ cửa cùng lúc, chủ phòng phải
                      duyệt hết ngay tại thẻ này, không phải mở panel khác. */}
                  <ul className="meet-scroll mt-3 max-h-56 space-y-2 overflow-y-auto pr-1">
                    {requests.map((req) => (
                      <li
                        key={req.sessionId}
                        className="flex items-center gap-2.5 rounded-xl bg-[#152a20]/90 px-3 py-2 ring-1 ring-[#35543f]"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#24402f] text-xs font-semibold text-[#f2ead9] ring-1 ring-[#35543f]">
                          {req.name.trim().charAt(0).toUpperCase()}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{req.name}</p>
                          <p className="text-[11px] tabular-nums text-[#78917c]">
                            chờ {formatElapsed(req.requestedAt, now.getTime())}
                          </p>
                        </div>
                        <button
                          onClick={() => client.admitJoin(req.sessionId)}
                          className="h-9 shrink-0 rounded-full bg-[#8fce9e] px-3.5 text-xs font-semibold text-[#122019] transition hover:bg-[#a3dcae]"
                          aria-label={`Đồng ý cho ${req.name} vào lớp`}
                        >
                          Đồng ý
                        </button>
                        <button
                          onClick={() => client.denyJoin(req.sessionId)}
                          className="h-9 shrink-0 rounded-full border border-[#e14b32]/50 px-3.5 text-xs font-medium text-[#ef7d63] transition hover:bg-[#e14b32]/10"
                          aria-label={`Từ chối ${req.name} vào lớp`}
                        >
                          Từ chối
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </BoardCard>
            </div>
          )}

          {/* ================= THANH ĐIỀU KHIỂN NỔI ================= */}
          <ControlBar
            camOn={state.camOn}
            micOn={state.micOn}
            camLock={state.camLock}
            micLock={state.micLock}
            handRaised={state.handRaised}
            screenSharing={Boolean(state.myScreenStream)}
            participantCount={state.sessions.length}
            joinRequestCount={state.isHost ? requests.length : 0}
            chatUnread={state.unreadChat}
            panel={panel}
            onToggleCam={() => client.toggleCam()}
            onToggleMic={() => client.toggleMic()}
            onToggleHand={() => client.toggleHand()}
            onToggleScreen={toggleScreen}
            onTogglePanel={togglePanel}
            onShareLink={() => void shareLink()}
            onLeave={() => client.leave()}
          />
        </main>

        {/* ================= BẢNG BÊN PHẢI ================= */}
        <div className={panel ? "absolute inset-0 z-30 sm:static sm:z-auto" : "hidden"}>
          <SidePanel
            open={Boolean(panel)}
            tab={panel ?? "participants"}
            sessions={state.sessions}
            selfId={state.selfId}
            chat={state.chat}
            isHost={state.isHost}
            joinRequests={requests}
            nowMs={now.getTime()}
            onAdmit={(sessionId) => client.admitJoin(sessionId)}
            onDeny={(sessionId) => client.denyJoin(sessionId)}
            onKick={(sessionId) => client.kickSession(sessionId)}
            onCamControl={(sessionId, mode) => client.camControl(sessionId, mode)}
            onMicControl={(sessionId, mode) => client.micControl(sessionId, mode)}
            onClose={() => setPanel(null)}
            onSwitchTab={(t) => {
              setPanel(t);
              if (t === "chat") client.markChatRead();
            }}
            onSendChat={(text) => client.sendChat(text)}
            onChatVisible={markChatRead}
          />
        </div>
      </div>

      {/* ================= TOAST STACK (đỉnh giữa) ================= */}
      <div className="pointer-events-none absolute inset-x-0 top-16 z-40 flex flex-col items-center gap-2 px-4">
        {state.toasts.map((toast) => (
          <div
            key={toast.id}
            className={`meet-toast-enter pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl px-4 py-3 shadow-2xl ring-1 backdrop-blur ${
              toast.kind === "warning"
                ? "bg-[#3b1d18]/95 ring-[#ef7d63]/50"
                : toast.kind === "error"
                  ? "bg-[#3b1d18]/95 ring-[#ef7d63]/40"
                  : toast.kind === "success"
                    ? "bg-[#16301f]/95 ring-[#8fce9e]/40"
                    : "bg-[#1b3327]/95 ring-[#35543f]"
            }`}
            role={toast.kind === "warning" ? "alertdialog" : "status"}
            aria-live={toast.kind === "warning" ? "assertive" : "polite"}
          >
            <span className="mt-0.5 shrink-0">
              {toast.kind === "warning" ? (
                <AlertTriangle className="h-5 w-5 text-[#ef7d63]" aria-hidden />
              ) : toast.kind === "error" ? (
                <AlertTriangle className="h-5 w-5 text-[#ef7d63]" aria-hidden />
              ) : toast.kind === "success" ? (
                <Check className="h-5 w-5 text-[#8fce9e]" aria-hidden />
              ) : (
                <span className="block h-2 w-2 rounded-full bg-[#eeb64e]" aria-hidden />
              )}
            </span>
            <p className="flex-1 text-sm leading-relaxed text-[#f2ead9]">{toast.message}</p>
            <button
              onClick={() => client.dismissToast(toast.id)}
              className="shrink-0"
              aria-label="Đóng thông báo"
            >
              {toast.requireAck ? (
                <span className="rounded-full bg-[#f2ead9] px-3 py-1 text-xs font-medium text-[#122019]">
                  Đã hiểu
                </span>
              ) : (
                <X className="h-4 w-4 text-[#a3bca6] hover:text-[#f2ead9]" aria-hidden />
              )}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
