#!/usr/bin/env bash
#
# 一键启动 steve 的 ACP HTTP 服务（远程 / 云端访问用）。
#
#   bash scripts/steve-acp-serve.sh                 # 默认 http://127.0.0.1:8891/acp，页面 http://127.0.0.1:8891/
#   bash scripts/steve-acp-serve.sh --port 9000     # 额外的参数原样透传给 steve-acp，且可覆盖本脚本的默认值
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
#   ACP_QUIET           true                false 则打开 steve 自己的日志
#   ACP_CORS            空                  只在「页面与端点不同源」时需要，如 "*"
#
# cwd 有意义：`.steve/mcp.json` 与 `.steve/extensions/` 都按启动目录发现，
# 所以想带哪个项目的 MCP / 插件，就在那个目录里启动本脚本。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

ENV_FILE="${STEVE_ACP_ENV_FILE:-$HOME/.steve/.env}"
HOST="${ACP_HOST:-127.0.0.1}"
PORT="${ACP_PORT:-8891}"
ENDPOINT_PATH="${ACP_PATH:-/acp}"
SESSION_DIR="${ACP_SESSION_DIR:-$HOME/.steve/sessions}"
PERMISSIONS="${ACP_PERMISSIONS:-ask}"
ALLOW_LOCAL_TOOLS="${ACP_ALLOW_LOCAL_TOOLS:-true}"
QUIET="${ACP_QUIET:-true}"
CORS="${ACP_CORS:-}"

die() {
	printf 'steve-acp-serve: %s\n' "$1" >&2
	exit 1
}

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
steve-acp-serve: $ENV_FILE 里没有 ACP_TOKEN。

生成一个写进去（文件权限 600，避免被同机其它用户读走）：
  umask 077 && printf 'ACP_TOKEN=%s\n' "\$(openssl rand -hex 32)" >> "$ENV_FILE"

或者临时用环境变量覆盖：
  ACP_TOKEN=\$(openssl rand -hex 32) bash $0
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
mkdir -p "$SESSION_DIR" || die "无法创建 session 目录：$SESSION_DIR"

# 优先用装到 PATH 上的命令；没装则退回仓库里的构建产物。
if command -v steve-acp >/dev/null 2>&1; then
	CMD=(steve-acp)
elif [ -f "$SCRIPT_DIR/../dist/protocols/acp/main.js" ]; then
	CMD=(node "$SCRIPT_DIR/../dist/protocols/acp/main.js")
else
	die "找不到 steve-acp：先 npm run build，或 npm pack && npm i -g ./steve-0.1.0.tgz"
fi

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
for arg in "$@"; do
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

# 端口占用是最常见的启动失败原因（上一次的实例还在跑），先给出人话提示。
if (exec 3<>"/dev/tcp/$HOST/$PORT") 2>/dev/null; then
	exec 3<&- 3>&-
	die "$HOST:$PORT 已被占用（可能上一次的实例还在跑）；换端口：ACP_PORT=... 或 $0 --port ..."
fi

printf 'steve-acp-serve: endpoint http://%s:%s%s\n' "$HOST" "$PORT" "$ENDPOINT_PATH" >&2

printf 'steve-acp-serve: 测试页   http://%s:%s/\n' "$HOST" "$PORT" >&2
printf 'steve-acp-serve: sessions %s · permissions %s · local-tools %s\n' \
	"$SESSION_DIR" "$PERMISSIONS" "$ALLOW_LOCAL_TOOLS" >&2
printf 'steve-acp-serve: token    %s…（来自 %s）\n' "${TOKEN:0:6}" "$ENV_FILE" >&2

# exec：Ctrl+C / SIGTERM 直接交给 steve-acp，它自己会优雅关闭。
exec "${CMD[@]}" "${ARGS[@]}" "$@"
