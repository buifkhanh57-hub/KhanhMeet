/**
 * ============================================================================
 *  KhanhMeet — HOOK LIÊN KẾT CLIENT CLASS VÀO REACT
 * ----------------------------------------------------------------------------
 *  useClientState dùng useSyncExternalStore (React 19) để đăng ký theo dõi
 *  state của MeetingClient/OwnerClient một cách an toàn:
 *    • Không re-render thừa (state là object bất biến, thay tham chiếu mới).
 *    • An toàn SSR (trả null khi client chưa khởi tạo trong effect).
 *    • Tự huỷ đăng ký khi unmount.
 * ============================================================================
 */

"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { StateEmitter } from "@/lib/meet/emitter";

const noopSubscribe = (_cb: () => void): (() => void) => () => undefined;

/**
 * Theo dõi state của một client (MeetingClient/AdminClient).
 * Trả về null khi client chưa sẵn sàng (SSR / trước khi effect chạy).
 */
export function useClientState<S extends object>(
  client: StateEmitter<S> | null
): S | null {
  const subscribe = useCallback(
    (callback: () => void) => client?.subscribe(callback) ?? noopSubscribe(callback),
    [client]
  );
  const getSnapshot = useCallback(() => client?.getState() ?? null, [client]);

  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => null // Server snapshot: chưa có client nào tồn tại trên SSR.
  );
}
