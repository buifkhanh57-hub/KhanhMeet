"use client";

/**
 * ============================================================================
 *  KhanhMeet — ĐIỂM VÀO SPA (route duy nhất "/")
 * ----------------------------------------------------------------------------
 *  Điều hướng nội bộ bằng HASH:
 *    • "#/"                 → Trang chủ (tạo phòng học / tham gia bằng mã)
 *    • "#/room/<room_id>"   → Phòng học của THÀNH VIÊN (sảnh chờ → phòng học)
 *
 *  ĐÃ BỎ route "#/admin": bảng điều khiển chủ web giờ mở bằng MÃ CHỦ WEB
 *  (nhập tại ô nhỏ góc trái dưới trang chủ). Ai gõ "#/admin" cũ → về trang chủ.
 *
 *  Lý do dùng hash: chạy hoàn toàn phía client, chia sẻ liên kết phòng được
 *  và không xung đột với ràng buộc single-route.
 * ============================================================================
 */

import { useCallback, useEffect, useState } from "react";
import { HomeScreen } from "@/components/meet/HomeScreen";
import { RoomFlow } from "@/components/meet/RoomFlow";

type Route =
  | { view: "home" }
  | { view: "room"; roomId: string };

/** Phân tích chuỗi hash thành cấu trúc route. */
function parseHash(): Route {
  const raw = window.location.hash.replace(/^#/, "");
  const parts = raw.split("?")[0].split("/").filter(Boolean);

  if (parts[0] === "room" && parts.length >= 2 && parts[1]) {
    return { view: "room", roomId: parts[1] };
  }
  // Mọi hash khác (kể cả "#/admin" thời cũ) → trang chủ.
  return { view: "home" };
}

export default function Page() {
  // Route chỉ parse được trên trình duyệt — SSR render màn hình chờ trung lập.
  const [route, setRoute] = useState<Route | null>(null);

  useEffect(() => {
    const sync = () => setRoute(parseHash());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  /** Điều hướng sang hash mới (thay thế, không đẩy lịch sử thừa). */
  const navigate = useCallback((hash: string) => {
    window.location.hash = hash;
  }, []);

  if (!route) {
    // Màn hình chờ rất ngắn trong lúc hydrate (tránh nhấp nháy trắng).
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#122019]">
        <div className="flex items-center gap-3 text-[#a3bca6]">
          <span className="relative flex h-3 w-3" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#eeb64e]/60" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-[#eeb64e]" />
          </span>
          <span className="text-sm">Đang tải…</span>
        </div>
      </main>
    );
  }

  if (route.view === "room") {
    return <RoomFlow key={`room-${route.roomId}`} roomId={route.roomId} />;
  }

  return <HomeScreen navigate={navigate} />;
}
