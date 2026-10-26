"use client";

/**
 * ============================================================================
 *  KHANHMEET — TRANG CHỦ (tạo lớp học / tham gia bằng mã)
 * ----------------------------------------------------------------------------
 *  • Header: logo KhanhMeet (icon camera + wordmark, kiểu logo gốc).
 *  • Cột trái: giới thiệu lớp học trực tuyến.
 *  • Cột phải: thẻ "bảng đen khung gỗ" — Tạo lớp học mới + Tham gia lớp học.
 *
 *  TẠO LỚP → máy chủ trả KHOÁ CHỦ PHÒNG (hostKey), lưu ngay vào localStorage
 *  của người tạo → khi vào lớp họ mang vai trò "host" (chủ phòng): duyệt người
 *  vào, tắt mic/camera, mời ra khỏi lớp, giữ liên kết mời.
 *
 *  GÓC TRÁI DƯỚI (footer): ô nhập MÃ CHỦ WEB — mã bí mật ngẫu nhiên do
 *  người sáng tạo web nắm giữ. Nhập đúng sẽ mở TAB RIÊNG cho chủ web:
 *  bảng điều khiển quan sát toàn bộ lớp học. Người thường không thấy gì thêm:
 *  không có liên kết, không có chữ nào giải thích ô mã này dẫn tới đâu.
 *
 *  Sau khi mở đúng mã một lần, máy của chủ web nhớ trong phiên tab
 *  (sessionStorage) — góc trái dưới đổi thành nút "Bảng điều khiển chủ web"
 *  để vào lại mà không cần gõ lại mã.
 * ============================================================================
 */

import { useCallback, useEffect, useState } from "react";
import {
  Keyboard,
  MonitorUp,
  Hand as HandIcon,
  RefreshCw,
  ArrowRight,
  Loader2,
  ShieldCheck,
  Crown,
  Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  apiCreateRoom,
  fetchHealth,
  saveHostKey,
} from "@/lib/meet/signaling";
import type { CreateRoomResponse } from "@/lib/meet/types";
import { OwnerConsole } from "./OwnerConsole";
import { BoardCard, KhanhMeetLogo } from "./decor";

/** Key nhớ mã chủ web trong phiên tab (sessionStorage — không dính sang thiết bị khác). */
const OWNER_CODE_KEY = "km-owner-code";

export function HomeScreen({
  navigate,
}: {
  navigate: (hash: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [serviceUp, setServiceUp] = useState<boolean | null>(null);

  /* ---- Trạng thái chủ web: mã đã lưu (sessionStorage) + đang mở tab riêng ---- */
  const [ownerCode, setOwnerCode] = useState<string | null>(null);
  const [ownerView, setOwnerView] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [codeShake, setCodeShake] = useState(false);

  /* Đọc mã đã lưu (nếu có) — sau khi mount để khớp HTML SSR. */
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(OWNER_CODE_KEY);
      if (saved) setOwnerCode(saved);
    } catch {
      // sessionStorage có thể bị chặn — bỏ qua.
    }
  }, []);

  // Kiểm tra dịch vụ signaling còn sống (đảo chữ gợi ý khi máy chủ lỗi).
  useEffect(() => {
    let cancelled = false;
    fetchHealth().then((ok) => {
      if (!cancelled) setServiceUp(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Nộp mã: lưu vào sessionStorage rồi mở tab riêng.
   * OwnerConsole sẽ xác thực mã với máy chủ — sai thì hiện lỗi + quay lại đây.
   */
  const submitCode = (e: React.FormEvent) => {
    e.preventDefault();
    const code = codeInput.trim();
    if (!code) return;
    try {
      sessionStorage.setItem(OWNER_CODE_KEY, code);
    } catch {
      // sessionStorage bị chặn — vẫn cho mở console với mã vừa gõ.
    }
    setOwnerCode(code);
    setOwnerView(true);
    setCodeInput("");
  };

  /** Mã không hợp lệ (console báo lỗi) → xoá, về trang chủ nhập lại. */
  const invalidateCode = useCallback(() => {
    try {
      sessionStorage.removeItem(OWNER_CODE_KEY);
    } catch {
      // Bỏ qua.
    }
    setOwnerCode(null);
    setOwnerView(false);
    setCodeInput("");
    setCodeShake(true);
    setTimeout(() => setCodeShake(false), 450);
  }, []);

  /**
   * Tạo lớp học mới → lưu KHOÁ CHỦ PHÒNG vào máy → chuyển thẳng tới sảnh chờ
   * (vào lớp với vai trò CHỦ PHÒNG — không phải chờ duyệt như thành viên).
   */
  const handleCreate = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const res = await apiCreateRoom({ title: title.trim() || undefined });
      const data = (await res.json()) as CreateRoomResponse;
      if (data.ok && data.room) {
        if (data.hostKey) saveHostKey(data.room.id, data.hostKey);
        navigate(`/room/${data.room.id}`);
        return;
      }
      setServiceUp(false);
    } catch {
      setServiceUp(false);
    } finally {
      setCreating(false);
    }
  }, [creating, title, navigate]);

  /** Nhấn nút "Tham gia": chấp nhận mã phòng UUID hoặc nguyên liên kết. */
  const handleJoin = useCallback(() => {
    const raw = joinCode.trim();
    setJoinError(null);
    if (!raw) return;
    // Trích xuất mã phòng từ liên kết (dạng .../#/room/<id>...) hoặc dùng trực tiếp.
    const match = raw.match(/#\/room\/([0-9a-fA-F-]{8,})/);
    const roomId = (match ? match[1] : raw).trim();
    if (roomId.length < 8) {
      setJoinError("Mã lớp không hợp lệ. Hãy kiểm tra lại mã hoặc liên kết.");
      return;
    }
    navigate(`/room/${roomId}`);
  }, [joinCode, navigate]);

  /* ---- TAB RIÊNG CỦA CHỦ WEB (đè toàn bộ trang chủ) ---- */
  if (ownerView && ownerCode) {
    return (
      <OwnerConsole
        key={ownerCode}
        code={ownerCode}
        onExit={() => setOwnerView(false)}
        onInvalid={invalidateCode}
      />
    );
  }

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-[#122019] text-[#f2ead9]">
      {/* ============ NỀN TOÀN TRANG: ÁP PHÍCH BÁC HỒ (ảnh gốc người dùng chọn) ============
          Chân dung Bác Hồ vẫy tay giữa hoa sen, cờ đỏ sao vàng. Ảnh neo
          trái-trên để gương mặt Bác luôn hiện rõ; lớp phủ tối nhẹ phía sau
          chữ giúp nội dung vẫn đọc được mà không làm mờ ảnh. */}
      <div
        className="meet-fade-up pointer-events-none fixed inset-0 select-none overflow-hidden"
        aria-hidden
      >
        <div
          className="absolute inset-0 bg-cover bg-no-repeat [background-position:30%_8%]"
          style={{ backgroundImage: "url(/bac-ho.jpg)" }}
        />
        {/* Phủ tối nhẹ toàn trang — chữ kem nổi lên, ảnh vẫn thấy rõ. */}
        <div className="absolute inset-0 bg-[#0d1712]/40" />
        {/* Đậm dần ở mép trên (logo) và mép dưới (chân trang). */}
        <div className="absolute inset-0 bg-gradient-to-b from-[#122019]/75 via-transparent to-[#122019]/80" />
        {/* Màn lớn: cột chữ bên phải thêm một lớp chéo mảnh. */}
        <div className="absolute inset-y-0 right-0 hidden w-1/2 bg-gradient-to-l from-[#122019]/50 to-transparent lg:block" />
      </div>

      {/* ============ HEADER ============ */}
      <header className="meet-fade-up relative z-10 flex items-center justify-between gap-3 px-5 py-4 sm:px-6">
        <KhanhMeetLogo size={40} />
        <div className="flex items-center gap-2 rounded-full border border-[#35543f] bg-[#1b3327]/70 px-3 py-1.5 text-xs ring-1 ring-white/5">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              serviceUp === true
                ? "bg-[#8fce9e]"
                : serviceUp === false
                  ? "bg-[#ef7d63]"
                  : "bg-[#a3bca6]"
            }`}
            aria-hidden
          />
          {serviceUp === true && <span className="text-[#a3bca6]">Máy chủ trực tuyến</span>}
          {serviceUp === false && (
            <span className="text-[#ef7d63]">Máy chủ đang ngoại tuyến</span>
          )}
          {serviceUp === null && <span className="text-[#a3bca6]">Đang kiểm tra…</span>}
        </div>
      </header>

      {/* ============ NỘI DUNG CHÍNH ============ */}
      <main className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center gap-10 px-5 py-8 lg:flex-row-reverse lg:items-center lg:gap-16">
        {/* ---- Cột chữ: màn lớn nằm bên PHẢI để chừa bên trái cho chân dung
            Bác Hồ trên nền áp phích; điện thoại vẫn chữ trước, thẻ sau. ---- */}
        <section className="max-w-md space-y-6 text-center lg:text-left">
          {/* Badge người chủ trì buổi học. */}
          <div className="meet-fade-up flex flex-wrap justify-center gap-2 lg:justify-start">
            <span className="meet-hero-shadow inline-flex items-center gap-2 rounded-full bg-[#122019]/45 px-3.5 py-1.5 text-xs font-medium text-[#8fce9e] ring-1 ring-[#8fce9e]/25 backdrop-blur-[2px]">
              <Crown className="h-3.5 w-3.5 text-[#eeb64e]" aria-hidden />
              Chủ trì: Nguyễn Thị Thảo
            </span>
          </div>
          <h1 className="meet-fade-up meet-d-1 meet-hero-shadow text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            Vào lớp học Sử,
            <br />
            <span className="text-[#8fce9e]">ngay trên KhanhMeet</span>
          </h1>
          <ul className="meet-fade-up meet-d-2 meet-hero-shadow space-y-3 pt-2 text-sm text-[#c9dcc8]">
            <li className="flex items-center justify-center gap-3 lg:justify-start">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#e14b32]/10 ring-1 ring-[#e14b32]/25">
                <Crown className="h-4 w-4 text-[#eeb64e]" aria-hidden />
              </span>
              Chủ phòng duyệt người vào · tắt mic/camera · mời ra khỏi lớp
            </li>
            <li className="flex items-center justify-center gap-3 lg:justify-start">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#e14b32]/10 ring-1 ring-[#e14b32]/25">
                <MonitorUp className="h-4 w-4 text-[#f0977d]" aria-hidden />
              </span>
              Chia sẻ màn hình 60 fps — mượt như bảng tương tác
            </li>
            <li className="flex items-center justify-center gap-3 lg:justify-start">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#e14b32]/10 ring-1 ring-[#e14b32]/25">
                <HandIcon className="h-4 w-4 text-[#f0977d]" aria-hidden />
              </span>
              Giơ tay phát biểu, chat lớp học theo thời gian thực
            </li>
            <li className="flex items-center justify-center gap-3 lg:justify-start">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#e14b32]/10 ring-1 ring-[#e14b32]/25">
                <RefreshCw className="h-4 w-4 text-[#f0977d]" aria-hidden />
              </span>
              Tự động kết nối lại khi rớt mạng — học cả buổi dài
            </li>
          </ul>
        </section>

        {/* ---- Cột phải: các thẻ tạo / tham gia ---- */}
        <section className="w-full max-w-md space-y-6">
          {/* Thẻ 1: TẠO LỚP HỌC MỚI */}
          <BoardCard className="meet-fade-up meet-d-2 transition duration-200 hover:-translate-y-0.5">
            <div className="p-6">
              <h2 className="mb-4 flex items-center gap-2.5 text-base font-semibold tracking-tight">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#8fce9e]/10 ring-1 ring-[#8fce9e]/25">
                  <Video className="h-4 w-4 text-[#8fce9e]" aria-hidden />
                </span>
                Tạo lớp học mới
              </h2>
              <div className="space-y-5">
                <div className="space-y-2">
                  <Label
                    htmlFor="room-title"
                    className="text-sm font-medium text-[#a3bca6]"
                  >
                    Tên lớp (tuỳ chọn)
                  </Label>
                  <Input
                    id="room-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="VD: Lớp Sử 10A1 — Buổi 3"
                    maxLength={120}
                    className="border-[#35543f] bg-[#152a20] text-[#f2ead9] placeholder:text-[#78917c] focus-visible:ring-[#eeb64e]/50"
                  />
                </div>

                <Button
                  onClick={handleCreate}
                  disabled={creating || serviceUp === false}
                  className="h-11 w-full rounded-full bg-[#e14b32] text-sm font-semibold text-[#fff6ee] shadow-lg shadow-black/25 hover:bg-[#ef5c42] disabled:opacity-50"
                >
                  {creating ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                      Đang mở lớp…
                    </>
                  ) : (
                    <>
                      Tạo lớp — tôi sẽ là chủ phòng
                      <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
                    </>
                  )}
                </Button>

                {serviceUp === false && (
                  <p className="text-center text-xs text-[#ef7d63]">
                    Không kết nối được máy chủ. Hãy thử lại sau.
                  </p>
                )}
              </div>
            </div>
          </BoardCard>

          {/* Thẻ 2: THAM GIA BẰNG MÃ */}
          <BoardCard className="meet-fade-up meet-d-3 transition duration-200 hover:-translate-y-0.5">
            <div className="p-6">
              <h2 className="mb-4 flex items-center gap-2.5 text-base font-semibold tracking-tight">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#e14b32]/12 ring-1 ring-[#e14b32]/30">
                  <Keyboard className="h-4 w-4 text-[#f0977d]" aria-hidden />
                </span>
                Tham gia lớp học
              </h2>
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Input
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleJoin();
                    }}
                    placeholder="Nhập mã lớp hoặc dán liên kết…"
                    aria-label="Mã lớp hoặc liên kết"
                    className="border-[#35543f] bg-[#152a20] text-[#f2ead9] placeholder:text-[#78917c] focus-visible:ring-[#eeb64e]/50"
                  />
                  <Button
                    onClick={handleJoin}
                    disabled={joinCode.trim().length < 4}
                    className="rounded-full bg-[#e14b32] px-5 text-sm font-semibold text-[#fff6ee] shadow-lg shadow-black/25 hover:bg-[#ef5c42] disabled:opacity-40"
                  >
                    Vào sảnh
                  </Button>
                </div>
                {joinError && (
                  <p className="text-xs text-[#ef7d63]" role="alert">
                    {joinError}
                  </p>
                )}
              </div>
            </div>
          </BoardCard>
        </section>
      </main>

      {/* ============ FOOTER (dính đáy; góc trái dưới = ô mã chủ web) ============ */}
      <footer className="relative z-10 mt-auto border-t border-[#35543f]/60 px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
        <div className="mx-auto flex max-w-6xl items-center">
          {/* ---- Góc trái dưới ---- */}
          <div className="flex items-center gap-2">
            {ownerCode ? (
              <button
                onClick={() => setOwnerView(true)}
                className="flex h-8 items-center gap-1.5 rounded-full border border-[#8fce9e]/40 bg-[#8fce9e]/10 px-3 text-xs font-medium text-[#8fce9e] transition hover:bg-[#8fce9e]/20"
              >
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                Bảng điều khiển chủ web
              </button>
            ) : (
              <form
                onSubmit={submitCode}
                className={`flex items-center gap-1.5 ${codeShake ? "meet-shake" : ""}`}
                aria-label="Nhập mã quản trị"
              >
                <input
                  type="password"
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value)}
                  placeholder="Mã quản trị"
                  aria-label="Mã quản trị"
                  autoComplete="off"
                  maxLength={40}
                  className="h-8 w-36 rounded-lg border border-[#35543f] bg-[#1b3327] px-2.5 text-xs text-[#f2ead9] placeholder:text-[#78917c] focus:border-[#eeb64e]/60 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={codeInput.trim().length < 4}
                  className="flex h-8 items-center rounded-lg bg-[#24402f] px-3 text-xs font-medium text-[#f2ead9] transition hover:bg-[#2c4a38] disabled:opacity-40"
                >
                  Mở
                </button>
              </form>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
