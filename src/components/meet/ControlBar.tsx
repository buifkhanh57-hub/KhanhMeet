"use client";

/**
 * ============================================================================
 *  LỚP HỌC TRỰC TUYẾN — THANH CÔNG CỤ DƯỚI ĐÁY (BOTTOM CONTROL BAR)
 * ----------------------------------------------------------------------------
 *    • Trái : Mic / Camera / Giơ tay / Chia sẻ màn hình.
 *    • Phải: Liên kết lớp (mời bạn học) / Người tham gia (badge số lượng +
 *      chấm đỏ khi có người xin vào) / Chat (badge chưa đọc) / Rời lớp.
 *  Tắt cam/mic là TẮT THẬT — không có luồng ngầm phía sau.
 *  KHOÁ THIẾT BỊ (CEO: "BẬT là BẬT LUÔN, CẤM là CẤM LUÔN"): khi chủ phòng
 *  cấm/bật luôn thiết bị của mình, nút tương ứng đeo badge khoá vàng —
 *  bấm sẽ hiện toast giải thích (không thao tác được cho tới khi trả quyền).
 * ============================================================================
 */

import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  Hand as HandIcon,
  MonitorUp,
  MonitorStop,
  MessageSquare,
  Users,
  PhoneOff,
  Link2,
  Lock,
} from "lucide-react";
import type { DeviceLock } from "@/lib/meet/types";

export interface ControlBarProps {
  camOn: boolean;
  micOn: boolean;
  /** Khoá camera của chính mình ("off" = bị cấm; "on" = bị bật luôn). */
  camLock?: DeviceLock;
  /** Khoá micro của chính mình (ý nghĩa như camLock). */
  micLock?: DeviceLock;
  handRaised: boolean;
  screenSharing: boolean;
  participantCount: number;
  /** Số người đang xin vào lớp (chỉ chủ phòng nhận > 0). */
  joinRequestCount?: number;
  chatUnread: number;
  panel: "chat" | "participants" | null;
  onToggleCam: () => void;
  onToggleMic: () => void;
  onToggleHand: () => void;
  onToggleScreen: () => void;
  onTogglePanel: (panel: "chat" | "participants") => void;
  /** Sao chép liên kết lớp để mời bạn học. */
  onShareLink: () => void;
  onLeave: () => void;
}

/** Nút tròn cơ bản của thanh công cụ (44–48px — đạt chuẩn touch target). */
function RoundButton({
  active,
  activeGold,
  danger,
  label,
  onClick,
  children,
  lockBadge,
}: {
  active?: boolean;
  activeGold?: boolean;
  danger?: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  /** "off" = bị cấm, "on" = bị bật luôn → đeo badge khoá vàng. */
  lockBadge?: DeviceLock;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`meet-icon-btn relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors sm:h-12 sm:w-12 ${
        lockBadge && lockBadge !== "none"
          ? "bg-[#eeb64e]/15 text-[#eeb64e] hover:bg-[#eeb64e]/25"
          : danger
            ? "bg-[#e14b32] text-[#fff6ee] hover:bg-[#ef5c42]"
            : activeGold
              ? "bg-[#eeb64e]/15 text-[#eeb64e] hover:bg-[#eeb64e]/25"
              : active
                ? "bg-[#8fce9e]/15 text-[#8fce9e] hover:bg-[#8fce9e]/25"
                : "bg-transparent text-[#f2ead9] hover:bg-white/10"
      }`}
    >
      {children}
      {lockBadge && lockBadge !== "none" && (
        <span
          className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-[#eeb64e] text-[#122019] ring-2 ring-[#152a20]"
          aria-hidden
        >
          <Lock className="h-2.5 w-2.5" />
        </span>
      )}
    </button>
  );
}

export function ControlBar(props: ControlBarProps) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
      <div className="meet-scroll pointer-events-auto flex max-w-[calc(100vw-0.5rem)] items-center gap-1 overflow-x-auto rounded-[2rem] bg-[#152a20]/95 px-3 py-2 shadow-2xl shadow-black/50 ring-1 ring-[#6b4a2b]/60 backdrop-blur-xl supports-[backdrop-filter]:bg-[#152a20]/85">
        {/* ===== NHÓM TRÁI: điều khiển thiết bị ===== */}
        <div className="flex items-center gap-1">
          <RoundButton
            active={props.micOn}
            danger={!props.micOn}
            lockBadge={props.micLock}
            label={
              props.micLock === "off"
                ? "Micro bị chủ phòng CẤM — không thể tự bật"
                : props.micLock === "on"
                  ? "Micro bị chủ phòng BẬT LUÔN — không thể tự tắt"
                  : props.micOn
                    ? "Tắt tiếng micro"
                    : "Bật tiếng micro"
            }
            onClick={props.onToggleMic}
          >
            {props.micOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
          </RoundButton>

          <RoundButton
            active={props.camOn}
            danger={!props.camOn}
            lockBadge={props.camLock}
            label={
              props.camLock === "off"
                ? "Camera bị chủ phòng CẤM — không thể tự bật"
                : props.camLock === "on"
                  ? "Camera bị chủ phòng BẬT LUÔN — không thể tự tắt"
                  : props.camOn
                    ? "Tắt camera"
                    : "Bật camera"
            }
            onClick={props.onToggleCam}
          >
            {props.camOn ? (
              <Video className="h-5 w-5" />
            ) : (
              <VideoOff className="h-5 w-5" />
            )}
          </RoundButton>

          <RoundButton
            activeGold={props.handRaised}
            label={props.handRaised ? "Hạ tay" : "Giơ tay phát biểu"}
            onClick={props.onToggleHand}
          >
            <HandIcon
              className={`h-5 w-5 ${props.handRaised ? "text-[#eeb64e]" : ""}`}
            />
          </RoundButton>

          <RoundButton
            active={props.screenSharing}
            label={
              props.screenSharing ? "Dừng chia sẻ màn hình" : "Chia sẻ màn hình"
            }
            onClick={props.onToggleScreen}
          >
            {props.screenSharing ? (
              <MonitorStop className="h-5 w-5" />
            ) : (
              <MonitorUp className="h-5 w-5" />
            )}
          </RoundButton>
        </div>

        {/* Đường phân cách */}
        <div className="mx-1 h-8 w-px shrink-0 bg-[#35543f] sm:mx-2" aria-hidden />

        {/* ===== NHÓM PHẢI: mời bạn học, bảng điều khiển & rời lớp ===== */}
        <div className="flex items-center gap-1">
          <RoundButton
            label="Sao chép liên kết lớp học"
            onClick={props.onShareLink}
          >
            <Link2 className="h-5 w-5 text-[#eeb64e]" />
          </RoundButton>

          <button
            onClick={() => props.onTogglePanel("participants")}
            aria-label={`Danh sách người tham gia (${props.participantCount})`}
            title="Danh sách người tham gia"
            className={`meet-icon-btn relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors sm:h-12 sm:w-12 ${
              props.panel === "participants"
                ? "bg-[#8fce9e]/15 text-[#8fce9e]"
                : "text-[#f2ead9] hover:bg-white/10"
            }`}
          >
            <Users className="h-5 w-5" />
            <span className="absolute -right-0.5 top-1 min-w-5 rounded-full bg-[#8fce9e] px-1 text-[10px] font-semibold leading-5 text-[#122019]">
              {props.participantCount}
            </span>
            {(props.joinRequestCount ?? 0) > 0 && (
              <span
                className="absolute -left-0.5 top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[#e14b32] px-1 text-[9px] font-bold text-[#fff6ee] ring-2 ring-[#152a20]"
                aria-label={`${props.joinRequestCount} người xin vào lớp`}
              >
                {props.joinRequestCount}
              </span>
            )}
          </button>

          <button
            onClick={() => props.onTogglePanel("chat")}
            aria-label={
              props.chatUnread > 0
                ? `Tin nhắn (${props.chatUnread} chưa đọc)`
                : "Tin nhắn trong lớp học"
            }
            title="Tin nhắn"
            className={`meet-icon-btn relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors sm:h-12 sm:w-12 ${
              props.panel === "chat"
                ? "bg-[#8fce9e]/15 text-[#8fce9e]"
                : "text-[#f2ead9] hover:bg-white/10"
            }`}
          >
            <MessageSquare className="h-5 w-5" />
            {props.chatUnread > 0 && (
              <span className="absolute -right-0.5 top-1 min-w-5 rounded-full bg-[#e14b32] px-1 text-[10px] font-semibold leading-5 text-[#fff6ee]">
                {props.chatUnread > 99 ? "99+" : props.chatUnread}
              </span>
            )}
          </button>

          <button
            onClick={props.onLeave}
            aria-label="Rời khỏi lớp học"
            title="Rời khỏi lớp học"
            className="meet-icon-btn ml-1 flex h-11 shrink-0 items-center gap-2 rounded-full bg-[#d3392a] px-3.5 text-sm font-medium text-[#fff6ee] transition hover:bg-[#e14b32] sm:h-12 sm:px-5"
          >
            <PhoneOff className="h-5 w-5" aria-hidden />
            <span className="hidden sm:inline">Rời lớp học</span>
          </button>
        </div>
      </div>
    </div>
  );
}
