#!/bin/sh
# ============================================================================
#  SUPERVISOR — giữ dịch vụ signaling luôn chạy trong MÔI TRƯỜNG PHÁT TRIỂN
#  (sandbox). Nếu tiến trình bị hệ điều hành/môi trường kill → tự khởi động
#  lại sau 1 giây. Trên Render KHÔNG cần file này (Render tự quản lý tiến trình).
#
#  Cách chạy (quan trọng: dùng double-fork subshell để sống sót qua các lệnh
#  terminal — tiến trình thẳng trực tiếp dễ bị thu hồi cùng phiên terminal):
#      ( nohup ./supervise.sh > /dev/null 2>&1 & )
# ============================================================================
cd "$(dirname "$0")" || exit 1
LOG=/tmp/khanhmeet-signaling.log
echo "[supervisor] khởi động $(date)" >> "$LOG"
while true; do
  bun index.ts >> "$LOG" 2>&1
  echo "[supervisor] dịch vụ thoát (code $?) — khởi động lại sau 1s ($(date))" >> "$LOG"
  sleep 1
done
