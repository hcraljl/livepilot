#!/usr/bin/env bash
# ============================================================================
# 构建官方开源观看页（polyv-web-live-watch-sdk）到 frontend/watch-sdk/
#
# 用途：LivePilot 右屏「观众端 · 真实观看页」用的就是这份产物。
#       它是保利威官方观看页的 UI 层（Vue 2.7 + 逻辑层 @polyv/live-watch-sdk），
#       自带播放器、聊天室、以及互动接收端（抽奖 / 答题卡 / 签到 / 卡片 / 公告）。
#
# 为什么不在 npm install 里自动做：它是独立工程（约 850MB 依赖），
# 只在需要更新观看页时手动跑一次，产物 dist-static 已入库。
#
# 用法：
#   bash scripts/build-watch-sdk.sh            # 构建并覆盖 frontend/watch-sdk
#   bash scripts/build-watch-sdk.sh --keep-tmp # 保留临时目录便于排查
#
# 前置：node >= 20.10、能访问 gitee.com 与 npm registry
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="${ROOT}/.tmp/watch-sdk"
OUT_DIR="${ROOT}/frontend/watch-sdk"
REPO="https://gitee.com/polyv_ef/polyv-web-live-watch-sdk.git"

KEEP_TMP=false
[[ "${1:-}" == "--keep-tmp" ]] && KEEP_TMP=true

echo "==> 1/4 拉取官方观看页源码"
mkdir -p "${ROOT}/.tmp"
if [ -d "${TMP_DIR}/.git" ]; then
  git -C "${TMP_DIR}" fetch --depth 1 origin HEAD
  git -C "${TMP_DIR}" reset --hard FETCH_HEAD
else
  rm -rf "${TMP_DIR}"
  git clone --depth 1 "${REPO}" "${TMP_DIR}"
fi

echo "==> 2/4 安装依赖（约 850MB，首次较慢）"
cd "${TMP_DIR}"
npm ci --no-audit --no-fund

echo "==> 3/4 构建静态产物（Vue2 + webpack，3~10 分钟）"
npm run build-static

if [ ! -f "${TMP_DIR}/dist-static/index.html" ]; then
  echo "!! 构建失败：未找到 dist-static/index.html" >&2
  exit 1
fi

echo "==> 4/4 复制到 frontend/watch-sdk/"
rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"
cp -r "${TMP_DIR}/dist-static/." "${OUT_DIR}/"

SIZE="$(du -sh "${OUT_DIR}" | cut -f1)"
echo
echo "✅ 完成：${OUT_DIR}（${SIZE}）"
echo "   启动后端后访问： http://localhost:4000/watch/index.html?channelId=<频道号>"

if [ "${KEEP_TMP}" = false ]; then
  rm -rf "${TMP_DIR}"
  echo "   已清理临时目录（如需保留加 --keep-tmp）"
fi
