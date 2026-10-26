"use client";

/**
 * ============================================================================
 *  LỚP HỌC TRỰC TUYẾN — SẢNH CHỜ TRƯỚC CỬA LỚP (PRE-JOIN LOBBY)
 * ----------------------------------------------------------------------------
 *  Quy trình 2 bước rõ ràng:
 *
 *    BƯỚC 1 — Kiểm tra thiết bị:
 *      • Khung xem trước camera/micro thật (getUserMedia) 16:9 chuẩn, đặt
 *        trong thẻ "bảng đen khung gỗ".
 *      • Hai nút tròn bật/tắt Camera & Micro đè lên khung xem trước.
 *      • Vạch đo mức âm thanh micro (Web Audio API).
 *      • Chọn thiết bị camera/micro ngay tại sảnh.
 *      • Thiết bị lỗi → vẫn vào được lớp không dùng camera (nút đổi nhãn).
 *
 *    BƯỚC 2 — Nhập tên & vào sảnh:
 *      • Ô "Tên hiển thị của bạn" BẮT BUỘC (tối thiểu 2 ký tự).
 *      • CHỦ PHÒNG: vào thẳng lớp (không chờ duyệt) — có banner vàng nhắc.
 *      • THÀNH VIÊN: bấm nút xong sẽ CHỜ CHỦ PHÒNG DUYỆT ở bước kế tiếp
 *        (xem MeetingRoom — pha "waiting").
 * ============================================================================
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  ArrowLeft,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Signal,
  Check,
  Camera,
  Keyboard,
  Crown,
  Hourglass,
  Smartphone,
  Link2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAudioLevel } from "@/lib/meet/audio-meter";
import {
  copyToClipboard,
  isInAppBrowser,
  mediaApiAvailable,
} from "@/lib/meet/signaling";
import { BoardCard } from "./decor";

export interface LobbyJoinPayload {
  name: string;
  stream: MediaStream | null;
  camOn: boolean;
  micOn: boolean;
}

interface LobbyProps {
  roomId: string;
  roomTitle: string;
  /** Máy này có khoá chủ phòng (người tạo lớp) không? */
  isHost?: boolean;
  /** Chủ phòng đã vào lớp chưa (hiển thị gợi ý cho thành viên). */
  hostOnline?: boolean | null;
  /** Lớp này có bắt buộc duyệt trước khi vào không? */
  approvalRequired?: boolean;
  onJoin: (payload: LobbyJoinPayload) => void;
  onBack: () => void;
}

/** Phân loại lỗi getUserMedia thành thông báo tiếng Việt thân thiện. */
function describeMediaError(err: unknown): string {
  // Trình duyệt nhúng (Zalo…) thường KHÔNG CÓ API camera — giải thích rõ.
  if (!mediaApiAvailable()) {
    return "Trình duyệt này không hỗ trợ camera/micro. Hãy mở liên kết lớp bằng Chrome (Android) hoặc Safari (iPhone) rồi thử lại.";
  }
  const name = (err as { name?: string })?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return isInAppBrowser()
        ? "Trình duyệt nhúng của ứng dụng đang CHẶN camera/micro. Hãy bấm nút ⋮ (góc phải) → “Mở bằng trình duyệt ngoài” hoặc copy liên kết rồi mở bằng Chrome/Safari."
        : "Bạn đã TỪ CHỐI cấp quyền camera/micro. Hãy bấm biểu tượng khoá/ảnh camera trên thanh địa chỉ trình duyệt, chọn “Cho phép” rồi bấm “Thử lại”.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "Không tìm thấy camera hoặc micro trên thiết bị này. Hãy kiểm tra kết nối thiết bị rồi bấm “Thử lại”, hoặc tham gia không dùng camera.";
    case "NotReadableError":
    case "TrackStartError":
      return "Camera/micro đang bị một ứng dụng khác chiếm dụng (Zoom, Teams…). Hãy đóng ứng dụng đó rồi bấm “Thử lại”.";
    default:
      return "Không truy cập được camera/micro. Hãy kiểm tra thiết bị và quyền truy cập, rồi bấm “Thử lại”.";
  }
}

export function Lobby({
  roomId,
  roomTitle,
  isHost = false,
  hostOnline = null,
  approvalRequired = false,
  onJoin,
  onBack,
}: LobbyProps) {
  const [name, setName] = useState("");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [acquiring, setAcquiring] = useState(true);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [selectedCam, setSelectedCam] = useState<string>("default");
  const [selectedMic, setSelectedMic] = useState<string>("default");
  const [copiedLink, setCopiedLink] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  /** Cờ bảo vệ: khi đã bấm Tham gia thì KHÔNG dừng track lúc unmount sảnh. */
  const joinedRef = useRef(false);
  /** Đang mở trong trình duyệt nhúng (Zalo…) — hiện cảnh báo mở bằng trình duyệt thật. */
  const [inApp] = useState(() => isInAppBrowser());
  const [copiedRoomLink, setCopiedRoomLink] = useState(false);

  const micLevel = useAudioLevel(stream, micOn);

  /** Mở luồng preview: thử cả camera + micro theo thiết bị đang chọn. */
  const acquireMedia = useCallback(
    async (camId?: string, micId?: string) => {
      setAcquiring(true);
      setMediaError(null);
      try {
        const constraints: MediaStreamConstraints = {
          video:
            camId && camId !== "default"
              ? { deviceId: { exact: camId } }
              : true,
          audio:
            micId && micId !== "default"
              ? { deviceId: { exact: micId } }
              : true,
        };
        const media = await navigator.mediaDevices.getUserMedia(constraints);
        // Giữ nguyên trạng thái bật/tắt hiện tại của người dùng.
        for (const track of media.getVideoTracks()) track.enabled = camOn;
        for (const track of media.getAudioTracks()) track.enabled = micOn;
        setStream(media);

        // Sau khi có quyền, mới đọc được nhãn thiết bị (label không rỗng).
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          setCameras(devices.filter((d) => d.kind === "videoinput"));
          setMicrophones(devices.filter((d) => d.kind === "audioinput"));
          const activeCam = media.getVideoTracks()[0]?.getSettings().deviceId;
          const activeMic = media.getAudioTracks()[0]?.getSettings().deviceId;
          if (activeCam) setSelectedCam(activeCam);
          if (activeMic) setSelectedMic(activeMic);
        } catch {
          // enumerateDevices thất bại không chặn luồng chính.
        }
      } catch (err) {
        console.error("[lobby] getUserMedia lỗi:", err);
        setStream(null);
        setMediaError(describeMediaError(err));
      } finally {
        setAcquiring(false);
      }
    },
    [camOn, micOn]
  );

  /* Lấy thiết bị ngay khi vào sảnh (nếu trình duyệt có API). */
  useEffect(() => {
    if (mediaApiAvailable()) {
      void acquireMedia();
    } else {
      setAcquiring(false);
      setMediaError(describeMediaError(null));
    }
    // Chỉ chạy một lần khi mount — acquireMedia tự quản lý thiết bị chọn.
  }, []);

  /* Gắn luồng vào thẻ <video> preview. */
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  /* Rời sảnh mà chưa tham gia → giải phóng thiết bị. */
  useEffect(() => {
    return () => {
      if (!joinedRef.current && stream) {
        for (const track of stream.getTracks()) track.stop();
      }
    };
  }, [stream]);

  /** Bật/tắt camera ở sảnh — thao tác thật trên track. */
  const toggleCam = () => {
    const next = !camOn;
    for (const track of stream?.getVideoTracks() ?? []) track.enabled = next;
    setCamOn(next);
  };

  const toggleMic = () => {
    const next = !micOn;
    for (const track of stream?.getAudioTracks() ?? []) track.enabled = next;
    setMicOn(next);
  };

  /** Đổi thiết bị: dừng luồng cũ, mở luồng với deviceId mới. */
  const changeDevice = (kind: "video" | "audio", deviceId: string) => {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    if (kind === "video") {
      setSelectedCam(deviceId);
      void acquireMedia(deviceId, selectedMic);
    } else {
      setSelectedMic(deviceId);
      void acquireMedia(selectedCam, deviceId);
    }
  };

  /* ---- Quy tắc cho nút Tham gia (đơn giản & dễ hiểu) ---- */
  const nameValid = name.trim().length >= 2;
  const mediaReady = stream !== null;
  const joinable = nameValid && !acquiring;

  const handleJoin = () => {
    if (!joinable) return;
    joinedRef.current = true;
    onJoin({
      name: name.trim(),
      stream,
      camOn: camOn && mediaReady,
      micOn: micOn && mediaReady,
    });
  };

  /* ---- Trạng thái 2 bước (hiển thị trực tiếp) ---- */
  const step1Done = mediaReady || mediaError !== null;
  const step2Done = nameValid;

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-[#122019] text-[#f2ead9]">
      {/* ============ THANH TRÊN ============ */}
      <header className="meet-fade-up relative z-10 flex items-center justify-between gap-2 px-4 py-4 sm:px-6">
        <Button
          variant="ghost"
          onClick={onBack}
          className="gap-2 rounded-full text-sm text-[#a3bca6] hover:bg-[#24402f] hover:text-[#f2ead9]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Trang chủ
        </Button>
        <button
          className="flex items-center gap-2 rounded-full border border-[#35543f] bg-[#1b3327]/80 px-4 py-1.5 text-xs text-[#a3bca6] transition hover:bg-[#24402f] hover:text-[#f2ead9]"
          onClick={async () => {
            const ok = await copyToClipboard(
              `${window.location.origin}/#/room/${roomId}`
            );
            if (ok) {
              setCopiedLink(true);
              setTimeout(() => setCopiedLink(false), 2000);
            }
          }}
          title="Bấm để sao chép liên kết lớp gửi cho bạn học"
        >
          <span className="font-mono">{roomId.slice(0, 8)}…</span>
          <span className={copiedLink ? "text-[#8fce9e]" : ""}>
            {copiedLink ? "· Đã sao chép" : "· Sao chép liên kết"}
          </span>
        </button>
      </header>

      {/* ============ THÂN SẢNH ============ */}
      <main className="relative z-10 mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-6 px-4 pb-10">
        <div className="meet-fade-up text-center">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {isHost ? "Mở cửa lớp học" : "Tham gia lớp học"}
          </h1>
          {roomTitle && (
            <p className="mt-1.5 text-sm text-[#a3bca6]">{roomTitle}</p>
          )}
        </div>

        {/* ---- Cảnh báo trình duyệt nhúng (Zalo/Facebook chặn camera) ---- */}
        {inApp && (
          <div className="meet-fade-up flex w-full max-w-xl items-start gap-3 rounded-2xl bg-[#eeb64e]/10 p-4 ring-1 ring-[#eeb64e]/30">
            <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-[#eeb64e]" aria-hidden />
            <div className="min-w-0 flex-1 text-sm leading-relaxed">
              <p className="font-semibold text-[#eeb64e]">
                Đang mở trong trình duyệt nhúng — camera/micro có thể bị chặn
              </p>
              <p className="mt-0.5 text-[#cdbf95]">
                Hãy bấm nút ⋮ / chia sẻ của ứng dụng và chọn
                “Mở bằng trình duyệt ngoài” (Chrome đối với Android, Safari
                đối với iPhone) để dùng đầy đủ camera, micro và âm thanh.
              </p>
              <button
                onClick={async () => {
                  const ok = await copyToClipboard(
                    `${window.location.origin}/#/room/${roomId}`
                  );
                  if (ok) {
                    setCopiedRoomLink(true);
                    setTimeout(() => setCopiedRoomLink(false), 2000);
                  }
                }}
                className="mt-2.5 inline-flex h-9 items-center gap-1.5 rounded-full bg-[#eeb64e]/15 px-3.5 text-xs font-semibold text-[#eeb64e] transition hover:bg-[#eeb64e]/25"
              >
                <Link2 className="h-3.5 w-3.5" aria-hidden />
                {copiedRoomLink ? "Đã sao chép liên kết lớp" : "Sao chép liên kết lớp"}
              </button>
            </div>
          </div>
        )}

        {/* ---- Banner vai trò ---- */}
        {isHost ? (
          <div className="meet-fade-up flex w-full max-w-xl items-start gap-3 rounded-2xl bg-[#eeb64e]/10 p-4 ring-1 ring-[#eeb64e]/30">
            <Crown className="mt-0.5 h-5 w-5 shrink-0 text-[#eeb64e]" aria-hidden />
            <div className="text-sm leading-relaxed">
              <p className="font-semibold text-[#eeb64e]">
                Bạn là CHỦ PHÒNG của lớp này
              </p>
              <p className="mt-0.5 text-[#cdbf95]">
                Vào thẳng lớp; bạn học gõ cửa sẽ hiện trong bảng
                Người tham gia.
              </p>
            </div>
          </div>
        ) : approvalRequired ? (
          <div className="meet-fade-up flex w-full max-w-xl items-start gap-3 rounded-2xl bg-[#1b3327]/80 p-4 ring-1 ring-[#35543f]">
            <Hourglass className="mt-0.5 h-5 w-5 shrink-0 text-[#eeb64e]" aria-hidden />
            <div className="text-sm leading-relaxed">
              <p className="font-semibold text-[#f2ead9]">
                Lớp này cần chủ phòng duyệt
              </p>
              <p className="mt-0.5 text-[#a3bca6]">
                {hostOnline === true
                  ? "Chủ phòng đang trong lớp — chờ “Đồng ý” là vào ngay."
                  : "Chủ phòng chưa vào lớp — bạn gửi yêu cầu, chủ phòng vào sẽ duyệt."}
              </p>
            </div>
          </div>
        ) : null}

        {/* ---- Chỉ dẫn 2 bước ---- */}
        <ol
          className="meet-fade-up meet-d-1 flex w-full max-w-md items-center gap-3"
          aria-label="Các bước tham gia"
        >
          <li className="flex min-w-0 flex-1 items-center gap-2.5">
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition ${
                step1Done
                  ? "bg-[#e14b32] text-[#fff6ee]"
                  : "bg-[#24402f] text-[#f2ead9]"
              }`}
            >
              {step1Done ? <Check className="h-4 w-4" aria-hidden /> : "1"}
            </span>
            <span
              className={`truncate text-xs font-medium transition ${
                step1Done ? "text-[#f0977d]" : "text-[#a3bca6]"
              }`}
            >
              Kiểm tra thiết bị
            </span>
            <span
              aria-hidden
              className={`h-0.5 flex-1 rounded-full transition ${
                step1Done ? "bg-[#e14b32]/40" : "bg-[#35543f]"
              }`}
            />
          </li>
          <li className="flex min-w-0 items-center gap-2.5">
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition ${
                step2Done
                  ? "bg-[#e14b32] text-[#fff6ee]"
                  : "bg-[#24402f] text-[#f2ead9]"
              }`}
            >
              {step2Done ? <Check className="h-4 w-4" aria-hidden /> : "2"}
            </span>
            <span
              className={`truncate text-xs font-medium transition ${
                step2Done ? "text-[#f0977d]" : "text-[#a3bca6]"
              }`}
            >
              Nhập tên &amp; vào sảnh
            </span>
          </li>
        </ol>

        {/* ---- BƯỚC 1: Khung preview 16:9 trong khung gỗ ---- */}
        <div className="meet-fade-up meet-d-1 w-full">
          <BoardCard>
            <div className="relative aspect-video w-full overflow-hidden rounded-[calc(1.35rem-3px)] bg-[#0e1c14]">
              {acquiring && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[#a3bca6]">
                  <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
                  <p className="text-sm">Đang truy cập camera &amp; micro…</p>
                </div>
              )}

              {!acquiring && mediaError && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
                  <AlertTriangle className="h-10 w-10 text-[#ef7d63]" aria-hidden />
                  <p className="max-w-md text-sm leading-relaxed text-[#f2ead9]">
                    {mediaError}
                  </p>
                  <Button
                    onClick={() => void acquireMedia(selectedCam, selectedMic)}
                    className="rounded-full bg-[#e14b32] px-5 text-sm font-semibold text-[#fff6ee] shadow-lg shadow-black/25 hover:bg-[#ef5c42]"
                  >
                    <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
                    Thử lại
                  </Button>
                </div>
              )}

              {!acquiring && !mediaError && stream && (
                <>
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted // Luôn tắt tiếng preview để không gây tiếng vọng.
                    className={`h-full w-full object-cover ${camOn ? "" : "opacity-0"} meet-mirror`}
                    aria-label="Xem trước camera của bạn"
                  />
                  {!camOn && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="flex h-20 w-20 items-center justify-center rounded-full bg-[#122019]/80">
                        <VideoOff className="h-8 w-8 text-[#a3bca6]" aria-hidden />
                      </span>
                    </div>
                  )}
                  {/* Hai nút tròn bật/tắt nhanh — đè đáy giữa khung. */}
                  <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-4">
                    <button
                      onClick={toggleMic}
                      className={`meet-icon-btn flex h-12 w-12 items-center justify-center rounded-full backdrop-blur transition ${
                        micOn
                          ? "bg-[#122019]/80 text-white hover:bg-[#24402f]"
                          : "bg-[#e14b32] text-[#fff6ee] hover:bg-[#ef5c42]"
                      }`}
                      aria-label={micOn ? "Tắt micro" : "Bật micro"}
                      title={micOn ? "Tắt micro" : "Bật micro"}
                    >
                      {micOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
                    </button>
                    <button
                      onClick={toggleCam}
                      className={`meet-icon-btn flex h-12 w-12 items-center justify-center rounded-full backdrop-blur transition ${
                        camOn
                          ? "bg-[#122019]/80 text-white hover:bg-[#24402f]"
                          : "bg-[#e14b32] text-[#fff6ee] hover:bg-[#ef5c42]"
                      }`}
                      aria-label={camOn ? "Tắt camera" : "Bật camera"}
                      title={camOn ? "Tắt camera" : "Bật camera"}
                    >
                      {camOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
                    </button>
                  </div>
                </>
              )}
            </div>
          </BoardCard>

          {/* ---- Vạch mức âm thanh micro ---- */}
          <div className="mx-auto mt-3 flex w-2/3 items-center gap-3">
            <Mic
              className={`h-4 w-4 shrink-0 ${micOn ? "text-[#8fce9e]" : "text-[#78917c]"}`}
              aria-hidden
            />
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#24402f]">
              <div
                className="h-full rounded-full bg-[#8fce9e] transition-[width] duration-100"
                style={{ width: `${Math.min(100, Math.round(micLevel * 140))}%` }}
                role="meter"
                aria-label="Mức âm thanh micro"
                aria-valuenow={Math.round(micLevel * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
            <Signal className="h-4 w-4 shrink-0 text-[#78917c]" aria-hidden />
          </div>
        </div>

        {/* ---- BƯỚC 2: Biểu mẫu tên + thiết bị + nút tham gia ---- */}
        <div className="meet-fade-up meet-d-2 w-full space-y-4">
          <div className="space-y-2">
            <Label
              htmlFor="fullname"
              className="text-sm font-medium text-[#a3bca6]"
            >
              Tên hiển thị của bạn <span className="text-[#ef7d63]">*</span>
            </Label>
            <Input
              id="fullname"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && joinable) handleJoin();
              }}
              placeholder="VD: Nguyễn Văn An"
              maxLength={60}
              autoComplete="name"
              aria-invalid={!nameValid}
              aria-describedby="fullname-hint"
              className="h-12 border-[#35543f] bg-[#1b3327] text-[#f2ead9] placeholder:text-[#78917c] focus-visible:ring-[#eeb64e]/50"
            />
            <p
              id="fullname-hint"
              className={`flex items-center gap-1.5 text-xs ${
                nameValid ? "text-[#8fce9e]" : "text-[#a3bca6]"
              }`}
              role="status"
            >
              {nameValid ? (
                <>
                  <Check className="h-3.5 w-3.5" aria-hidden />
                  Tên hợp lệ — mọi người trong lớp sẽ thấy tên này
                </>
              ) : (
                "Nhập tên của bạn (tối thiểu 2 ký tự) để tiếp tục"
              )}
            </p>
          </div>

          {/* Chọn thiết bị (hiện khi đã có quyền) */}
          {mediaReady && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5 text-sm font-medium text-[#a3bca6]">
                  <Camera className="h-3.5 w-3.5" aria-hidden />
                  Camera
                </Label>
                <Select
                  value={selectedCam}
                  onValueChange={(v) => changeDevice("video", v)}
                >
                  <SelectTrigger className="w-full border-[#35543f] bg-[#1b3327] text-[#f2ead9]">
                    <SelectValue placeholder="Camera mặc định" />
                  </SelectTrigger>
                  <SelectContent className="border-[#35543f] bg-[#1b3327] text-[#f2ead9]">
                    {cameras.map((device, i) => (
                      <SelectItem key={device.deviceId} value={device.deviceId}>
                        {device.label || `Camera ${i + 1}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5 text-sm font-medium text-[#a3bca6]">
                  <Keyboard className="h-3.5 w-3.5" aria-hidden />
                  Micro
                </Label>
                <Select
                  value={selectedMic}
                  onValueChange={(v) => changeDevice("audio", v)}
                >
                  <SelectTrigger className="w-full border-[#35543f] bg-[#1b3327] text-[#f2ead9]">
                    <SelectValue placeholder="Micro mặc định" />
                  </SelectTrigger>
                  <SelectContent className="border-[#35543f] bg-[#1b3327] text-[#f2ead9]">
                    {microphones.map((device, i) => (
                      <SelectItem key={device.deviceId} value={device.deviceId}>
                        {device.label || `Micro ${i + 1}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <Button
            onClick={handleJoin}
            disabled={!joinable}
            className="h-12 w-full rounded-full bg-[#e14b32] text-sm font-semibold text-[#fff6ee] shadow-lg shadow-black/25 hover:bg-[#ef5c42] disabled:opacity-40"
          >
            {isHost
              ? "Vào lớp — với tư cách chủ phòng"
              : mediaError
                ? "Gửi yêu cầu (không dùng camera)"
                : approvalRequired
                  ? "Gõ cửa lớp — chờ chủ phòng duyệt"
                  : "Tham gia lớp học"}
          </Button>

          {/* Dòng gợi ý luôn giải thích trạng thái nút */}
          <p className="text-center text-xs text-[#a3bca6]" role="status">
            {!nameValid
              ? "Nhập tên của bạn để bật nút tham gia."
              : acquiring
                ? "Đang kết nối thiết bị…"
                : mediaError
                  ? "Bạn sẽ vào lớp không có hình ảnh — vẫn nghe và chat được bình thường."
                  : isHost
                    ? "Chủ phòng vào thẳng lớp; bạn học sẽ gõ cửa chờ bạn duyệt."
                    : approvalRequired
                      ? "Chủ phòng sẽ thấy tên bạn và bấm Đồng ý để mở cửa lớp."
                      : "Kiểm tra hình ảnh và âm thanh ở trên rồi bấm tham gia."}
          </p>
        </div>
      </main>
    </div>
  );
}
