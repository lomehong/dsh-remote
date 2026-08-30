#!/usr/bin/env bash
# 启动冒烟（best-effort）：临时 DSH_HOME + file:// patch 把本仓库装入 dsh web profile，
# 拉起并等待 webserver 就绪（日志出现 `dsh web:` 行）；同时盯插件加载失败标记。
# - dsh CLI 不在 PATH → 打印跳过并退出 0（CI 无 dsh 时属预期，不算失败）
# - 成功判定：~90s 内出现 `dsh web:`，且日志无 `DSH entry failed` / `plugin ... failed`
# - 结束后杀掉进程树（Linux kill；Windows Git Bash 回退 taskkill //T //F）并清理临时目录
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v dsh >/dev/null 2>&1; then
  echo "[boot-smoke] dsh CLI 不在 PATH，跳过"
  exit 0
fi

# file:// URL 需要本机绝对路径：Git Bash 的 /f/... 形态 Node 解析不了，转成 F:/...（msys/cygwin 均带 cygpath）
FILE_ROOT="$REPO_ROOT"
if command -v cygpath >/dev/null 2>&1; then
  FILE_ROOT="$(cygpath -m "$REPO_ROOT")" # F:/Development/...（正斜杠混合盘符形，file:// 可直接拼）
fi

TMP_HOME="$(mktemp -d)"
PATCH_FILE="$TMP_HOME/smoke.patch.yml"
LOG_FILE="$TMP_HOME/boot.log"
DSH_PID=""
cleanup() {
  if [ -n "$DSH_PID" ]; then
    kill "$DSH_PID" 2>/dev/null || true
    # Windows Git Bash：kill 只能杀直接子进程，进程树用 taskkill 兜底（// 防 MSYS 路径改写）
    if command -v taskkill >/dev/null 2>&1; then
      taskkill //PID "$DSH_PID" //T //F >/dev/null 2>&1 || true
    fi
  fi
  rm -rf "$TMP_HOME" 2>/dev/null || true
}
trap cleanup EXIT

# 最小 patch：把本仓库构建产物（file:// 入口文件）作为插件装入隔离 DSH_HOME。
# 注意 name 必须指向入口文件而非目录——cordis 插件加载器按 ESM 直导入（目录导入会
# ERR_UNSUPPORTED_DIR_IMPORT）；web 是 dsh 内置 profile，无需预先创建。
cat > "$PATCH_FILE" <<EOF
- insert:
    - id: dsh-remote
      name: 'file://${FILE_ROOT}/lib/index.js'
      config: {}
EOF

echo "[boot-smoke] DSH_HOME=$TMP_HOME 启动 dsh web profile…"
DSH_HOME="$TMP_HOME" dsh --profile web --patch "$PATCH_FILE" --no-open --port 0 >"$LOG_FILE" 2>&1 &
DSH_PID=$!

for _ in $(seq 1 90); do
  # 插件加载失败：立刻判负（避免误等 90s）
  if grep -Eq 'DSH entry failed|plugin.*failed' "$LOG_FILE" 2>/dev/null; then
    echo "[boot-smoke] FAIL：检测到插件加载失败标记"
    tail -n 40 "$LOG_FILE" || true
    exit 1
  fi
  if grep -q 'dsh web:' "$LOG_FILE" 2>/dev/null; then
    echo "[boot-smoke] OK：dsh web 就绪"
    exit 0
  fi
  if ! kill -0 "$DSH_PID" 2>/dev/null; then
    echo "[boot-smoke] FAIL：dsh 进程提前退出"
    tail -n 40 "$LOG_FILE" || true
    exit 1
  fi
  sleep 1
done

echo "[boot-smoke] FAIL：90 秒内未等到 dsh web 就绪"
tail -n 40 "$LOG_FILE" || true
exit 1
