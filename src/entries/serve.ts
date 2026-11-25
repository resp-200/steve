#!/usr/bin/env node
/**
 * `steve-serve` (§5.7.3): one long-running process that owns streams, a run
 * worker, the watch triggers and an HTTP/SSE surface.
 *
 * A front end can create a stream, post input, watch the projected event flow and
 * answer approvals — without an editor attached. Everything it observes is the
 * same event vocabulary the CLI and ACP speak, so the views stay consistent.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { createApprovalGate } from "../features/approval.js";
import { assembleAgent } from "../features/agent-assembly.js";
import type { AgentTool } from "../features/contract.js";
import { DEFAULT_POLICIES, project, type Audience, type ProjectionHooks } from "../features/projection.js";
import { snapshotEnvironment } from "../features/environment.js";
import { createTriggerEngine, type TriggerEngine } from "../features/trigger.js";
import { createRunWorker, type RunWorker } from "../features/worker.js";
import { createStreamLog, isStreamId, type StreamLog } from "../features/stream-log.js";
import { modelInfo, workspacePolicy } from "../features/session-policy.js";
import { loadExtensions, type ExtensionHost } from "../extensions/host.js";
import { loadConfig } from "../model/config.js";
import { VERSION } from "../model/version.js";
import { startHttpServer, type HttpExchange, type HttpRoute } from "../protocols/http/events.js";
import type { WorkspaceAccess } from "../types.js";

const HELP = `steve-serve ${VERSION} — 长驻进程：流 + 执行器 + Watch + HTTP/SSE

用法：steve-serve [选项]

选项：
  --port <n>           监听端口（默认 8892）
  --host <addr>        监听地址（默认 127.0.0.1；非回环地址必须给 --token）
  --token <secret>     请求令牌（Authorization: Bearer <token>）
  --audience <user|full>  SSE 投影档位（默认 user）
  --access <none|read|write|exec>  工具可用的本地能力（默认 exec）
  --streams-dir <path> 事件日志目录（默认 <cwd>/.steve/streams）
  --no-watch           不启动 .steve/watch.json 触发器
  --help               显示本帮助
  --version            显示版本

HTTP API：
  GET  /health
  GET  /streams
  POST /streams                     {cwd?, title?}
  GET  /streams/:id/events?from=N   SSE（投影后事件）
  POST /streams/:id/messages        {text, images?} -> {runId}
  POST /streams/:id/cancel          {runId?}
  POST /streams/:id/approvals       {requestId, decision}
  POST /hooks/:name                 Watch webhook
`;

interface ServeOptions {
	host: string;
	port: number;
	token?: string;
	audience: Audience;
	access: WorkspaceAccess;
	streamsDir?: string;
	watch: boolean;
}

function valueFor(argv: readonly string[], index: number, flag: string): string {
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
	return value;
}

function parseArgv(argv: readonly string[]): ServeOptions | "help" | "version" {
	const options: ServeOptions = { host: "127.0.0.1", port: 8892, audience: "user", access: "exec", watch: true };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		switch (arg) {
			case "--help":
				return "help";
			case "--version":
				return "version";
			case "--no-watch":
				options.watch = false;
				break;
			case "--port": {
				const value = Number(valueFor(argv, index, arg));
				if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error("--port must be an integer between 0 and 65535");
				options.port = value;
				index += 1;
				break;
			}
			case "--host":
				options.host = valueFor(argv, index, arg);
				index += 1;
				break;
			case "--token":
				options.token = valueFor(argv, index, arg);
				index += 1;
				break;
			case "--streams-dir":
				options.streamsDir = valueFor(argv, index, arg);
				index += 1;
				break;
			case "--audience": {
				const value = valueFor(argv, index, arg);
				if (value !== "user" && value !== "full") throw new Error(`--audience must be user or full (got "${value}")`);
				options.audience = value;
				index += 1;
				break;
			}
			case "--access": {
				const value = valueFor(argv, index, arg);
				if (value !== "none" && value !== "read" && value !== "write" && value !== "exec") throw new Error(`--access must be none, read, write or exec (got "${value}")`);
				options.access = value;
				index += 1;
				break;
			}
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}
	return options;
}

const readJson = (exchange: HttpExchange): Record<string, unknown> => {
	if (exchange.request.body.trim() === "") return {};
	try {
		const parsed: unknown = JSON.parse(exchange.request.body);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("body must be a JSON object");
		return parsed as Record<string, unknown>;
	} catch (error) {
		throw new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
	}
};

const isLoopback = (host: string): boolean => host === "127.0.0.1" || host === "::1" || host === "localhost";

async function main(): Promise<void> {
	let parsed: ServeOptions | "help" | "version";
	try {
		parsed = parseArgv(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`steve-serve: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(2);
	}
	if (parsed === "help") {
		process.stdout.write(HELP);
		return;
	}
	if (parsed === "version") {
		process.stdout.write(`${VERSION}\n`);
		return;
	}

	const log = (message: string): void => {
		process.stderr.write(`[serve] ${message}\n`);
	};
	const configuredToken = parsed.token ?? process.env.STEVE_SERVE_TOKEN;
	const token = configuredToken === undefined || configuredToken === "" ? undefined : configuredToken;
	if (!isLoopback(parsed.host) && token === undefined) {
		process.stderr.write("steve-serve: --host outside loopback requires --token (or STEVE_SERVE_TOKEN)\n");
		process.exit(2);
	}

	const cwd = process.cwd();
	const config = loadConfig();
	const streamsDir = parsed.streamsDir !== undefined ? resolve(parsed.streamsDir) : join(cwd, ".steve", "streams");
	mkdirSync(streamsDir, { recursive: true });

	const workspace = workspacePolicy({ cwd, access: parsed.access });
	const extensions = await loadExtensions({ cwd, mode: "cli", workspace, model: modelInfo(config), log });
	const assembly = assembleAgent({
		config,
		tools: extensions.tools.map((tool) => ({
			...tool,
			label: tool.label ?? tool.name,
			parameters: tool.parameters as AgentTool<any>["parameters"],
		})),
		extensions,
		logger: log,
		permissions: { mode: "ask", ask: async () => "cancel" as const },
	});
	const projection = DEFAULT_POLICIES[parsed.audience];
	const projectionHooks: ProjectionHooks = {
		kindFor: (name) => assembly.registry.kindFor(name),
		titleFor: (name, args) => assembly.registry.titleFor(name, args),
	};

	const environmentFor = (mode: "foreground" | "background") => {
		const requires = new Set(assembly.registry.permissionRequired());
		return snapshotEnvironment({
			cwd,
			workspace,
			model: modelInfo(config),
			tools: assembly.tools.map((tool) => ({
				name: tool.name,
				permissionRequired: requires.has(tool.name),
				...(assembly.registry.kindFor(tool.name) !== undefined ? { kind: assembly.registry.kindFor(tool.name) as string } : {}),
			})),
			permissionMode: "ask",
			plugins: extensions.files,
			projection,
			mode,
		});
	};

	const log2 = createStreamLog({ dir: streamsDir, logger: log });
	const worker: RunWorker = createRunWorker({
		config,
		extensions,
		log: log2,
		resolveEnvironment: async (_streamId, mode) => environmentFor(mode),
		tools: () => assembly.tools,
		hooks: assembly.hooks,
		logger: log,
		concurrency: "serial",
		approvals: async (context, request) => {
			const gate = createApprovalGate({ log: log2, streamId: context.streamId, runId: context.runId, logger: log });
			try {
				const outcome = await gate.ask({ toolName: request.toolName, args: request.args });
				if (outcome.decision === "timeout") return "timeout";
				return outcome.allowed ? "allow" : "deny";
			} finally {
				gate.dispose();
			}
		},
	});

	// Watch triggers fire `user.message` events; the worker is pulled in by them.
	const claims = new Set<number>();
	const triggerUnsubscribes: (() => void)[] = [];
	let engine: TriggerEngine | undefined;
	if (parsed.watch) {
		const webhookNeedsSecret = !isLoopback(parsed.host);
		engine = createTriggerEngine({ log: log2, cwd, roots: workspace.roots, logger: log });
		for (const registration of extensions.triggers) {
			if (webhookNeedsSecret && registration.spec.kind === "webhook" && registration.spec.secret === undefined) {
				process.stderr.write(`steve-serve: trigger "${registration.name}" needs a secret when listening outside loopback\n`);
				process.exit(2);
			}
			try {
				engine.register(registration);
			} catch (error) {
				log(`skipping trigger "${registration.name}": ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const subscribeTarget = (streamId: string, mode: "foreground" | "background"): void => {
			const last = log2.listStreams !== undefined ? undefined : undefined;
			void last;
			void log2.read(streamId).then((events) => {
				const from = (events.at(-1)?.seq ?? 0) + 1;
				const unsubscribe = log2.subscribe(streamId, from, (event) => {
					if (event.type !== "user.message") return;
					if (!String(event.text).startsWith("[watch:")) return;
					if (claims.has(event.seq)) return;
					claims.add(event.seq);
					void worker.submit(streamId, { text: event.text, append: false }, mode);
				});
				triggerUnsubscribes.push(unsubscribe);
			});
		};
		for (const registration of extensions.triggers) {
			if (typeof registration.targetStream === "string") subscribeTarget(registration.targetStream, registration.mode);
		}
		// Give the subscriptions a tick to attach before the first fires can happen.
		await new Promise((resolveTick) => setTimeout(resolveTick, 0));
		await engine.start();
	}

	const routes: HttpRoute[] = [
		{
			method: "GET",
			path: "/health",
			handle: (exchange) => {
				exchange.json(200, { ok: true, version: VERSION, uptime: Math.round(process.uptime()) });
			},
		},
		{
			method: "GET",
			path: "/streams",
			handle: async (exchange) => {
				exchange.json(200, { streams: await log2.listStreams() });
			},
		},
		{
			method: "POST",
			path: "/streams",
			handle: async (exchange) => {
				const body = readJson(exchange);
				const streamCwd = typeof body.cwd === "string" ? body.cwd : cwd;
				const streamId = randomUUID().replace(/-/g, "").slice(0, 12);
				await log2.append(streamId, [
					{ type: "stream.created", streamId, cwd: streamCwd, ...(typeof body.title === "string" ? { title: body.title } : {}) },
				]);
				exchange.json(201, { streamId, cwd: streamCwd, ...(typeof body.title === "string" ? { title: body.title } : {}) });
			},
		},
		{
			method: "GET",
			path: "/streams/:id/events",
			handle: async (exchange) => {
				const streamId = exchange.params.id as string;
				if (!isStreamId(streamId)) {
					exchange.json(400, { error: "invalid stream id" });
					return;
				}
				const existing = await log2.read(streamId);
				if (existing.length === 0) {
					exchange.json(404, { error: "unknown stream" });
					return;
				}
				const from = Number(exchange.request.query.get("from") ?? "1");
				const start = Number.isFinite(from) && from >= 1 ? Math.floor(from) : 1;
				const sink = exchange.sse();
				const forward = (event: unknown): void => {
					for (const projected of project(event as never, projection, projectionHooks)) {
						if (projected.audience === "user" || projected.audience === "full") sink.send({ seq: (event as { seq?: number }).seq, project: projected.audience, event: projected.event });
					}
				};
				for (const event of existing.filter((item) => item.seq >= start)) forward(event);
				const fromSeq = (existing.at(-1)?.seq ?? 0) + 1;
				const unsubscribe = log2.subscribe(streamId, fromSeq, forward);
				sink.onClose(unsubscribe);
			},
		},
		{
			method: "POST",
			path: "/streams/:id/messages",
			handle: async (exchange) => {
				const streamId = exchange.params.id as string;
				if (!isStreamId(streamId)) {
					exchange.json(400, { error: "invalid stream id" });
					return;
				}
				const body = readJson(exchange);
				if (typeof body.text !== "string" || body.text.trim() === "") {
					exchange.json(400, { error: "text must be a non-empty string" });
					return;
				}
				const images = Array.isArray(body.images) ? (body.images as { mimeType: string; data: string }[]) : undefined;
				const submitted = await worker.submit(streamId, { text: body.text, ...(images !== undefined ? { images } : {}) }, "foreground");
				if (!submitted.accepted) {
					exchange.json(400, { error: submitted.reason ?? "not accepted" });
					return;
				}
				exchange.json(202, { runId: submitted.runId, ...(submitted.reason !== undefined ? { reason: submitted.reason } : {}) });
			},
		},
		{
			method: "POST",
			path: "/streams/:id/cancel",
			handle: async (exchange) => {
				const streamId = exchange.params.id as string;
				if (!isStreamId(streamId)) {
					exchange.json(400, { error: "invalid stream id" });
					return;
				}
				const body = readJson(exchange);
				const runId = typeof body.runId === "string" ? body.runId : worker.active().find((run) => run.streamId === streamId)?.runId;
				if (runId === undefined) {
					exchange.json(404, { error: "no active run" });
					return;
				}
				const known = await worker.cancel(streamId, runId);
				if (!known) {
					exchange.json(404, { error: "no active run" });
					return;
				}
				exchange.json(202, { cancelled: true, runId });
			},
		},
		{
			method: "POST",
			path: "/streams/:id/approvals",
			handle: async (exchange) => {
				const streamId = exchange.params.id as string;
				if (!isStreamId(streamId)) {
					exchange.json(400, { error: "invalid stream id" });
					return;
				}
				const body = readJson(exchange);
				if (typeof body.requestId !== "string") {
					exchange.json(400, { error: "requestId is required" });
					return;
				}
				const decision = body.decision === "allow_always" || body.decision === "allow_once" || body.decision === "deny" ? body.decision : "deny";
				await log2.append(streamId, [{ type: "approval.granted", requestId: body.requestId, toolName: typeof body.toolName === "string" ? body.toolName : "unknown", decision }]);
				exchange.json(202, { granted: decision !== "deny", decision });
			},
		},
		{
			method: "POST",
			path: "/hooks/:name",
			handle: async (exchange) => {
				if (engine === undefined) {
					exchange.json(404, { error: "watch disabled" });
					return;
				}
				const path = `/hooks/${exchange.params.name as string}`;
				const headers: Record<string, string | undefined> = {};
				for (const [key, value] of Object.entries(exchange.request.headers)) {
					if (typeof value === "string") headers[key.toLowerCase()] = value;
				}
				const accepted = await engine.handleWebhook(path, exchange.request.body, headers);
				if (!accepted) {
					exchange.json(404, { error: "no trigger accepted this hook" });
					return;
				}
				exchange.json(202, { accepted: true });
			},
		},
	];

	const server = await startHttpServer({ host: parsed.host, port: parsed.port, ...(token !== undefined ? { token } : {}), logger: log, routes });
	log(`listening on http://${server.host}:${server.port} (streams: ${streamsDir}, watch: ${parsed.watch ? "on" : "off"})`);

	let closing = false;
	const shutdown = async (reason: string): Promise<void> => {
		if (closing) return;
		closing = true;
		log(`shutting down (${reason})`);
		await engine?.stop();
		for (const unsubscribe of triggerUnsubscribes.splice(0)) unsubscribe();
		await worker.drain();
		await server.close();
		log2.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
	process.stderr.write(`steve-serve: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exit(1);
});
