/**
 * ============================================================================
 *  KhanhMeet — LỚP CƠ SỞ: NGUỒN TRẠNG THÁI CÓ KHẢ NĂNG ĐĂNG KÝ (OBSERVER)
 * ----------------------------------------------------------------------------
 *  Cả MeetingClient (thành viên) và OwnerClient (chủ web) đều kế thừa lớp này.
 *  State luôn là object bất biến (mỗi lần cập nhật tạo bản sao mới) — điều
 *  kiện bắt buộc để dùng an toàn với useSyncExternalStore của React 19.
 * ============================================================================
 */

export abstract class StateEmitter<S extends object> {
  protected state: S;
  private listeners = new Set<() => void>();

  constructor(initial: S) {
    this.state = initial;
  }

  /** Gộp bản vá vào state rồi thông báo cho mọi subscriber. */
  protected setState(patch: Partial<S>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Đăng ký callback chạy mỗi khi state thay đổi — trả về hàm huỷ. */
  subscribe = (callback: () => void): (() => void) => {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  };

  /** Bản chụp state hiện tại (bất biến theo thời điểm gọi). */
  getState = (): S => this.state;
}
