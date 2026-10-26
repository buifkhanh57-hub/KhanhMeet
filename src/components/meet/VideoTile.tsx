"use client";

/**
 * ============================================================================
 *  LỚP HỌC TRỰC TUYẾN — Ô VIDEO NGƯỜI THAM GIA
 * ----------------------------------------------------------------------------
 *  • Tỉ lệ khung LUÔN 16:9 chuẩn (aspect-video) — video dùng object-fit:
 *      - fit="cover"   (mặc định): camera lấp đầy ô, CẮT phần thừa — không
 *        bao giờ bị KÉO DÀN/MÉO hình.
 *      - fit="contain" : chia sẻ màn hình hiển thị NGUYÊN VẸN nội dung (chữ
 *        không bị cắt), phần dư hai bên tô đen.
 *  • Name Tag góc dưới trái; badge bàn tay VÀNG khi giơ tay; huy hiệu
 *    "Chủ phòng" cho vai trò host.
 *  • Vòng sáng vàng nắng khi đang nói (đo bằng Web Audio API).
 *  • Trạng thái: camera tắt (avatar chữ cái đầu), đang kết nối, mất kết nối.
 *  • Biến thể "cctv" cho bảng điều khiển chủ web: chấm LIVE + nút bật tiếng.
 * ============================================================================
 */

import { useEffect, useRef, useState } from "react";
import {
  MicOff,
  Hand as HandIcon,
  MonitorPlay,
  Volume2,
  VolumeX,
  Loader2,
  WifiOff,
  VideoOff,
  Crown,
} from "lucide-react";
import { useAudioLevel } from "@/lib/meet/audio-meter";
import type { Role } from "@/lib/meet/types";

export interface VideoTileProps {
  stream: MediaStream | null;
  name: string;
  /** Vai trò — "host" hiển thị huy hiệu Chủ phòng trên nhãn tên. */
  role?: Role;
  isSelf?: boolean;
  camOn: boolean;
  micOn: boolean;
  handRaised?: boolean;
  online?: boolean;
  pcState?: RTCPeerConnectionState;
  /** Biến thể bảng điều khiển chủ web (CCTV): chấm LIVE + nút bật tiếng. */
  variant?: "meet" | "cctv";
  /** Nhãn phụ (VD: "Màn hình của An"). Có nhãn = ô chia sẻ màn hình. */
  label?: string;
  /**
   * Cách hiển thị video:
   *  - "cover"   : lấp đầy ô, cắt phần thừa (camera — chuẩn Meet).
   *  - "contain" : giữ nguyên tỉ lệ nội dung, không cắt (chia sẻ màn hình).
   */
  fit?: "cover" | "contain";
  /** Tiếng mặc định cho ô NGƯỜI KHÁC (biến thể meet): false = NGHE NGAY. */
  defaultMuted?: boolean;
  className?: string;
}

/** Chữ cái đầu của tên để làm avatar khi camera tắt. */
function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : "?";
}

export function VideoTile({
  stream,
  name,
  role,
  isSelf = false,
  camOn,
  micOn,
  handRaised = false,
  online = true,
  pcState,
  variant = "meet",
  label,
  fit,
  defaultMuted = false,
  className = "",
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  /* Ô NGƯỜI KHÁC (meet) nghe tiếng NGAY; ô CCTV (chủ web) tắt tiếng mặc định
     (nghe phải bấm nút bật tiếng riêng — chuẩn giám sát). Ô của chính mình
     luôn tắt tiếng để không gây vọng. */
  const [muted, setMuted] = useState(variant === "cctv" ? true : defaultMuted);
  /* Trình duyệt chặn tự phát tiếng khi chưa có tương tác — hiện nút
     "Bấm để nghe" rồi tự thử lại ở cú chạm kế tiếp. */
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  /* Ô chia sẻ màn hình mặc định contain; ô camera mặc định cover. */
  const isScreenTile = Boolean(label);
  const resolvedFit = fit ?? (isScreenTile ? "contain" : "cover");

  /* Gắn MediaStream vào thẻ video mỗi khi stream thay đổi + tự phát.
     Chrome cho phát tiếng sau khi người dùng đã bấm nút vào lớp; Safari iOS
     hay chặn → bắt lỗi và thử lại ở pointerdown kế tiếp. */
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.srcObject !== stream) {
      el.srcObject = stream;
    }
    if (!stream) return;
    const tryPlay = () => {
      el.play()
        .then(() => setAutoplayBlocked(false))
        .catch(() => setAutoplayBlocked(true));
    };
    if (el.readyState >= 2) {
      tryPlay();
    } else {
      el.addEventListener("loadeddata", tryPlay, { once: true });
    }
  }, [stream]);

  /* Mở lại tiếng (nút CCTV) → gọi play() ngay trong cú bấm của người dùng. */
  useEffect(() => {
    if (!muted && !isSelf && videoRef.current) {
      videoRef.current.play().catch(() => undefined);
    }
  }, [muted, isSelf]);

  /* Tự thử lại khi autoplay bị chặn và người dùng vừa chạm màn hình. */
  useEffect(() => {
    if (!autoplayBlocked) return;
    const resume = () => {
      videoRef.current?.play().then(
        () => setAutoplayBlocked(false),
        () => undefined
      );
    };
    document.addEventListener("pointerdown", resume, { once: true });
    return () => document.removeEventListener("pointerdown", resume);
  }, [autoplayBlocked]);

  /* Đo mức âm thanh để vẽ vòng "đang nói" (bỏ qua ô màn hình). */
  const audioLevel = useAudioLevel(
    !isScreenTile && micOn ? stream : null,
    micOn
  );
  const speaking = micOn && audioLevel > 0.09;

  const connecting =
    !isSelf && pcState !== undefined && pcState !== "connected" && online;
  const offline = !isSelf && !online;
  const showVideo = stream && (camOn || isScreenTile) && !offline;

  return (
    <div
      className={`group relative aspect-video overflow-hidden rounded-2xl bg-[#0e1c14] ring-1 ring-[#6b4a2b]/50 transition hover:ring-[#8a5f36]/70 ${
        speaking ? "meet-speaking" : ""
      } ${className}`}
      data-speaking={speaking}
    >
      {/* ---- Phần tử video ---- */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isSelf || muted}
        className={`h-full w-full ${
          resolvedFit === "contain" ? "object-contain" : "object-cover"
        } ${
          isSelf && !isScreenTile ? "meet-mirror" : ""
        } ${showVideo ? "" : "invisible"} ${
          resolvedFit === "contain" ? "bg-black" : ""
        }`}
        aria-label={`${label ?? "Video"} của ${name}`}
      />

      {/* ---- Camera tắt: avatar chữ cái đầu ---- */}
      {!showVideo && !offline && !connecting && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[#24402f] text-xl font-medium text-[#f2ead9] ring-1 ring-[#35543f] sm:h-20 sm:w-20 sm:text-2xl">
            {initialOf(name)}
          </span>
        </div>
      )}

      {/* ---- Đang thiết lập kết nối WebRTC ---- */}
      {connecting && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#122019]/70 text-[#a3bca6]">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
          <span className="text-xs">Đang kết nối…</span>
        </div>
      )}

      {/* ---- Mất kết nối (chờ tự kết nối lại) ---- */}
      {offline && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#122019]/85 text-[#a3bca6]">
          <WifiOff className="h-7 w-7" aria-hidden />
          <span className="text-xs">Mất kết nối — đang chờ thử lại…</span>
        </div>
      )}

      {/* ---- Trình duyệt chặn tự phát tiếng: nút "Bấm để nghe" ---- */}
      {autoplayBlocked && !isSelf && !muted && !isScreenTile && !offline && (
        <button
          onClick={() => {
            setAutoplayBlocked(false);
            videoRef.current?.play().catch(() => undefined);
          }}
          className="absolute left-2.5 top-2.5 flex h-9 items-center gap-1.5 rounded-full bg-[#e14b32] px-3 text-xs font-semibold text-[#fff6ee] shadow-lg"
          aria-label={`Bấm để nghe tiếng của ${name}`}
        >
          <Volume2 className="h-4 w-4" aria-hidden />
          Bấm để nghe
        </button>
      )}

      {/* ---- CCTV (chủ web): chấm LIVE + nút bật tiếng ---- */}
      {variant === "cctv" && (
        <>
          <div className="pointer-events-none absolute left-2.5 top-2.5 flex items-center gap-1.5 rounded-full bg-[#122019]/75 px-2.5 py-1 text-[10px] font-semibold tracking-wide text-[#8fce9e] backdrop-blur">
            <span className="meet-rec-dot h-2 w-2 rounded-full bg-[#8fce9e]" aria-hidden />
            {offline ? "MẤT TÍN HIỆU" : "TRỰC TIẾP"}
          </div>
          <button
            onClick={() => setMuted((m) => !m)}
            className="meet-icon-btn absolute right-2.5 top-2.5 flex h-8 w-8 items-center justify-center rounded-full bg-[#122019]/75 text-[#f2ead9] opacity-0 backdrop-blur transition hover:bg-[#24402f] focus-visible:opacity-100 group-hover:opacity-100"
            aria-label={muted ? `Bật tiếng ô của ${name}` : `Tắt tiếng ô của ${name}`}
            title={muted ? "Bật tiếng để nghe" : "Đang bật tiếng — bấm để tắt"}
          >
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4 text-[#8fce9e]" />}
          </button>
        </>
      )}

      {/* ---- Badge GIƠ TAY (vàng, góc phải) ---- */}
      {handRaised && (
        <div
          className="meet-hand-wave absolute right-2.5 top-2.5 flex h-9 w-9 items-center justify-center rounded-full bg-[#eeb64e] text-[#122019] shadow-lg"
          style={variant === "cctv" ? { top: "2.75rem" } : undefined}
          title={`${name} đang giơ tay`}
          role="status"
        >
          <HandIcon className="h-5 w-5" aria-hidden />
        </div>
      )}

      {/* ---- Huy hiệu CHỦ PHÒNG (góc phải trên, khi không giơ tay) ---- */}
      {role === "host" && !handRaised && (
        <div
          className={`pointer-events-none absolute right-2.5 flex items-center gap-1 rounded-full bg-[#122019]/75 px-2 py-1 text-[10px] font-semibold text-[#eeb64e] ring-1 ring-[#eeb64e]/35 backdrop-blur ${
            variant === "cctv" ? "top-[2.75rem]" : "top-2.5"
          }`}
          title="Chủ phòng — người tạo cuộc họp"
        >
          <Crown className="h-3 w-3" aria-hidden />
          Chủ phòng
        </div>
      )}

      {/* ---- Nhãn ô màn hình chia sẻ ---- */}
      {isScreenTile && (
        <div className="pointer-events-none absolute bottom-12 left-2.5 flex items-center gap-1.5 rounded-full bg-[#122019]/75 px-2.5 py-1 text-[10px] font-medium text-[#8fce9e] backdrop-blur">
          <MonitorPlay className="h-3.5 w-3.5" aria-hidden />
          {label}
        </div>
      )}

      {/* ---- NAME TAG góc dưới trái ---- */}
      <div className="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 backdrop-blur">
        {!micOn && !isScreenTile && (
          <MicOff className="h-3.5 w-3.5 shrink-0 text-[#ef7d63]" aria-hidden />
        )}
        {camOn === false && !isScreenTile && (
          <VideoOff className="h-3.5 w-3.5 shrink-0 text-[#a3bca6]" aria-hidden />
        )}
        <span className="truncate text-xs font-medium text-[#f7f2e8]">
          {name}
          {isSelf ? " (Bạn)" : ""}
        </span>
      </div>
    </div>
  );
}
