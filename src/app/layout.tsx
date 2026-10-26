import type { Metadata, Viewport } from "next";
import { Be_Vietnam_Pro } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

/** Be Vietnam Pro — font hiển thị chính (next/font tự tải, subset tiếng Việt
 * đầy đủ) — phóng biến CSS --font-be-vietnam-pro cho --font-sans. */
const beVietnamPro = Be_Vietnam_Pro({
  subsets: ["vietnamese", "latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-be-vietnam-pro",
});

export const metadata: Metadata = {
  title: "KhanhMeet — Lớp học trực tuyến",
  description:
    "KhanhMeet — lớp học trực tuyến: tạo lớp trong một cú nhấp, chủ phòng duyệt người vào lớp, tắt mic/camera từ xa, chia sẻ màn hình mượt, chat và giơ tay.",
};

export const viewport: Viewport = {
  // Ứng dụng phòng học hoạt động toàn màn hình — khoá thu phóng để giao diện ổn định.
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#122019",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // meet-app: nền bảng xanh đậm xuyên suốt; lang="vi" cho trình đọc màn hình.
    // Font: Be Vietnam Pro (next/font tự tải) — dấu tiếng Việt chuẩn; nếu
    // chưa tải xong thì lùi về bộ font hệ thống theo --font-sans trong globals.css.
    <html
      lang="vi"
      className={`dark meet-app ${beVietnamPro.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased bg-[#122019] text-[#f2ead9]">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
