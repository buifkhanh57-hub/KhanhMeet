"use client";

/**
 * ============================================================================
 *  LỚP HỌC TRỰC TUYẾN — LUỒNG VÀO LỚP CỦA NGƯỜI DÙNG (ROOM FLOW)
 * ----------------------------------------------------------------------------
 *  Máy trạng thái của route "#/room/<room_id>":
 *    loading → lobby → meeting
 *              ↘ notfound (lớp không tồn tại)
 *
 *  Người tạo lớp (có KHOÁ CHỦ PHÒNG trong localStorage) vào thẳng với vai
 *  trò "host"; người còn lại là thành viên — vào lớp có chủ phòng thì phải
 *  chờ chủ phòng DUYỆT (xem MeetingRoom: pha "waiting").
 * ============================================================================
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Home, Loader2, RotateCcw, SearchX } from "lucide-react";
import { apiGetRoom, readHostKey } from "@/lib/meet/signaling";
import type { RoomInfoResponse } from "@/lib/meet/types";
import { Lobby, type LobbyJoinPayload } from "./Lobby";
import { MeetingRoom } from "./MeetingRoom";
import { BoardCard } from "./decor";

type Stage =
  | { step: "loading" }
  | { step: "notfound" }
  | { step: "error"; message: string }
  | { step: "lobby" }
  | { step: "meeting"; payload: LobbyJoinPayload };

export function RoomFlow({ roomId }: { roomId: string }) {
  const [stage, setStage] = useState<Stage>({ step: "loading" });
  const [roomTitle, setRoomTitle] = useState<string | null>(null);
  const [hostOnline, setHostOnline] = useState<boolean | null>(null);
  const [approvalRequired, setApprovalRequired] = useState<boolean>(false);
  /** Khoá chủ phòng đọc MỘT LẦN khi mount (null = máy này không tạo lớp). */
  const [hostKey, setHostKey] = useState<string | null>(null);

  /* ---- B1: Tra cứu lớp + đọc khoá chủ phòng trên máy này ---- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Đọc khoá chủ phòng (localStorage chỉ có trên client).
      const key = readHostKey(roomId);
      if (!cancelled) setHostKey(key);
      try {
        const res = await apiGetRoom(roomId);
        const data = (await res.json()) as RoomInfoResponse;
        if (cancelled) return;
        if (!data.ok || !data.exists || !data.room) {
          setStage({ step: "notfound" });
          return;
        }
        setRoomTitle(data.room.title);
        setHostOnline(data.room.hostOnline ?? null);
        setApprovalRequired(Boolean(data.room.approvalRequired));
        setStage({ step: "lobby" });
      } catch {
        if (!cancelled) {
          setStage({
            step: "error",
            message:
              "Không kết nối được máy chủ. Hãy kiểm tra kết nối mạng rồi thử lại.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  const goHome = useCallback(() => {
    window.location.hash = "";
  }, []);

  /* ===================== CÁC MÀN ===================== */

  if (stage.step === "loading") {
    return (
      <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[#122019] px-6 text-[#f2ead9]">
        <div className="meet-fade-up relative z-10 flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-[#8fce9e]" aria-hidden />
          <p className="text-sm text-[#a3bca6]">Đang mở cửa lớp học…</p>
        </div>
      </div>
    );
  }

  if (stage.step === "notfound") {
    return (
      <ErrorScreen
        icon={<SearchX className="h-8 w-8 text-[#eeb64e]" aria-hidden />}
        title="Không tìm thấy lớp học"
        message="Liên kết không đúng hoặc lớp đã tan. Hãy kiểm tra lại mã lớp với chủ phòng."
        onRetry={() => window.location.reload()}
        onHome={goHome}
      />
    );
  }

  if (stage.step === "error") {
    return (
      <ErrorScreen
        icon={<AlertTriangle className="h-8 w-8 text-[#eeb64e]" aria-hidden />}
        title="Có lỗi xảy ra"
        message={stage.message}
        onRetry={() => window.location.reload()}
        onHome={goHome}
      />
    );
  }

  if (stage.step === "lobby") {
    return (
      <Lobby
        roomId={roomId}
        roomTitle={roomTitle ?? ""}
        isHost={hostKey !== null}
        hostOnline={hostOnline}
        approvalRequired={approvalRequired}
        onBack={goHome}
        onJoin={(payload) => setStage({ step: "meeting", payload })}
      />
    );
  }

  return (
    <MeetingRoom
      roomId={roomId}
      name={stage.payload.name}
      stream={stage.payload.stream}
      initialCamOn={stage.payload.camOn}
      initialMicOn={stage.payload.micOn}
      hostKey={hostKey}
      onRejoin={() => setStage({ step: "lobby" })}
      onHome={goHome}
    />
  );
}

/** Màn lỗi dùng chung (không tìm thấy lớp / lỗi kết nối) — thẻ bảng đen. */
function ErrorScreen({
  icon,
  title,
  message,
  onRetry,
  onHome,
}: {
  icon: React.ReactNode;
  title: string;
  message: string;
  onRetry: () => void;
  onHome: () => void;
}) {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-[#122019] px-6 text-center text-[#f2ead9]">
      <BoardCard className="meet-fade-up relative z-10 w-full max-w-md">
        <div className="p-8 sm:p-10">
          <span className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#eeb64e]/10 ring-1 ring-[#eeb64e]/25">
            {icon}
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[#a3bca6]">
              {message}
            </p>
          </div>
          <div className="mt-8 flex flex-col justify-center gap-2 sm:flex-row">
            <button
              onClick={onRetry}
              className="flex h-11 items-center justify-center gap-2 rounded-full bg-[#e14b32] px-6 text-sm font-semibold text-[#fff6ee] shadow-lg shadow-black/25 hover:bg-[#ef5c42]"
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
              Thử lại
            </button>
            <button
              onClick={onHome}
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
