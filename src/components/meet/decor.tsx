"use client";

/**
 * ============================================================================
 *  KHANHMEET — BỘ TRANG TRÍ (SVG/inline, không phụ thuộc mạng)
 * ----------------------------------------------------------------------------
 *  • KhanhMeetMark  — logo KhanhMeet: icon camera trong ô bo góc (kiểu logo
 *                     gốc), dùng làm logo header / spinner màn chờ.
 *  • KhanhMeetLogo  — logo đầy đủ: KhanhMeetMark + chữ "KhanhMeet".
 *  • BoardCard      — thẻ "bảng đen khung gỗ" dùng xuyên suốt giao diện.
 * ============================================================================
 */

import { type ReactNode } from "react";
import { Video } from "lucide-react";

/* ========================================================================== */
/* LOGO KHANHMEET                                                              */
/* ========================================================================== */

/**
 * Logo mark KhanhMeet — icon camera màu xanh lá trên ô xanh đậm bo góc,
 * tái hiện kiểu logo gốc của ứng dụng. Chỉ dùng ở header trang chủ.
 */
export function KhanhMeetMark({
  size = 40,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-2xl bg-[#1b3327] shadow-lg shadow-black/30 ring-1 ring-[#35543f] ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <Video
        style={{ width: Math.round(size * 0.52), height: Math.round(size * 0.52) }}
        className="text-[#8fce9e]"
        strokeWidth={2.2}
      />
    </span>
  );
}

/** Logo đầy đủ: mark + wordmark "KhanhMeet" ("Meet" màu xanh lá). */
export function KhanhMeetLogo({
  size = 40,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <KhanhMeetMark size={size} />
      <span className="text-lg font-semibold tracking-tight">
        Khanh<span className="text-[#8fce9e]">Meet</span>
      </span>
    </span>
  );
}

/* ========================================================================== */
/* THẺ "BẢNG ĐEN KHUNG GỖ"                                                     */
/* ========================================================================== */

/**
 * Thẻ nội dung chuẩn của giao diện: khung gỗ ấm bao bảng đen phủ bụi phấn.
 * Dùng cho mọi thẻ chính (tạo phòng, tham gia, sảnh chờ, màn chờ duyệt…).
 */
export function BoardCard({
  className = "",
  innerClassName = "",
  children,
}: {
  className?: string;
  /** Lớp bổ sung cho bề mặt bảng bên trong (padding, radius… tự đặt). */
  innerClassName?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`gd-wood rounded-[1.35rem] p-[3px] shadow-xl shadow-black/40 ${className}`}
    >
      <div
        className={`gd-board rounded-[calc(1.35rem-3px)] ${innerClassName}`}
      >
        {children}
      </div>
    </div>
  );
}
