#!/usr/bin/env bash
#
# 一键启动 steve 的 ACP HTTP 服务（远程 / 云端访问用）。
#
#   bash scripts/steve-acp-serve.sh                 # 默认 http://127.0.0.1:8891/acp，页面 http://127.0.0.1:8891/
#   bash scripts/steve-acp-serve.sh --port 9000     # 额外的参数原样透传给 steve-acp，且可覆盖本脚本的默认值
#   bash scripts/steve-acp-serve.sh --daemon        # 后台跑，日志与 pidfile 落在 ~/.steve/log/
#   bash scripts/steve-acp-serve.sh --stop          # 停掉 --daemon 起的那个实例（同端口）
#   bash scripts/steve-acp-serve.sh --foreground    # 显式前台（systemd/launchd 用这个，日志交给 journald）
#
# --daemon 的日志与 pidfile 在 $STEVE_ACP_LOG_DIR（默认 ~/.steve/log/），按端口命名：
#   steve-acp-8891.log / steve-acp-8891.pid
#
# token 从 ~/.steve/.env 的 ACP_TOKEN 读取。
# 注意：steve 自己不读 ACP_TOKEN（它只认 process.env），所以是这里取出来再用 --token 传进去。
# 该文件同时还是 steve 的凭据来源之一，因此可以只维护一份 ~/.steve/.env：
#
#   LLM_API_KEY=...      # steve 读
#   LLM_MODEL_ID=...
#   LLM_BASE_URL=...
#   ACP_TOKEN=...        # 本脚本读
#
# 可覆盖项（环境变量，默认值见下）：
#   STEVE_ACP_ENV_FILE  ~/.steve/.env       token 从哪个文件读
#   ACP_TOKEN           无                 直接给 token，优先于文件（与 steve 的「真实环境变量最优先」一致）
#   ACP_HOST            127.0.0.1           对外服务要先反代；直接暴露才写 0.0.0.0
#   ACP_PORT            8891
#   ACP_PATH            /acp
#   ACP_SESSION_DIR     ~/.steve/sessions   transcript 落盘位置，会自动 mkdir -p
#   ACP_PERMISSIONS     ask                 ask | allow（allow 不问直接执行写/命令，慎用）
#   ACP_ALLOW_LOCAL_TOOLS  true             false 则不给本地文件/命令工具
#   ACP_QUIET           前台 true / --daemon 时 false     false 则打开 steve 自己的日志
#   ACP_CORS            空                  只在「页面与端点不同源」时需要，如 "*"
#   STEVE_ACP_LOG_DIR  ~/.steve/log         --daemon 的日志与 pidfile 目录（按端口命名）
#
# cwd 有意义：`.steve/mcp.json` 与 `.steve/extensions/` 都按启动目录发现，
# 所以想带哪个项目的 MCP / 插件，就在那个目录里启动本脚本。
set -euo pipefail

# npm 的 bin 是软链（bin/steve-acp-serve -> ../lib/node_modules/steve/scripts/…），
# 所以要先顺着软链找到脚本真实位置，dirname 才不会停在 bin/ 上。
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
	DIR="$(cd -- "$(dirname -- "$SOURCE")" && pwd)"
	SOURCE="$(readlink "$SOURCE")"
	case "$SOURCE" in /*) ;; *) SOURCE="$DIR/$SOURCE" ;; esac
done
SCRIPT_DIR="$(cd -- "$(dirname -- "$SOURCE")" && pwd)"

ENV_FILE="${STEVE_ACP_ENV_FILE:-$HOME/.steve/.env}"
HOST="${ACP_HOST:-127.0.0.1}"
PORT="${ACP_PORT:-8891}"
ENDPOINT_PATH="${ACP_PATH:-/acp}"
SESSION_DIR="${ACP_SESSION_DIR:-$HOME/.steve/sessions}"
PERMISSIONS="${ACP_PERMISSIONS:-ask}"
ALLOW_LOCAL_TOOLS="${ACP_ALLOW_LOCAL_TOOLS:-true}"
QUIET="${ACP_QUIET:-}"
CORS="${ACP_CORS:-}"

die() {
	printf 'steve-acp-serve: %s\n' "$1" >&2
	exit 1
}

# 只影响打印：$HOME 前缀缩成 ~，免得截图 / 贴日志 / 报 bug 时带出用户名。
# 内部照旧用绝对路径；指到 $HOME 外面（如 /etc/steve/steve.env）时原样显示，方便排查。
tilde() {
	case "$1" in
		"$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
		*) printf '%s' "$1" ;;
	esac
}

# ---- 脚本自己的开关：--daemon / --foreground / --stop 自己消化，其余原样透传 ----
DAEMON=false
STOP=false
HELP=false
PASSTHROUGH=()
for arg in "$@"; do
	case "$arg" in
		--daemon|-d) DAEMON=true ;;
		--foreground) DAEMON=false ;;
		--stop) STOP=true ;;
		-h|--help) HELP=true ;;
		*) PASSTHROUGH+=("$arg") ;;
	esac
done

LOG_DIR="${STEVE_ACP_LOG_DIR:-$HOME/.steve/log}"

# 后台运行时默认打开 steve 自己的日志（前台保持安静），除非显式设了 ACP_QUIET。
if [ -z "$QUIET" ]; then
	if [ "$DAEMON" = "true" ]; then QUIET=false; else QUIET=true; fi
fi

# 优先用装到 PATH 上的命令；没装则退回包内（或仓库里）的构建产物。
if command -v steve-acp >/dev/null 2>&1; then
	CMD=(steve-acp)
elif [ -f "$SCRIPT_DIR/../dist/protocols/acp/main.js" ]; then
	CMD=(node "$SCRIPT_DIR/../dist/protocols/acp/main.js")
else
	die "找不到 steve-acp：先 npm run build，或 npm i -g @zhyoung/steve"
fi

# --help 要能在没有 token 的情况下看，所以放在 token 解析之前。
if [ "$HELP" = "true" ]; then
	cat <<EOF
steve-acp-serve — 一键启动 steve 的 ACP HTTP 服务（token 取自 $(tilde "$ENV_FILE") 的 ACP_TOKEN）

用法
  steve-acp-serve [--daemon | --foreground] [--stop] [steve-acp 的参数…]

本脚本自己的开关
  --daemon, -d   后台运行；日志与 pidfile 写到 $(tilde "$LOG_DIR")/steve-acp-<port>.{log,pid}
  --foreground   前台运行（默认；systemd / launchd 用这个）
  --stop         按 pidfile 停掉 --daemon 起的实例（SIGTERM，steve 自己优雅关闭）
  --help, -h     这段说明 + 下面 steve-acp 的完整参数表

环境变量（默认值）
  STEVE_ACP_ENV_FILE=$(tilde "$ENV_FILE")
  STEVE_ACP_LOG_DIR=$(tilde "$LOG_DIR")
  ACP_TOKEN / ACP_HOST / ACP_PORT / ACP_PATH / ACP_SESSION_DIR
  ACP_PERMISSIONS / ACP_ALLOW_LOCAL_TOOLS / ACP_QUIET / ACP_CORS

其余参数原样透传给 steve-acp（后写的 flag 生效，可覆盖默认值）：
EOF
	"${CMD[@]}" --help
	exit 0
fi

# 与 src/model/config.ts 的 parseEnvFile() 保持同一套规则：逐行 key=value，
# 去首尾空白、跳过空行与 # 注释、成对引号只剥一层、不做插值、不支持 `export`。
# 同一文件里后出现的同名键覆盖先出现的。
read_env_value() {
	local file="$1" name="$2"
	[ -f "$file" ] || return 0
	awk -v wanted="$name" '
		{ sub(/\r$/, "") }
		{
			line = $0
			gsub(/^[ \t]+|[ \t]+$/, "", line)
			if (line == "" || substr(line, 1, 1) == "#") next
			sep = index(line, "=")
			if (sep == 0) next
			key = substr(line, 1, sep - 1)
			gsub(/^[ \t]+|[ \t]+$/, "", key)
			value = substr(line, sep + 1)
			gsub(/^[ \t]+|[ \t]+$/, "", value)
			if (length(value) >= 2) {
				first = substr(value, 1, 1)
				last = substr(value, length(value), 1)
				squote = sprintf("%c", 39)
				if ((first == "\"" && last == "\"") || (first == squote && last == squote)) {
					value = substr(value, 2, length(value) - 2)
				}
			}
			if (key != "") seen[key] = value
		}
		END { if (wanted in seen) print seen[wanted] }
	' "$file"
}

# 真实环境变量优先于文件，和 steve 加载 .env 的优先级一致。
TOKEN="${ACP_TOKEN:-}"
if [ -z "$TOKEN" ]; then
	TOKEN="$(read_env_value "$ENV_FILE" ACP_TOKEN)"
fi
if [ -z "$TOKEN" ]; then
	cat >&2 <<EOF
steve-acp-serve: $(tilde "$ENV_FILE") 里没有 ACP_TOKEN。

生成一个写进去（文件权限 600，避免被同机其它用户读走）：
  umask 077 && printf 'ACP_TOKEN=%s\n' "\$(openssl rand -hex 32)" >> "$(tilde "$ENV_FILE")"

或者临时用环境变量覆盖：
  ACP_TOKEN=\$(openssl rand -hex 32) bash $(tilde "$0")
EOF
	exit 1
fi
if [ "${#TOKEN}" -lt 24 ]; then
	printf 'steve-acp-serve: 警告：ACP_TOKEN 只有 %s 个字符，建议至少 32 字节随机值（openssl rand -hex 32）\n' "${#TOKEN}" >&2
fi

# `~` 不会被 shell 展开，这里自己展开（--session-dir 需要绝对路径）。
case "$SESSION_DIR" in
	"~") SESSION_DIR="$HOME" ;;
	"~/"*) SESSION_DIR="$HOME/${SESSION_DIR#\~/}" ;;
esac
mkdir -p "$SESSION_DIR" || die "无法创建 session 目录：$(tilde "$SESSION_DIR")"

ARGS=(
	--transport http
	--host "$HOST"
	--port "$PORT"
	--path "$ENDPOINT_PATH"
	--token "$TOKEN"
	--session-dir "$SESSION_DIR"
	--permissions "$PERMISSIONS"
)
if [ "$ALLOW_LOCAL_TOOLS" = "true" ]; then
	ARGS+=(--allow-local-tools)
fi
if [ "$QUIET" = "true" ]; then
	ARGS+=(--quiet)
fi
if [ -n "$CORS" ]; then
	ARGS+=(--cors "$CORS")
fi

# 透传参数里的 --host/--port/--path 会覆盖上面的值（steve-acp 后写的 flag 生效），
# 摘要跟着一起改，免得打印出来的地址和实际监听的不一致。
prev=""
for arg in ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}; do
	case "$prev" in
		--host) HOST="$arg" ;;
		--port) PORT="$arg" ;;
		--path) ENDPOINT_PATH="$arg" ;;
	esac
	case "$arg" in
		--host=*) HOST="${arg#--host=}" ;;
		--port=*) PORT="${arg#--port=}" ;;
		--path=*) ENDPOINT_PATH="${arg#--path=}" ;;
	esac
	prev="$arg"
done

# pidfile 与日志按端口区分，多实例互不覆盖。
PIDFILE="$LOG_DIR/steve-acp-$PORT.pid"
LOG_FILE="$LOG_DIR/steve-acp-$PORT.log"

if [ "$STOP" = "true" ]; then
	[ -f "$PIDFILE" ] || die "没有 pidfile（$(tilde "$PIDFILE")）：这个端口不是用 --daemon 起的，或者已经停了"
	pid="$(cat "$PIDFILE")"
	if kill -0 "$pid" 2>/dev/null; then
		kill "$pid" # SIGTERM：steve 自己会优雅关闭
		printf 'steve-acp-serve: 已发送 SIGTERM 给 pid %s（日志 %s）\n' "$pid" "$(tilde "$LOG_FILE")" >&2
	else
		printf 'steve-acp-serve: pid %s 已经不在了，清掉 pidfile\n' "$pid" >&2
	fi
	rm -f "$PIDFILE"
	exit 0
fi

# 端口占用是最常见的启动失败原因（上一次的实例还在跑），先给出人话提示。
if (exec 3<>"/dev/tcp/$HOST/$PORT") 2>/dev/null; then
	exec 3<&- 3>&-
	die "$HOST:$PORT 已被占用（可能上一次的实例还在跑）；换端口：ACP_PORT=... 或 $(tilde "$0") --port ..."
fi

print_summary() {
	printf 'steve-acp-serve: endpoint http://%s:%s%s\n' "$HOST" "$PORT" "$ENDPOINT_PATH"
	printf 'steve-acp-serve: 测试页   http://%s:%s/\n' "$HOST" "$PORT"
	printf 'steve-acp-serve: sessions %s · permissions %s · local-tools %s\n' \
		"$(tilde "$SESSION_DIR")" "$PERMISSIONS" "$ALLOW_LOCAL_TOOLS"
	printf 'steve-acp-serve: token    %s…（来自 %s）\n' "${TOKEN:0:6}" "$(tilde "$ENV_FILE")"
}

if [ "$DAEMON" = "true" ]; then
	mkdir -p "$LOG_DIR" || die "无法创建日志目录：$(tilde "$LOG_DIR")"
	{
		printf '\n=== %s 启动 %s:%s%s ===\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$HOST" "$PORT" "$ENDPOINT_PATH"
		print_summary
	} >>"$LOG_FILE"
	nohup "${CMD[@]}" "${ARGS[@]}" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"} >>"$LOG_FILE" 2>&1 &
	pid=$!
	printf '%s\n' "$pid" >"$PIDFILE"
	sleep 1
	if ! kill -0 "$pid" 2>/dev/null; then
		rm -f "$PIDFILE"
		printf 'steve-acp-serve: 启动后立刻退出了，日志末尾：\n' >&2
		tail -n 20 "$LOG_FILE" >&2
		exit 1
	fi
	print_summary >&2
	printf 'steve-acp-serve: 后台运行 pid=%s\n' "$pid" >&2
	printf 'steve-acp-serve: 日志 tail -f %s\n' "$(tilde "$LOG_FILE")" >&2
	if [ -x "$SOURCE" ]; then
		printf 'steve-acp-serve: 停止 %s --stop\n' "$(tilde "$0")" >&2
	else
		printf 'steve-acp-serve: 停止 bash %s --stop\n' "$(tilde "$0")" >&2
	fi
	exit 0
fi

print_summary >&2

# exec：Ctrl+C / SIGTERM 直接交给 steve-acp，它自己会优雅关闭。
exec "${CMD[@]}" "${ARGS[@]}" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
