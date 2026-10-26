"use client";

/**
 * ============================================================================
 *  LỚP HỌC TRỰC TUYẾN — BẢNG ĐIỀU KHIỂN BÊN PHẢI (NGƯỜI THAM GIA + CHAT)
 * ----------------------------------------------------------------------------
 *  Hai tab trượt ra từ phải:
 *    • "Người tham gia":
 *        - CHỦ PHÒNG thấy khu "XIN VÀO LỚP" (Đồng ý / Từ chối) ngay đầu.
 *        - CHỦ PHÒNG điều khiển thiết bị từng thành viên (CEO: "BẬT là
 *          BẬT LUÔN, CẤM là CẤM LUÔN"): bật luôn / cấm / trả quyền cho
 *          cả camera lẫn micro — kèm mời ra khỏi lớp.
 *        - Huy hiệu "Chủ phòng" (vàng) cho vai trò host.
 *    • "Tin nhắn": chat lớp học theo thời gian thực.
 * ============================================================================
 */

import { useEffect, useRef, useState } from "react";
import {
  X,
  Send,
  Mic,
  MicOff,
  Video,
  VideoOff,
  Hand as HandIcon,
  ShieldCheck,
  Crown,
  Lock,
  LockOpen,
  UserMinus,
  UserPlus,
} from "lucide-react";
import type {
  ChatMessage,
  DeviceLock,
  JoinRequestPayload,
  PublicSession,
} from "@/lib/meet/types";

export interface SidePanelProps {
  open: boolean;
  tab: "participants" | "chat";
  sessions: PublicSession[];
  selfId: string;
  chat: ChatMessage[];
  /** Mình là chủ phòng (hiện nút điều hành)? */
  isHost?: boolean;
  /** Hàng chờ gõ cửa lớp (chỉ chủ phòng dùng). */
  joinRequests?: JoinRequestPayload[];
  /** Thời điểm hiện tại (Unix ms) — để đếm "đã chờ bao lâu". */
  nowMs?: number;
  onAdmit?: (sessionId: string) => void;
  onDeny?: (sessionId: string) => void;
  onKick?: (sessionId: string) => void;
  /** Đặt chế độ điều khiển camera thành viên: "on" = bật luôn, "off" = cấm,
   *  "free" = trả quyền (CEO: "BẬT là BẬT LUÔN, CẤM là CẤM LUÔN"). */
  onCamControl?: (sessionId: string, mode: DeviceLock) => void;
  /** Đặt chế độ điều khiển micro thành viên (ý nghĩa như onCamControl). */
  onMicControl?: (sessionId: string, mode: DeviceLock) => void;
  onClose: () => void;
  onSwitchTab: (tab: "participants" | "chat") => void;
  onSendChat: (text: string) => void;
  /** Thông báo đã đọc chat (xóa badge). */
  onChatVisible: () => void;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (
    parts[0].charAt(0) + parts[parts.length - 1].charAt(0)
  ).toUpperCase();
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Thời gian đã chờ, dạng gợi ý (45 giây / 2 phút…). */
function waitLabel(from: number, now: number): string {
  const s = Math.max(0, Math.floor((now - from) / 1000));
  if (s < 60) return `${s} giây`;
  const m = Math.floor(s / 60);
  return `${m} phút`;
}

export function SidePanel(props: SidePanelProps) {
  const [draft, setDraft] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const { onChatVisible } = props;

  /* Tự cuộn xuống tin cuối cùng + đánh dấu đã đọc khi tab chat đang mở. */
  const chatCount = props.chat.length;
  const tab = props.tab;
  const open = props.open;
  useEffect(() => {
    if (tab === "chat" && open) {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
      onChatVisible();
    }
  }, [chatCount, tab, open, onChatVisible]);

  if (!props.open) return null;

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    props.onSendChat(text);
    setDraft("");
  };

  const hosts = props.sessions.filter((s) => s.role === "host");
  const members = props.sessions.filter((s) => s.role === "member");
  const admins = props.sessions.filter((s) => s.role === "admin");
  const joinRequests = props.isHost ? (props.joinRequests ?? []) : [];
  const now = props.nowMs ?? Date.now();

  /** Nút điều hành nhỏ dùng cho từng thành viên (chủ phòng). */
  const modButton = (
    label: string,
    tone: "normal" | "danger",
    onClick: () => void,
    icon: React.ReactNode,
    disabled?: boolean
  ) => (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`meet-icon-btn flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition disabled:opacity-30 ${
        tone === "danger"
          ? "text-[#ef7d63] hover:bg-[#e14b32]/15"
          : "text-[#a3bca6] hover:bg-[#24402f] hover:text-[#f2ead9]"
      }`}
    >
      {icon}
    </button>
  );

  return (
    <aside className="flex h-full w-full max-w-full shrink-0 flex-col border-l border-[#35543f] bg-[#122019]/95 backdrop-blur-xl sm:w-[22rem]">
      {/* ===== HEADER: hai tab (viên thuốc phân đoạn) ===== */}
      <div className="flex items-center gap-2 border-b border-[#35543f] p-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 rounded-full bg-[#1b3327] p-1 ring-1 ring-[#35543f]">
          <button
            onClick={() => props.onSwitchTab("participants")}
            className={`min-w-0 flex-1 truncate rounded-full px-3 py-2 text-sm font-medium transition ${
              props.tab === "participants"
                ? "bg-[#24402f] text-[#eeb64e]"
                : "text-[#a3bca6] hover:text-[#f2ead9]"
            }`}
          >
            Người tham gia ({props.sessions.length})
            {joinRequests.length > 0 && (
              <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[#e14b32] px-1 text-[10px] font-bold text-[#fff6ee]">
                {joinRequests.length}
              </span>
            )}
          </button>
          <button
            onClick={() => props.onSwitchTab("chat")}
            className={`min-w-0 flex-1 truncate rounded-full px-3 py-2 text-sm font-medium transition ${
              props.tab === "chat"
                ? "bg-[#24402f] text-[#eeb64e]"
                : "text-[#a3bca6] hover:text-[#f2ead9]"
            }`}
          >
            Tin nhắn
          </button>
        </div>
        <button
          onClick={props.onClose}
          aria-label="Đóng bảng điều khiển"
          title="Đóng"
          className="meet-icon-btn flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[#a3bca6] hover:bg-[#24402f] hover:text-[#f2ead9]"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* ===== NỘI DUNG ===== */}
      {props.tab === "participants" ? (
        <div className="meet-scroll flex-1 overflow-y-auto p-3">
          {/* ---- XIN VÀO LỚP (chỉ chủ phòng) ---- */}
          {joinRequests.length > 0 && (
            <section className="mb-4">
              <p className="mb-2 mt-1 flex items-center gap-1.5 px-1 text-xs font-semibold text-[#eeb64e]">
                <UserPlus className="h-3.5 w-3.5" aria-hidden />
                Xin vào lớp — {joinRequests.length}
              </p>
              <ul className="space-y-2">
                {joinRequests.map((req) => (
                  <li
                    key={req.sessionId}
                    className="rounded-xl bg-[#eeb64e]/8 p-2.5 ring-1 ring-[#eeb64e]/25"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#24402f] text-xs font-semibold text-[#f2ead9] ring-1 ring-[#35543f]">
                        {initialsOf(req.name)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-[#f2ead9]">
                          {req.name}
                        </p>
                        <p className="text-[11px] tabular-nums text-[#a3bca6]">
                          chờ {waitLabel(req.requestedAt, now)} ·{" "}
                          {formatTime(req.requestedAt)}
                        </p>
                      </div>
                    </div>
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => props.onAdmit?.(req.sessionId)}
                        className="h-9 flex-1 rounded-full bg-[#8fce9e] text-xs font-semibold text-[#122019] transition hover:bg-[#a3dcae]"
                        aria-label={`Đồng ý cho ${req.name} vào lớp`}
                      >
                        Đồng ý vào lớp
                      </button>
                      <button
                        onClick={() => props.onDeny?.(req.sessionId)}
                        className="h-9 flex-1 rounded-full border border-[#e14b32]/50 text-xs font-medium text-[#ef7d63] transition hover:bg-[#e14b32]/10"
                        aria-label={`Từ chối ${req.name} vào lớp`}
                      >
                        Từ chối
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ---- Chủ phòng ---- */}
          {hosts.length > 0 && (
            <section className="mb-4">
              <p className="mb-2 mt-1 px-1 text-xs font-semibold text-[#78917c]">
                Chủ phòng — {hosts.length}
              </p>
              <ul className="space-y-1">
                {hosts.map((session) => (
                  <li
                    key={session.id}
                    className={`flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-[#1b3327] ${
                      session.online ? "" : "opacity-50"
                    }`}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#eeb64e]/20 text-[#eeb64e]">
                      <Crown className="h-4 w-4" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-[#f2ead9]">
                        {session.name}
                        {session.id === props.selfId && (
                          <span className="ml-1 text-xs text-[#a3bca6]">(Bạn)</span>
                        )}
                      </p>
                      {!session.online && (
                        <p className="text-xs text-[#ef7d63]">Đang kết nối lại…</p>
                      )}
                    </div>
                    <span className="shrink-0 rounded-full bg-[#eeb64e]/12 px-2 py-0.5 text-[10px] font-semibold text-[#eeb64e] ring-1 ring-[#eeb64e]/25">
                      Chủ phòng
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ---- Thành viên ---- */}
          {members.length > 0 && (
            <section>
              <p className="mb-2 mt-1 px-1 text-xs font-semibold text-[#78917c]">
                Thành viên — {members.length}
              </p>
              <ul className="space-y-1">
                {members.map((session) => {
                  const isSelf = session.id === props.selfId;
                  // Chủ phòng điều hành được MỌI thành viên trừ chính mình.
                  const canModerate = Boolean(props.isHost) && !isSelf;
                  return (
                    <li
                      key={session.id}
                      className={`flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-[#1b3327] ${
                        session.online ? "" : "opacity-50"
                      }`}
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#24402f] text-xs font-medium text-[#f2ead9] ring-1 ring-[#35543f]">
                        {initialsOf(session.name)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-[#f2ead9]">
                          {session.name}
                          {isSelf && (
                            <span className="ml-1 text-xs text-[#a3bca6]">(Bạn)</span>
                          )}
                        </p>
                        {!session.online && (
                          <p className="text-xs text-[#ef7d63]">Đang kết nối lại…</p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        {session.handRaised && (
                          <HandIcon
                            className="h-4 w-4 text-[#eeb64e]"
                            aria-label="Đang giơ tay"
                          />
                        )}
                        {session.camLock !== "none" && (
                          <span
                            className={`flex h-5 items-center gap-0.5 rounded-full px-1.5 text-[10px] font-medium ${
                              session.camLock === "off"
                                ? "bg-[#e14b32]/15 text-[#ef7d63]"
                                : "bg-[#8fce9e]/15 text-[#8fce9e]"
                            }`}
                            title={
                              session.camLock === "off"
                                ? "Camera bị CẤM — không thể tự bật"
                                : "Camera bị BẬT LUÔN — không thể tự tắt"
                            }
                          >
                            <Lock className="h-3 w-3" aria-hidden />
                            Cam
                          </span>
                        )}
                        {session.micLock !== "none" && (
                          <span
                            className={`flex h-5 items-center gap-0.5 rounded-full px-1.5 text-[10px] font-medium ${
                              session.micLock === "off"
                                ? "bg-[#e14b32]/15 text-[#ef7d63]"
                                : "bg-[#8fce9e]/15 text-[#8fce9e]"
                            }`}
                            title={
                              session.micLock === "off"
                                ? "Micro bị CẤM — không thể tự bật"
                                : "Micro bị BẬT LUÔN — không thể tự tắt"
                            }
                          >
                            <Lock className="h-3 w-3" aria-hidden />
                            Mic
                          </span>
                        )}
                        {session.micOn ? (
                          <Mic className="h-4 w-4 text-[#a3bca6]" aria-label="Micro bật" />
                        ) : (
                          <MicOff className="h-4 w-4 text-[#ef7d63]" aria-label="Micro tắt" />
                        )}
                        {session.camOn ? (
                          <Video className="h-4 w-4 text-[#a3bca6]" aria-label="Camera bật" />
                        ) : (
                          <VideoOff className="h-4 w-4 text-[#78917c]" aria-label="Camera tắt" />
                        )}
                        {canModerate && (
                          <>
                            {/* ĐIỀU KHIỂN CAMERA: Bật luôn / Cấm (bấm lặp lại
                                đảo chiều) — CEO: "BẬT là BẬT LUÔN, CẤM là
                                CẤM LUÔN". */}
                            <button
                              onClick={() =>
                                props.onCamControl?.(
                                  session.id,
                                  session.camLock === "on"
                                    ? "off"
                                    : session.camLock === "off"
                                      ? "on"
                                      : session.camOn
                                        ? "off"
                                        : "on"
                                )
                              }
                              aria-label={
                                session.camLock === "on"
                                  ? `Camera ${session.name} đang bị bật luôn — bấm để CẤM`
                                  : session.camLock === "off"
                                    ? `Camera ${session.name} đang bị cấm — bấm để BẬT NGAY`
                                    : session.camOn
                                      ? `Cấm camera của ${session.name} (họ không bật lại được)`
                                      : `Bật camera của ${session.name} NGAY (không cần xin phép)`
                              }
                              title="Điều khiển camera: Bật luôn / Cấm"
                              className={`meet-icon-btn flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition ${
                                session.camLock !== "none"
                                  ? "bg-[#eeb64e]/15 text-[#eeb64e] hover:bg-[#eeb64e]/25"
                                  : session.camOn
                                    ? "text-[#a3bca6] hover:bg-[#24402f] hover:text-[#f2ead9]"
                                    : "text-[#eeb64e] hover:bg-[#eeb64e]/15"
                              }`}
                            >
                              {session.camLock !== "none" ? (
                                <Lock className="h-4 w-4" aria-hidden />
                              ) : session.camOn ? (
                                <VideoOff className="h-4 w-4" aria-hidden />
                              ) : (
                                <Video className="h-4 w-4" aria-hidden />
                              )}
                            </button>
                            {/* ĐIỀU KHIỂN MICRO: đối xứng camera. */}
                            <button
                              onClick={() =>
                                props.onMicControl?.(
                                  session.id,
                                  session.micLock === "on"
                                    ? "off"
                                    : session.micLock === "off"
                                      ? "on"
                                      : session.micOn
                                        ? "off"
                                        : "on"
                                )
                              }
                              aria-label={
                                session.micLock === "on"
                                  ? `Micro ${session.name} đang bị bật luôn — bấm để CẤM`
                                  : session.micLock === "off"
                                    ? `Micro ${session.name} đang bị cấm — bấm để BẬT NGAY`
                                    : session.micOn
                                      ? `Cấm micro của ${session.name} (họ không bật lại được)`
                                      : `Bật micro của ${session.name} NGAY`
                              }
                              title="Điều khiển micro: Bật luôn / Cấm"
                              className={`meet-icon-btn flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition ${
                                session.micLock !== "none"
                                  ? "bg-[#eeb64e]/15 text-[#eeb64e] hover:bg-[#eeb64e]/25"
                                  : session.micOn
                                    ? "text-[#a3bca6] hover:bg-[#24402f] hover:text-[#f2ead9]"
                                    : "text-[#eeb64e] hover:bg-[#eeb64e]/15"
                              }`}
                            >
                              {session.micLock !== "none" ? (
                                <Lock className="h-4 w-4" aria-hidden />
                              ) : session.micOn ? (
                                <MicOff className="h-4 w-4" aria-hidden />
                              ) : (
                                <Mic className="h-4 w-4" aria-hidden />
                              )}
                            </button>
                            {/* TRẢ QUYỀN cả cam lẫn mic (chỉ hiện khi có khoá). */}
                            {(session.camLock !== "none" || session.micLock !== "none") && (
                              <button
                                onClick={() => {
                                  if (session.camLock !== "none")
                                    props.onCamControl?.(session.id, "none");
                                  if (session.micLock !== "none")
                                    props.onMicControl?.(session.id, "none");
                                }}
                                aria-label={`Trả quyền cam/micro cho ${session.name}`}
                                title="Trả quyền điều khiển cam/micro cho họ"
                                className="meet-icon-btn flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#8fce9e] transition hover:bg-[#8fce9e]/15"
                              >
                                <LockOpen className="h-4 w-4" aria-hidden />
                              </button>
                            )}
                            {modButton(
                              `Mời ${session.name} ra khỏi lớp`,
                              "danger",
                              () => props.onKick?.(session.id),
                              <UserMinus className="h-4 w-4" aria-hidden />
                            )}
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* ---- Quản trị viên web (chủ web) ---- */}
          {admins.length > 0 && (
            <section className="mt-4">
              <p className="mb-2 px-1 text-xs font-semibold text-[#78917c]">
                Quản trị viên web — {admins.length}
              </p>
              <ul className="space-y-1">
                {admins.map((session) => (
                  <li
                    key={session.id}
                    className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-[#1b3327]"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#8fce9e]/20 text-[#8fce9e]">
                      <ShieldCheck className="h-4 w-4" aria-hidden />
                    </span>
                    <p className="min-w-0 flex-1 truncate text-sm text-[#f2ead9]">
                      {session.name}
                    </p>
                    {!session.online && (
                      <span className="text-xs text-[#ef7d63]">Ngoại tuyến</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Danh sách tin nhắn */}
          <div className="meet-scroll flex-1 space-y-3 overflow-y-auto p-3">
            {props.chat.length === 0 && (
              <p className="mt-8 text-center text-xs text-[#78917c]">
                Chưa có tin nhắn nào. Hãy gửi lời chào cả lớp.
              </p>
            )}
            {props.chat.map((msg) => {
              const isSelf = msg.sessionId === props.selfId;
              return (
                <div
                  key={msg.id}
                  className={`flex flex-col ${isSelf ? "items-end" : "items-start"}`}
                >
                  <p className="mb-1 px-1 text-xs text-[#a3bca6]">
                    {isSelf ? "Bạn" : msg.name} · {formatTime(msg.ts)}
                  </p>
                  <div
                    className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                      isSelf
                        ? "rounded-br-md bg-[#7a3121] text-[#f8ece4]"
                        : "rounded-bl-md bg-[#24402f] text-[#f2ead9]"
                    }`}
                  >
                    {msg.text}
                  </div>
                </div>
              );
            })}
            <div ref={chatEndRef} />
          </div>

          {/* Ô soạn tin */}
          <div className="border-t border-[#35543f] p-3">
            <div className="flex items-center gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="Gửi tin nhắn tới cả lớp…"
                maxLength={1000}
                aria-label="Soạn tin nhắn"
                className="h-11 flex-1 rounded-full border border-[#35543f] bg-[#1b3327] px-4 text-sm text-[#f2ead9] placeholder:text-[#78917c] focus:border-[#eeb64e]/60 focus:outline-none"
              />
              <button
                onClick={send}
                disabled={draft.trim().length === 0}
                aria-label="Gửi tin nhắn"
                title="Gửi"
                className="meet-icon-btn flex h-11 w-11 items-center justify-center rounded-full bg-[#e14b32] text-[#fff6ee] transition hover:bg-[#ef5c42] disabled:opacity-40"
              >
                <Send className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
