"use strict";
/**
 * ============================================================================
 *  LỚP HỌC TRỰC TUYẾN — BẢNG ĐIỀU KHIỂN CHỦ WEB (TAB RIÊNG, mở bằng MÃ CHỦ WEB)
 * ----------------------------------------------------------------------------
 *  Được render như một TAB RIÊNG bên trong trang chủ khi chủ web nhập đúng mã
 *  (ô nhỏ góc trái dưới). Người thường không bao giờ thấy màn này.
 *
 *  Bố cục:
 *    • Cột trái : danh sách TOÀN BỘ lớp học đang hoạt động (realtime).
 *    • Giữa     : CCTV lớp đang chọn — luồng trực tiếp từng người (cả CHỦ
 *      PHÒNG lẫn thành viên), chip RTT màu, trạng thái cam/mic, giơ tay,
 *      chia sẻ màn hình; ĐIỀU KHIỂN THIẾT BỊ từng người (CEO yêu cầu
 *      "BẬT là BẬT LUÔN, CẤM là CẤM LUÔN"): Bật luôn / Cấm / Tự do cho
 *      cả camera lẫn micro; cùng Cảnh báo / Ghi chú / Đuổi.
 *    • Cột phải : Nhật ký hoạt động (realtime + lịch sử), Ghi chú, Thảo luận.
 *    • Hành động cả lớp: Cảnh báo đồng loạt + TAN LỚP (kết thúc buổi học,
 *      đuổi hết người và đóng lớp VĨNH VIỄN — liên kết cũ chết).
 *
 *  Khi chủ web mở một lớp, họ xuất hiện công khai trong danh sách người
 *  tham gia với vai trò "Quản trị viên web" (minh bạch — không ẩn mình).
 *  CHỦ PHÒNG (host — người tạo cuộc họp) cũng hiện rõ huy hiệu vàng.
 * ============================================================================
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  DoorOpen,
  Home,
  Loader2,
  Lock,
  Megaphone,
  StickyNote,
  UserX,
  Users,
  Wifi,
  WifiOff,
  MonitorPlay,
  Hand as HandIcon,
  Video,
  VideoOff,
  Mic,
  MicOff,
  Send,
  Activity,
  ShieldCheck,
  X,
  PhoneOff,
  Info,
  Crown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { OwnerClient, type OwnerState } from "@/lib/meet/owner-client";
import { useClientState } from "@/hooks/use-client-state";
import { VideoTile } from "./VideoTile";
import {
  EVENT_LABELS,
  SEVERITY_LABELS,
  type DeviceLock,
  type EventPayload,
  type NotePayload,
  type PublicSession,
} from "@/lib/meet/types";

/* ========================================================================== */
/* TIỆN ÍCH HIỂN THỊ                                                         */
/* ========================================================================== */

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Chỉ số độ trễ (RTT) với màu theo mức chất lượng. */
function RttChip({ rtt }: { rtt: number | null }) {
  const text = rtt === null ? "—" : `${rtt} ms`;
  const cls =
    rtt === null
      ? "bg-[#24402f] text-[#a3bca6]"
      : rtt < 120
        ? "bg-[#8fce9e]/15 text-[#8fce9e]"
        : rtt < 300
          ? "bg-[#eeb64e]/15 text-[#eeb64e]"
          : "bg-[#ef7d63]/15 text-[#ef7d63]";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${cls}`}>
      {text}
    </span>
  );
}

/* ========================================================================== */
/* OWNER CONSOLE — vòng đời OwnerClient                                       */
/* ========================================================================== */

export function OwnerConsole({
  code,
  onExit,
  onInvalid,
}: {
  /** MÃ CHỦ WEB (đã nhập ở góc trái dưới trang chủ). */
  code: string;
  /** Thoát tab riêng, về trang chủ thường. */
  onExit: () => void;
  /** Mã không hợp lệ — xoá mã đã lưu, về trang chủ nhập lại. */
  onInvalid: () => void;
}) {
  /*
   * Lazy initializer an toàn SSR: constructor chưa mở socket nào.
   * connect() diễn ra trong useEffect; unmount → destroy().
   */
  const [client] = useState(
    () => new OwnerClient({ ownerKey: code, name: "Quản trị viên web" })
  );
  const state = useClientState(client);

  useEffect(() => {
    client.connect();
    return () => client.destroy();
  }, [client]);

  /* ---- Đang xác thực ---- */
  if (!state || state.phase === "connecting") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#122019] text-[#a3bca6]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
          <span className="text-sm">Đang xác thực mã chủ web…</span>
        </div>
      </div>
    );
  }

  /* ---- Mã sai ---- */
  if (state.phase === "error") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#122019] px-4 text-[#f2ead9]">
        <div className="meet-fade-up w-full max-w-md rounded-3xl bg-[#1b3327] p-8 text-center shadow-xl shadow-black/40 ring-1 ring-[#6b4a2b]/40 sm:p-10">
          <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#ef7d63]/10 ring-1 ring-[#ef7d63]/25">
            <AlertTriangle className="h-7 w-7 text-[#ef7d63]" aria-hidden />
          </span>
          <h1 className="text-xl font-semibold tracking-tight">Không mở được bảng điều khiển</h1>
          <p className="mt-2 text-sm leading-relaxed text-[#a3bca6]">{state.error}</p>
          <div className="mt-6 flex flex-col gap-2">
            <button
              onClick={onInvalid}
              className="h-11 rounded-full bg-[#8fce9e] text-sm font-semibold text-[#122019] shadow-lg shadow-black/25 hover:bg-[#a3dcae]"
            >
              Nhập mã khác
            </button>
            <button
              onClick={onExit}
              className="flex h-11 items-center justify-center gap-2 rounded-full border border-[#35543f] text-sm text-[#f2ead9] transition hover:bg-[#24402f]"
            >
              <Home className="h-4 w-4" aria-hidden />
              Về trang chủ
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <ConsoleLayout client={client} state={state} onExit={onExit} />;
}

/* ========================================================================== */
/* BỐ CỤC CHÍNH CỦA BẢNG ĐIỀU KHIỂN                                          */
/* ========================================================================== */

function ConsoleLayout({
  client,
  state,
  onExit,
}: {
  client: OwnerClient;
  state: OwnerState;
  onExit: () => void;
}) {
  /* ---- Tab cột phải ---- */
  const [tab, setTab] = useState<"events" | "notes" | "chat">("events");

  /* ---- Hộp thoại hành động ---- */
  const [warningFor, setWarningFor] = useState<PublicSession | null>(null);
  const [noteFor, setNoteFor] = useState<PublicSession | null>(null);
  const [kickFor, setKickFor] = useState<PublicSession | null>(null);
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [endFor, setEndFor] = useState(false);

  const members = useMemo(
    () => state.sessions.filter((s) => s.role !== "admin"),
    [state.sessions]
  );

  const activeRoom = state.rooms.find((r) => r.id === state.activeRoomId) ?? null;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[#122019] text-[#f2ead9]">
      {/* ================= HEADER ================= */}
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[#35543f]/70 px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-[#8fce9e]">
            <ShieldCheck className="h-5 w-5 text-[#122019]" aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-tight">
              {/* Mobile rút gọn để không bị cắt; desktop hiện đủ. */}
              <span className="hidden sm:inline">Bảng điều khiển Chủ web</span>
              <span className="sm:hidden">Bảng điều khiển</span>
            </h1>
            <p className="text-xs text-[#a3bca6]">
              Quan sát mọi lớp học · can thiệp khi cần
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs">
          <span
            className={`hidden items-center gap-1.5 rounded-full px-3 py-1.5 sm:flex ${
              state.socketConnected
                ? "bg-[#8fce9e]/15 text-[#8fce9e]"
                : "bg-[#ef7d63]/15 text-[#ef7d63]"
            }`}
            role="status"
          >
            {state.socketConnected ? (
              <Wifi className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <WifiOff className="h-3.5 w-3.5" aria-hidden />
            )}
            {state.socketConnected ? "Đã kết nối" : "Mất kết nối"}
          </span>
          <RttChip rtt={state.rtt} />
          <Button
            size="sm"
            variant="ghost"
            onClick={onExit}
            className="rounded-full px-3 text-xs text-[#a3bca6] hover:bg-[#24402f] hover:text-[#f2ead9]"
          >
            <Home className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Trang chủ
          </Button>
        </div>
      </header>

      {/* ================= THÂN 3 CỘT ================= */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* ---------- CỘT TRÁI: danh sách phòng ---------- */}
        <aside className="flex w-full shrink-0 flex-col border-b border-[#35543f] lg:w-72 lg:border-b-0 lg:border-r">
          <p className="px-4 pb-1 pt-3 text-xs font-semibold text-[#78917c]">
            Phòng học đang hoạt động ({state.rooms.length})
          </p>
          <div className="meet-scroll flex max-h-48 min-h-0 flex-1 gap-2 overflow-x-auto px-3 pb-3 lg:max-h-none lg:flex-col lg:overflow-x-visible lg:overflow-y-auto">
            {state.rooms.length === 0 && (
              <p className="px-2 py-6 text-xs leading-relaxed text-[#78917c] lg:py-10">
                Chưa có phòng học nào. Phòng sẽ xuất hiện ở đây ngay khi được
                tạo hoặc có người tham gia.
              </p>
            )}
            {state.rooms.map((room) => {
              const active = room.id === state.activeRoomId;
              const online = room.onlineCount > 0;
              return (
                <button
                  key={room.id}
                  onClick={() => client.selectRoom(room.id)}
                  className={`flex w-64 shrink-0 flex-col gap-1 rounded-2xl border px-3 py-2.5 text-left shadow-lg shadow-black/20 transition duration-200 lg:w-full ${
                    active
                      ? "border-[#8fce9e]/50 bg-[#8fce9e]/10 ring-1 ring-[#8fce9e]/25"
                      : "border-[#35543f] bg-[#1b3327] ring-1 ring-[#6b4a2b]/40 hover:-translate-y-0.5 hover:bg-[#223c2d] hover:ring-[#8a5f36]/50"
                  }`}
                  aria-pressed={active}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        online ? "bg-[#8fce9e]" : "bg-[#78917c]"
                      }`}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {room.title || "Phòng chưa đặt tên"}
                    </span>
                  </span>
                  <span className="flex items-center justify-between text-[11px] text-[#a3bca6]">
                    <span className="font-mono">{room.id.slice(0, 8)}…</span>
                    <span>
                      {room.onlineCount}/{room.memberCount} trực tuyến
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* ---------- CỘT GIỮA: CCTV phòng đang chọn ---------- */}
        <main className="meet-scroll min-h-0 flex-1 overflow-y-auto p-4">
          {!state.activeRoomId ? (
            <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 text-center text-[#78917c]">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#1b3327] text-[#a3bca6] ring-1 ring-[#6b4a2b]/40">
                <Users className="h-7 w-7" aria-hidden />
              </span>
              <p className="text-sm">Chọn một phòng bên trái để xem trực tiếp.</p>
              <p className="max-w-sm px-4 text-xs leading-relaxed">
                Khi bạn chọn phòng, bạn sẽ xuất hiện trong danh sách người tham
                gia của phòng đó với vai trò Quản trị viên web.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Tiêu đề phòng + hành động cả phòng */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-medium">
                    {state.roomTitle || "Phòng chưa đặt tên"}
                  </h2>
                  <p className="text-xs text-[#a3bca6]">
                    <span className="font-mono">{state.activeRoomId.slice(0, 8)}…</span>
                    {" · "}
                    {members.length} người trong lớp
                    {activeRoom ? ` · cập nhật ${formatTime(activeRoom.lastActivity)}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => setBroadcastOpen(true)}
                    disabled={members.length === 0}
                    className="rounded-full bg-[#24402f] text-xs font-medium text-[#f2ead9] hover:bg-[#2c4a38] disabled:opacity-40"
                  >
                    <Megaphone className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                    Cảnh báo toàn phòng
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => setEndFor(true)}
                    className="rounded-full border border-[#ef7d63]/50 bg-[#ef7d63]/10 text-xs font-medium text-[#ef7d63] hover:bg-[#ef7d63]/20"
                    title="Kết thúc buổi học cho cả lớp (đuổi tất cả + đóng phòng vĩnh viễn)"
                  >
                    <PhoneOff className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                    Tan lớp
                  </Button>
                </div>
              </div>

              {/* Hàng chờ "gõ cửa lớp" — chủ web duyệt được luôn
                  (đặc biệt khi chủ phòng chưa vào lớp). */}
              {state.pendingJoins.length > 0 && (
                <div className="rounded-2xl bg-[#eeb64e]/8 p-3 ring-1 ring-[#eeb64e]/25">
                  <p className="flex items-center gap-2 text-sm font-semibold text-[#eeb64e]">
                    <DoorOpen className="h-4 w-4" aria-hidden />
                    {state.pendingJoins.length} người xin vào lớp
                  </p>
                  <ul className="mt-2 space-y-2">
                    {state.pendingJoins.map((req) => (
                      <li
                        key={req.sessionId}
                        className="flex items-center gap-3 rounded-xl bg-[#152a20]/90 px-3 py-2 ring-1 ring-[#35543f]"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#24402f] text-xs font-semibold text-[#f2ead9] ring-1 ring-[#35543f]">
                          {req.name.trim().charAt(0).toUpperCase()}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{req.name}</p>
                          <p className="text-[11px] tabular-nums text-[#78917c]">
                            gõ cửa lúc {formatTime(req.requestedAt)}
                          </p>
                        </div>
                        <button
                          onClick={() => void client.admitJoin(req.sessionId)}
                          className="h-9 shrink-0 rounded-full bg-[#8fce9e] px-3.5 text-xs font-semibold text-[#122019] transition hover:bg-[#a3dcae]"
                          aria-label={`Đồng ý cho ${req.name} vào lớp`}
                        >
                          Đồng ý
                        </button>
                        <button
                          onClick={() => void client.denyJoin(req.sessionId)}
                          className="h-9 shrink-0 rounded-full border border-[#e14b32]/50 px-3.5 text-xs font-medium text-[#ef7d63] transition hover:bg-[#e14b32]/10"
                          aria-label={`Từ chối ${req.name} vào lớp`}
                        >
                          Từ chối
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {members.length === 0 ? (
                <p className="py-10 text-center text-sm text-[#78917c]">
                  Phòng này chưa có thành viên nào trực tuyến.
                </p>
              ) : (
                /* Lưới CCTV: mỗi ô 16:9 + hàng nút hành động */
                <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                  {members.map((member) => (
                    <MemberCard
                      key={member.id}
                      member={member}
                      stream={state.streams[member.id] ?? null}
                      screen={state.screens[member.id] ?? null}
                      pcState={state.peerStates[member.id]}
                      onCamControl={(mode) => void client.camControl(member.id, mode)}
                      onMicControl={(mode) => void client.micControl(member.id, mode)}
                      onWarning={() => setWarningFor(member)}
                      onNote={() => setNoteFor(member)}
                      onKick={() => setKickFor(member)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </main>

        {/* ---------- CỘT PHẢI: nhật ký / ghi chú / thảo luận ---------- */}
        <aside className="flex h-72 w-full shrink-0 flex-col border-t border-[#35543f] lg:h-auto lg:min-h-0 lg:flex-1 lg:border-t-0 lg:border-l">
          <div className="flex items-center border-b border-[#35543f] p-2">
            <div className="flex min-w-0 flex-1 items-center gap-1 rounded-full bg-[#1b3327] p-1 ring-1 ring-[#6b4a2b]/40">
              {(
                [
                  ["events", "Nhật ký"],
                  ["notes", `Ghi chú (${state.notes.length})`],
                  ["chat", "Thảo luận"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={`min-w-0 flex-1 truncate rounded-full px-2 py-2.5 text-xs font-medium transition sm:px-2.5 sm:py-2 sm:text-sm ${
                    tab === id
                      ? "bg-[#24402f] text-[#8fce9e]"
                      : "text-[#a3bca6] hover:text-[#f2ead9]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {tab === "events" ? (
            <EventLog events={state.events} />
          ) : tab === "notes" ? (
            <NoteList notes={state.notes} />
          ) : (
            <OwnerChat
              chat={state.chat}
              selfId={state.selfId}
              onSend={(text) => client.sendChat(text)}
            />
          )}
        </aside>
      </div>

      {/* ================= THÔNG BÁO NGẮN (phòng đang xem vừa bị đóng…) ================= */}
      {state.notice && (
        <NoticeToast text={state.notice} onDone={() => client.clearNotice()} />
      )}

      {/* ================= HỘP THOẠI HÀNH ĐỘNG ================= */}
      {warningFor && (
        <PromptDialog
          title={`Gửi cảnh báo tới ${warningFor.name}`}
          description="Thành viên sẽ nhận toast đỏ + tiếng bíp và phải bấm “Đã hiểu”."
          placeholder="VD: Bạn đang làm ồn, vui lòng tắt mic."
          confirmLabel="Gửi cảnh báo"
          icon={<Megaphone className="h-5 w-5 text-[#eeb64e]" aria-hidden />}
          onCancel={() => setWarningFor(null)}
          onConfirm={async (text) => {
            const res = await client.sendWarning(warningFor.id, text);
            setWarningFor(null);
            return res.ok;
          }}
        />
      )}

      {noteFor && (
        <PromptDialog
          title={`Ghi chú về ${noteFor.name}`}
          description="Ghi chú được lưu vĩnh viễn và chỉ chủ web thấy được."
          placeholder="VD: Học sinh này cần hỗ trợ thêm về bài 3."
          confirmLabel="Lưu ghi chú"
          icon={<StickyNote className="h-5 w-5 text-[#8fce9e]" aria-hidden />}
          onCancel={() => setNoteFor(null)}
          onConfirm={async (text) => {
            const res = await client.addNote(noteFor.id, text);
            setNoteFor(null);
            return res.ok;
          }}
        />
      )}

      {broadcastOpen && (
        <PromptDialog
          title="Cảnh báo toàn phòng"
          description={`Gửi tới ${members.length} thành viên đang trực tuyến trong phòng này.`}
          placeholder="VD: Lớp bắt đầu sau 5 phút, mọi người chuẩn bị bài tập."
          confirmLabel="Gửi tới tất cả"
          icon={<Megaphone className="h-5 w-5 text-[#eeb64e]" aria-hidden />}
          onCancel={() => setBroadcastOpen(false)}
          onConfirm={async (text) => {
            const res = await client.broadcastWarning(text);
            setBroadcastOpen(false);
            return res.ok;
          }}
        />
      )}

      {kickFor && (
        <AlertDialog open onOpenChange={(open) => !open && setKickFor(null)}>
          <AlertDialogContent className="border-[#35543f] bg-[#1b3327]">
            <AlertDialogHeader>
              <AlertDialogTitle>Mời {kickFor.name} ra khỏi phòng?</AlertDialogTitle>
              <AlertDialogDescription>
                Người này sẽ bị ngắt kết nối ngay lập tức; muốn vào lại phải
                được chủ phòng duyệt lần nữa. Hành động được ghi vào nhật ký.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="border-[#35543f] bg-transparent text-[#a3bca6] hover:bg-[#24402f] hover:text-[#f2ead9]">
                Huỷ
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-[#d3392a] text-white hover:bg-[#e14b32]"
                onClick={() => {
                  void client.kick(kickFor.id);
                  setKickFor(null);
                }}
              >
                Mời ra khỏi phòng
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {endFor && (
        <AlertDialog open onOpenChange={(open) => !open && setEndFor(false)}>
          <AlertDialogContent className="border-[#35543f] bg-[#1b3327]">
            <AlertDialogHeader>
              <AlertDialogTitle>
                Tan lớp — kết thúc buổi học cho cả lớp?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Toàn bộ thành viên trong phòng sẽ bị mời ra khỏi phòng và liên
                kết phòng bị đóng vĩnh viễn (không thể vào lại bằng liên kết
                cũ). Hành động được ghi vào nhật ký.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="border-[#35543f] bg-transparent text-[#a3bca6] hover:bg-[#24402f] hover:text-[#f2ead9]">
                Huỷ
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-[#d3392a] text-white hover:bg-[#e14b32]"
                onClick={() => {
                  setEndFor(false);
                  void client.endMeeting().then((res) => {
                    if (res.ok) client.clearActiveRoom();
                  });
                }}
              >
                <PhoneOff className="mr-1.5 h-4 w-4" aria-hidden />
                Tan lớp
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

/* ========================================================================== */
/* THẺ THÀNH VIÊN (CCTV) + HÀNG NÚT HÀNH ĐỘNG                                */
/* ========================================================================== */

function MemberCard({
  member,
  stream,
  screen,
  pcState,
  onCamControl,
  onMicControl,
  onWarning,
  onNote,
  onKick,
}: {
  member: PublicSession;
  stream: MediaStream | null;
  screen: MediaStream | null;
  pcState: RTCPeerConnectionState | undefined;
  /** Đặt chế độ điều khiển camera: "on" = bật luôn, "off" = cấm, "free" = tự do. */
  onCamControl: (mode: DeviceLock) => void;
  /** Đặt chế độ điều khiển micro (ý nghĩa như onCamControl). */
  onMicControl: (mode: DeviceLock) => void;
  onWarning: () => void;
  onNote: () => void;
  onKick: () => void;
}) {
  return (
    <div className="space-y-2 rounded-2xl bg-[#1b3327]/60 p-2.5 ring-1 ring-[#6b4a2b]/40">
      <div className="relative">
        <VideoTile
          stream={stream}
          name={member.name}
          role={member.role}
          camOn={member.camOn}
          micOn={member.micOn}
          handRaised={member.handRaised}
          online={member.online}
          pcState={pcState}
          variant="cctv"
        />
        {/* Ô màn hình chia sẻ nhỏ góc dưới (nếu có) */}
        {screen && <MiniScreenPreview screen={screen} />}
      </div>

      {/* ===== Trạng thái (chip) ===== */}
      <div className="flex flex-wrap items-center gap-1.5">
        <RttChip rtt={member.rtt} />
        {member.role === "host" && (
          <span className="flex items-center gap-1 rounded-full bg-[#eeb64e]/15 px-2 py-0.5 text-[10px] font-semibold text-[#eeb64e] ring-1 ring-[#eeb64e]/30">
            <Crown className="h-3 w-3" aria-hidden />
            Chủ phòng
          </span>
        )}
        <span
          className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ring-1 ${
            member.camLock !== "none"
              ? "bg-[#eeb64e]/15 text-[#eeb64e] ring-[#eeb64e]/30"
              : "bg-[#24402f] text-[#a3bca6] ring-[#6b4a2b]/40"
          }`}
          title={
            member.camLock === "off"
              ? "Camera đang bị CẤM — họ không thể tự bật"
              : member.camLock === "on"
                ? "Camera đang bị BẬT LUÔN — họ không thể tự tắt"
                : undefined
          }
        >
          {member.camLock !== "none" && <Lock className="h-3 w-3" aria-hidden />}
          {member.camOn ? (
            <Video className="h-3 w-3" aria-hidden />
          ) : (
            <VideoOff className="h-3 w-3" aria-hidden />
          )}
          {member.camOn ? "Cam bật" : "Cam tắt"}
          {member.camLock === "off" && " (cấm)"}
          {member.camLock === "on" && " (bật luôn)"}
        </span>
        <span
          className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ring-1 ${
            member.micLock !== "none"
              ? "bg-[#eeb64e]/15 text-[#eeb64e] ring-[#eeb64e]/30"
              : "bg-[#24402f] text-[#a3bca6] ring-[#6b4a2b]/40"
          }`}
          title={
            member.micLock === "off"
              ? "Micro đang bị CẤM — họ không thể tự bật"
              : member.micLock === "on"
                ? "Micro đang bị BẬT LUÔN — họ không thể tự tắt"
                : undefined
          }
        >
          {member.micLock !== "none" && <Lock className="h-3 w-3" aria-hidden />}
          {member.micOn ? (
            <Mic className="h-3 w-3" aria-hidden />
          ) : (
            <MicOff className="h-3 w-3" aria-hidden />
          )}
          {member.micOn ? "Mic bật" : "Mic tắt"}
          {member.micLock === "off" && " (cấm)"}
          {member.micLock === "on" && " (bật luôn)"}
        </span>
        {member.handRaised && (
          <span className="flex items-center gap-1 rounded-full bg-[#eeb64e]/15 px-2 py-0.5 text-[10px] font-medium text-[#eeb64e]">
            <HandIcon className="h-3 w-3" aria-hidden />
            Giơ tay
          </span>
        )}
        {member.screenSharing && (
          <span className="flex items-center gap-1 rounded-full bg-[#8fce9e]/15 px-2 py-0.5 text-[10px] font-medium text-[#8fce9e]">
            <MonitorPlay className="h-3 w-3" aria-hidden />
            Chia sẻ màn hình
          </span>
        )}
      </div>

      {/* ===== ĐIỀU KHIỂN THIẾT BỊ: BẬT LUÔN / CẤM / TỰ DO ===== */}
      <DeviceControlRow
        label="Camera"
        device="cam"
        name={member.name}
        lock={member.camLock}
        onSet={onCamControl}
      />
      <DeviceControlRow
        label="Micro"
        device="mic"
        name={member.name}
        lock={member.micLock}
        onSet={onMicControl}
      />

      {/* ===== Hành động khác ===== */}
      <div className="flex items-center gap-1">
        <button
          onClick={onWarning}
          aria-label={`Gửi cảnh báo tới ${member.name}`}
          title="Gửi cảnh báo"
          className="meet-icon-btn flex h-8 w-8 items-center justify-center rounded-full bg-[#24402f] text-[#eeb64e] transition hover:bg-[#2c4a38]"
        >
          <Megaphone className="h-4 w-4" />
        </button>
        <button
          onClick={onNote}
          aria-label={`Ghi chú về ${member.name}`}
          title="Ghi chú"
          className="meet-icon-btn flex h-8 w-8 items-center justify-center rounded-full bg-[#24402f] text-[#8fce9e] transition hover:bg-[#2c4a38]"
        >
          <StickyNote className="h-4 w-4" />
        </button>
        <button
          onClick={onKick}
          aria-label={`Mời ${member.name} ra khỏi phòng`}
          title="Mời ra khỏi phòng"
          className="meet-icon-btn flex h-8 w-8 items-center justify-center rounded-full bg-[#24402f] text-[#ef7d63] transition hover:bg-[#2c4a38]"
        >
          <UserX className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * HÀNG ĐIỀU KHIỂN THIẾT BỊ của một thành viên (CEO: "BẬT là BẬT LUÔN,
 * CẤM là CẤM LUÔN") — nhãn thiết bị ở dòng trên, 3 nút chế độ chiếm
 * TOÀN BỘ RỘNG thẻ ở dòng dưới (tránh cắt chữ khi thẻ CCTV hẹp):
 *   • BẬT LUÔN: thiết bị bật NGAY trên máy họ + khoá ở trạng thái bật.
 *   • CẤM      : thiết bị tắt NGAY + họ KHÔNG THỂ tự bật lại.
 *   • TỰ DO    : trả quyền — họ tự bật/tắt như bình thường.
 * Nút đang hoạt động được tô sáng để chủ web biết chế độ hiện tại.
 */
function DeviceControlRow({
  label,
  device,
  name,
  lock,
  onSet,
}: {
  label: string;
  device: "cam" | "mic";
  name: string;
  lock: DeviceLock;
  onSet: (mode: DeviceLock) => void;
}) {
  return (
    <div className="space-y-1">
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#78917c]">
        {device === "cam" ? (
          <Video className="h-3 w-3" aria-hidden />
        ) : (
          <Mic className="h-3 w-3" aria-hidden />
        )}
        {label}
      </p>
      <div
        className="flex min-w-0 items-center gap-0.5 rounded-full bg-[#152a20] p-0.5 ring-1 ring-[#35543f]"
        role="group"
        aria-label={`Điều khiển ${label.toLowerCase()} của ${name}`}
      >
        {(
          [
            {
              mode: "on" as const,
              title: `Bật ${label.toLowerCase()} NGAY trên máy ${name} và khoá ở trạng thái bật (họ không thể tự tắt)`,
              text: "Bật luôn",
              activeClass: "bg-[#8fce9e] text-[#122019] font-semibold",
            },
            {
              mode: "off" as const,
              title: `CẤM ${label.toLowerCase()}: tắt NGAY và ${name} không thể tự bật lại`,
              text: "Cấm",
              activeClass: "bg-[#e14b32] text-[#fff6ee] font-semibold",
            },
            {
              mode: "none" as const,
              title: `Trả quyền: ${name} tự bật/tắt ${label.toLowerCase()} của mình`,
              text: "Tự do",
              activeClass: "bg-[#3c5744] text-[#f2ead9] font-semibold",
            },
          ] as const
        ).map((seg) => {
          const active = lock === seg.mode;
          return (
            <button
              key={seg.mode}
              onClick={() => onSet(seg.mode)}
              aria-pressed={active}
              title={seg.title}
              className={`min-w-0 flex-1 whitespace-nowrap rounded-full px-1.5 py-1.5 text-[11px] leading-none transition ${
                active
                  ? seg.activeClass
                  : "text-[#a3bca6] hover:bg-[#24402f] hover:text-[#f2ead9]"
              }`}
            >
              {seg.text}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Ô màn hình chia sẻ nhỏ góc dưới ô CCTV (nếu thành viên đang chia sẻ). */
function MiniScreenPreview({ screen }: { screen: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = screen;
  }, [screen]);
  return (
    <div className="absolute bottom-2 right-2 h-1/3 w-1/3 overflow-hidden rounded-lg border border-[#8fce9e]/40 bg-black shadow-lg">
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        className="h-full w-full object-contain"
        aria-label="Màn hình đang chia sẻ"
      />
      <span className="absolute left-1 top-1 flex items-center gap-1 rounded-full bg-[#122019]/80 px-1.5 py-0.5 text-[9px] font-medium text-[#8fce9e] backdrop-blur">
        <MonitorPlay className="h-3 w-3" aria-hidden />
        Màn hình
      </span>
    </div>
  );
}

/** Toast ngắn giữa đỉnh màn hình (VD: phòng đang xem vừa tự kết thúc). */
function NoticeToast({ text, onDone }: { text: string; onDone: () => void }) {
  /* Tự tắt sau 6 giây; bấm X để tắt ngay. */
  useEffect(() => {
    const timer = setTimeout(onDone, 6000);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <div
      className="meet-toast-enter fixed left-1/2 top-16 z-50 flex w-[min(92vw,28rem)] -translate-x-1/2 items-start gap-3 rounded-xl bg-[#16301f]/95 px-4 py-3 shadow-2xl ring-1 ring-[#8fce9e]/40 backdrop-blur"
      role="status"
      aria-live="polite"
    >
      <Info className="mt-0.5 h-5 w-5 shrink-0 text-[#8fce9e]" aria-hidden />
      <p className="flex-1 text-sm leading-relaxed text-[#f2ead9]">{text}</p>
      <button
        onClick={onDone}
        aria-label="Đóng thông báo"
        className="shrink-0 transition-colors"
      >
        <X className="h-4 w-4 text-[#a3bca6] hover:text-[#f2ead9]" aria-hidden />
      </button>
    </div>
  );
}

/* ========================================================================== */
/* NHẬT KÝ HOẠT ĐỘNG                                                          */
/* ========================================================================== */

function EventLog({ events }: { events: EventPayload[] }) {
  const [filter, setFilter] = useState<"all" | "warning">("all");
  const shown = events.filter((e) =>
    filter === "all" ? true : e.severity !== "info"
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <span className="flex items-center gap-1.5 text-xs text-[#a3bca6]">
          <Activity className="h-3.5 w-3.5" aria-hidden />
          {shown.length} sự kiện
        </span>
        <div className="flex items-center gap-0.5 rounded-full bg-[#1b3327] p-1 ring-1 ring-[#6b4a2b]/40">
          {(
            [
              ["all", "Tất cả"],
              ["warning", "Đáng chú ý"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setFilter(id)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                filter === id
                  ? "bg-[#24402f] text-[#8fce9e]"
                  : "text-[#a3bca6] hover:text-[#f2ead9]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="meet-scroll min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {shown.length === 0 && (
          <p className="py-6 text-center text-xs text-[#78917c]">
            Chưa có sự kiện nào. Chọn một phòng và theo dõi hoạt động ở đây.
          </p>
        )}
        {shown
          .slice()
          .reverse()
          .map((ev, i) => (
            <div
              /* Key = ID sự kiện + vị trí — LUÔN duy nhất (sửa lỗi React
                 "two children with the same key" khi 2 sự kiện trùng ID). */
              key={`${ev.id}-${i}`}
              className="flex items-start gap-2.5 rounded-xl bg-[#1b3327] px-3 py-2 ring-1 ring-[#6b4a2b]/40"
            >
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                  ev.severity === "critical"
                    ? "bg-[#ef7d63]"
                    : ev.severity === "warning"
                      ? "bg-[#eeb64e]"
                      : "bg-[#8fce9e]"
                }`}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs leading-relaxed">
                  <span className="text-[#f2ead9]">
                    {ev.sessionName ?? "Hệ thống"}
                  </span>
                  {" — "}
                  <span className="text-[#8fce9e]">
                    {EVENT_LABELS[ev.type] ?? ev.type}
                  </span>
                  {ev.detail ? (
                    <span className="text-[#a3bca6]"> · {ev.detail}</span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-[10px] text-[#78917c]">
                  {formatTime(ev.ts)} · {SEVERITY_LABELS[ev.severity]}
                </p>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

/* ========================================================================== */
/* DANH SÁCH GHI CHÚ                                                          */
/* ========================================================================== */

function NoteList({ notes }: { notes: NotePayload[] }) {
  return (
    <div className="meet-scroll min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
      {notes.length === 0 && (
        <p className="py-6 text-center text-xs leading-relaxed text-[#78917c]">
          Chưa có ghi chú nào. Bấm nút ghi chú trên thẻ thành viên để thêm.
        </p>
      )}
      {notes.map((note) => (
        <div key={note.id} className="rounded-xl bg-[#1b3327] px-3 py-2.5 ring-1 ring-[#6b4a2b]/40">
          <p className="flex items-center gap-1.5 text-xs font-medium text-[#8fce9e]">
            <StickyNote className="h-3.5 w-3.5" aria-hidden />
            {note.targetName}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[#f2ead9]">
            {note.content}
          </p>
          <p className="mt-1 text-[10px] text-[#78917c]">
            {formatTime(note.ts)} · ghi bởi {note.authorName}
          </p>
        </div>
      ))}
    </div>
  );
}

/* ========================================================================== */
/* THẢO LUẬN (CHAT TRONG PHÒNG ĐANG XEM)                                      */
/* ========================================================================== */

function OwnerChat({
  chat,
  selfId,
  onSend,
}: {
  chat: { id: string; sessionId: string; name: string; text: string; ts: number }[];
  selfId: string;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  /* Tự cuộn xuống tin cuối cùng. */
  const chatCount = chat.length;
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [chatCount]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="meet-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {chat.length === 0 && (
          <p className="py-6 text-center text-xs text-[#78917c]">
            Chưa có tin nhắn trong phòng này.
          </p>
        )}
        {chat.map((msg) => {
          const isSelf = msg.sessionId === selfId;
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
                    ? "rounded-br-md bg-[#16301f] text-[#f2ead9]"
                    : "rounded-bl-md bg-[#24402f] text-[#f2ead9]"
                }`}
              >
                {msg.text}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      <div className="border-t border-[#35543f] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
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
            placeholder="Nhắn trong phòng đang xem…"
            maxLength={1000}
            aria-label="Soạn tin nhắn"
            className="h-11 flex-1 rounded-full border border-[#35543f] bg-[#1b3327] px-4 text-sm text-[#f2ead9] placeholder:text-[#78917c] focus:border-[#8fce9e]/60 focus:outline-none"
          />
          <button
            onClick={send}
            disabled={draft.trim().length === 0}
            aria-label="Gửi tin nhắn"
            title="Gửi"
            className="meet-icon-btn flex h-11 w-11 items-center justify-center rounded-full bg-[#8fce9e] text-[#122019] transition hover:bg-[#a3dcae] disabled:opacity-40"
          >
            <Send className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ========================================================================== */
/* HỘP THOẠI NHẬP NỘI DUNG DÙNG CHUNG (cảnh báo / ghi chú / đồng loạt)        */
/* ========================================================================== */

function PromptDialog({
  title,
  description,
  placeholder,
  confirmLabel,
  icon,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  placeholder: string;
  confirmLabel: string;
  icon: React.ReactNode;
  onCancel: () => void;
  onConfirm: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  const submit = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setFailed(false);
    const ok = await onConfirm(value);
    setSending(false);
    if (!ok) setFailed(true);
    else setText("");
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md border-[#35543f] bg-[#1b3327] text-[#f2ead9]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {icon}
            {title}
          </DialogTitle>
          <DialogDescription className="text-[#a3bca6]">
            {description}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          maxLength={500}
          autoFocus
          className="min-h-24 border-[#35543f] bg-[#122019] text-[#f2ead9] placeholder:text-[#78917c] focus-visible:ring-[#8fce9e]/60"
        />
        {failed && (
          <p className="text-xs text-[#ef7d63]" role="alert">
            Gửi không thành công — kiểm tra kết nối rồi thử lại.
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            onClick={onCancel}
            className="rounded-full text-[#a3bca6] hover:bg-[#24402f] hover:text-[#f2ead9]"
          >
            <X className="mr-1 h-4 w-4" aria-hidden />
            Huỷ
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!text.trim() || sending}
            className="rounded-full bg-[#8fce9e] font-semibold text-[#122019] hover:bg-[#a3dcae] disabled:opacity-40"
          >
            {sending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Send className="mr-2 h-4 w-4" aria-hidden />
            )}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
