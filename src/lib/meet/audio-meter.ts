/**
 * ============================================================================
 *  ProctorMeet — ĐO MỨC ÂM THANH BẰNG WEB AUDIO API
 * ----------------------------------------------------------------------------
 *  Một AudioContext dùng chung toàn ứng dụng; mỗi MediaStream (local hoặc
 *  remote) gắn một AnalyserNode. Một vòng lặp rAF duy nhất tính RMS và
 *  thông báo cho subscriber (throttled ~120ms) để:
 *    - Hiển thị vạch mức âm thanh micro ở sảnh chờ.
 *    - Tô sáng viền ô video của người đang nói (speaking indicator).
 * ============================================================================
 */

"use client";

import { useEffect, useState } from "react";

type Listener = (level: number) => void;

interface MeterEntry {
  analyser: AnalyserNode;
  source: MediaStreamAudioSourceNode;
  data: Uint8Array;
  listeners: Set<Listener>;
  lastLevel: number;
  lastNotify: number;
}

/** Bản ghi meter theo tham chiếu MediaStream (duy nhất cho mỗi stream). */
const meters = new Map<MediaStream, MeterEntry>();

let audioCtx: AudioContext | null = null;
let rafId: number | null = null;
let resumeBound = false;

/** Lấy (hoặc tạo) AudioContext dùng chung; tự resume khi bị treo. */
function ensureContext(): AudioContext {
  if (!audioCtx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    audioCtx = new Ctor();
  }
  // Trình duyệt yêu cầu tương tác người dùng trước khi phát âm thanh;
  // gắn một listener một lần để "đánh thức" context ở cú click đầu tiên.
  if (!resumeBound && audioCtx.state === "suspended") {
    resumeBound = true;
    const resume = () => {
      audioCtx?.resume().catch(() => undefined);
      resumeBound = false;
      document.removeEventListener("pointerdown", resume);
    };
    document.addEventListener("pointerdown", resume);
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => undefined);
  }
  return audioCtx;
}

/** Vòng lặp rAF duy nhất tính RMS cho mọi meter đang hoạt động. */
function ensureLoop(): void {
  if (rafId !== null) return;
  const tick = () => {
    const now = performance.now();
    let hasActive = false;
    for (const entry of meters.values()) {
      if (entry.listeners.size === 0) continue;
      hasActive = true;
      entry.analyser.getByteTimeDomainData(
        entry.data as unknown as Uint8Array<ArrayBuffer>
      );
      // RMS (Root Mean Square) — biên độ trung bình của dạng sóng.
      let sum = 0;
      for (let i = 0; i < entry.data.length; i++) {
        const v = (entry.data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / entry.data.length);
      // Bình phương để nhấn mạnh khác biệt giữa "im lặng" và "đang nói".
      const level = Math.min(1, rms * rms * 4);

      // Chỉ thông báo khi mức thay đổi đáng kể hoặc đủ lâu chưa gửi
      // (tránh re-render React 60 lần/giây).
      const changed = Math.abs(level - entry.lastLevel) > 0.05;
      const due = now - entry.lastNotify > 150;
      if (changed || due) {
        entry.lastLevel = level;
        entry.lastNotify = now;
        for (const l of entry.listeners) l(level);
      }
    }
    rafId = hasActive ? requestAnimationFrame(tick) : null;
  };
  rafId = requestAnimationFrame(tick);
}

/**
 * Đăng ký theo dõi mức âm thanh của một MediaStream.
 * Trả về hàm huỷ đăng ký (dùng trong useEffect cleanup).
 */
export function subscribeAudioLevel(
  stream: MediaStream,
  listener: Listener
): () => void {
  const ctx = ensureContext();

  let entry = meters.get(stream);
  if (!entry) {
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser); // KHÔNG nối tới destination → không gây tiếng vọng
    entry = {
      analyser,
      source,
      data: new Uint8Array(analyser.fftSize),
      listeners: new Set(),
      lastLevel: 0,
      lastNotify: 0,
    };
    meters.set(stream, entry);
  }

  entry.listeners.add(listener);
  ensureLoop();

  return () => {
    const e = meters.get(stream);
    if (!e) return;
    e.listeners.delete(listener);
    // Không còn ai nghe → giải phóng tài nguyên Web Audio của stream này.
    if (e.listeners.size === 0) {
      try {
        e.source.disconnect();
      } catch {
        // Bỏ qua — node có thể đã bị ngắt trước đó.
      }
      meters.delete(stream);
    }
  };
}

/**
 * React Hook: trả về mức âm thanh (0..1) của stream, tự cập nhật.
 * Truyền `enabled = false` để tạm dừng đo (tiết kiệm CPU khi mic tắt).
 */
export function useAudioLevel(
  stream: MediaStream | null | undefined,
  enabled = true
): number {
  const [measured, setMeasured] = useState(0);

  // Chỉ thực sự đo khi stream tồn tại, đang bật và có track âm thanh.
  const hasAudioTrack = stream ? stream.getAudioTracks().length > 0 : false;
  const active = Boolean(stream) && enabled && hasAudioTrack;

  useEffect(() => {
    if (!stream || !active) return;
    return subscribeAudioLevel(stream, setMeasured);
  }, [stream, active]);

  // Khi không đo → luôn trả 0 (giá trị suy luận, không cần setState trong effect).
  return active ? measured : 0;
}

/**
 * Phát hai tiếng "bíp" ngắn bằng Web Audio — dùng cho cảnh báo từ chủ web
 * (quan trọng: người nhận phải nhận biết ngay cả khi đang nhìn chỗ khác).
 */
export function playAlertBeep(): void {
  try {
    const ctx = ensureContext();
    if (ctx.state === "suspended") return; // Chưa có tương tác người dùng
    const play = (startAt: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + startAt);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + startAt + 0.02);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        ctx.currentTime + startAt + 0.18
      );
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + startAt);
      osc.stop(ctx.currentTime + startAt + 0.2);
    };
    play(0);
    play(0.28);
  } catch {
    // Âm thanh chỉ là phần bổ trợ — không được phép làm vỡ luồng chính.
  }
}
