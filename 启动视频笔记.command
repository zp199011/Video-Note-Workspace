#!/bin/zsh

set -u

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${SUBTITLE_PORT:-4173}"

cd "$PROJECT_DIR" || exit 1

echo ""
echo "字幕研究室 / 视频笔记工作台"
echo "项目目录：$PROJECT_DIR"
echo "服务端口：$PORT"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 Node.js 18 或更高版本。"
  read -r -k 1 "?按任意键退出。"
  echo ""
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "未找到 npm，请检查 Node.js 安装。"
  read -r -k 1 "?按任意键退出。"
  echo ""
  exit 1
fi

for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
  process_command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  process_cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"

  if [[ "$process_cwd" == "$PROJECT_DIR" && "$process_command" == *"server.js"* ]]; then
    echo "发现当前项目的旧服务（PID $pid），正在重启…"
    kill "$pid" 2>/dev/null || true
    for attempt in {1..20}; do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      sleep 0.25
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "旧服务没有在规定时间内退出，已停止启动，避免重复占用端口。"
      read -r -k 1 "?按任意键退出。"
      echo ""
      exit 1
    fi
  else
    echo "端口 $PORT 已被其他程序占用："
    echo "  PID：$pid"
    echo "  命令：$process_command"
    echo "  目录：$process_cwd"
    echo "脚本不会结束或强制关闭这个进程。"
    read -r -k 1 "?按任意键退出。"
    echo ""
    exit 1
  fi
done

echo "正在启动服务…"
(
  sleep 1
  open "http://127.0.0.1:$PORT" >/dev/null 2>&1 || true
) &

exec npm start
