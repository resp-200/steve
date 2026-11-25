/**
 * Admin console backend: the `/admin` page and the JSON API behind it.
 *
 * It is deliberately a thin host-level surface: providers and logging live in
 * `.steve/admin.json`, the Feishu gateway in `.steve/.env`, schedules in
 * `.steve/watch.json` — the same files a hand edit would change. Nothing here
 * re-implements stream, run or trigger semantics; the console drives the same
 * worker and log the HTTP API already uses.
 *
 * Everything except the page itself sits behind the server's bearer token. The
 * page has to be reachable by a plain browser navigation (which cannot send an
 * Authorization header), so it is exempt and stores the token in localStorage.
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import {
	activeProvider,
	adminConfigPath,
	describe,
	coerceHeaderFields,
	envFilePath,
	normalizeProviderInput,
	providerView,
	readAdminConfig,
	updateEnvFile,
	writeAdminConfig,
	type AdminConfig,
	type ProviderEntry,
} from "../features/admin-config.js";
import { isLogLevel, type LeveledLogger } from "../features/logging.js";
import { isSessionId } from "../features/session-store.js";
import type { StreamLog } from "../features/stream-log.js";
import { isValidTimezone, parseCron } from "../features/trigger-schedule.js";
import type { RunWorker } from "../features/worker.js";
import { resolveApi } from "../model/config.js";
import { applyHeaders, hostOf, providerHeaders } from "../model/request-headers.js";
import { VERSION } from "../model/version.js";
import type { HttpExchange, HttpRoute } from "../protocols/http/events.js";

export interface AdminDeps {
	cwd: string;
	adminPage: string;
	startedAt: number;
	streamsDir: string;
	watchEnabled: boolean;
	log: StreamLog;
	worker: RunWorker;
	logger: LeveledLogger;
	/** Called after the response for POST /admin/api/system/restart has flushed. */
	restart: () => void;
	/** Live Feishu transport state supplied by the server entry. */
	feishuStatus?: () => {
		mode?: "ws" | "http" | "off";
		configured?: boolean;
		connected?: boolean;
		attempts?: number;
		fatal?: boolean;
		lastError?: string;
	};
}

export const ADMIN_PAGE_PATHS = ["/admin", "/admin/"] as const;
export const ADMIN_API = "/admin/api";
export const WATCH_FILE = ".steve/watch.json";
export const FEISHU_API_BASE_DEFAULT = "https://open.feishu.cn";

/** Raw configuration files the console may display. */
const RAW_FILES = [".steve/.env", ".steve/admin.json", ".steve/watch.json", ".steve/mcp.json"] as const;

/** Keys whose values are always masked in the file viewer. */
const SECRET_ENV_KEYS = new Set([
	"LLM_API_KEY",
	"FEISHU_APP_SECRET",
	"FEISHU_VERIFICATION_TOKEN",
	"FEISHU_ENCRYPT_KEY",
	"AMAP_MAPS_API_KEY",
]);

const SCHEDULE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export interface ScheduleEntry {
	name: string;
	cron: string;
	timezone?: string;
	prompt: string;
	targetStream: string;
	mode: "foreground" | "background";
}

function fail(exchange: HttpExchange, status: number, message: string): void {
	exchange.json(status, { error: message });
}

function parseBody(exchange: HttpExchange): Record<string, unknown> {
	if (exchange.request.body.trim() === "") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(exchange.request.body);
	} catch (error) {
		throw new Error(`invalid JSON body: ${describe(error)}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be a JSON object");
	return parsed as Record<string, unknown>;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

const watchFilePath = (cwd: string): string => join(cwd, WATCH_FILE);

async function readWatchFile(cwd: string, logger: LeveledLogger): Promise<Record<string, unknown>> {
	try {
		const text = await readFile(watchFilePath(cwd), "utf8");
		const parsed: unknown = JSON.parse(text);
		return asObject(parsed) ?? {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") logger.warn(`[admin] could not read ${WATCH_FILE}: ${describe(error)}`);
		return {};
	}
}

async function writeWatchFile(cwd: string, value: Record<string, unknown>): Promise<void> {
	const file = watchFilePath(cwd);
	await mkdir(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(temporary, file);
}

function scheduleFromTrigger(name: string, raw: unknown): ScheduleEntry | undefined {
	const entry = asObject(raw);
	if (entry === undefined || entry.kind !== "cron") return undefined;
	const cron = asString(entry.cron);
	const prompt = typeof entry.prompt === "string" ? entry.prompt : "";
	const targetStream = asString(entry.targetStream);
	if (cron === "" || prompt === "" || targetStream === "") return undefined;
	const timezone = asString(entry.timezone);
	return {
		name,
		cron,
		...(timezone !== "" ? { timezone } : {}),
		prompt,
		targetStream,
		mode: entry.mode === "foreground" ? "foreground" : "background",
	};
}

function schedulesFromWatch(watch: Record<string, unknown>): ScheduleEntry[] {
	const triggers = asObject(watch.triggers);
	if (triggers === undefined) return [];
	const schedules: ScheduleEntry[] = [];
	for (const [name, value] of Object.entries(triggers)) {
		const schedule = scheduleFromTrigger(name, value);
		if (schedule !== undefined) schedules.push(schedule);
	}
	return schedules.sort((left, right) => left.name.localeCompare(right.name));
}

function text(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function maskEnv(content: string): string {
	return content
		.split(/\r?\n/)
		.map((line) => {
			const match = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/.exec(line);
			if (match === null) return line;
			const key = match[2] as string;
			if (!SECRET_ENV_KEYS.has(key)) return line;
			const value = (match[4] as string).trim().replace(/^["']|["']$/g, "");
			return `${match[1]}${key}${match[3]}${maskSecretValue(value)}`;
		})
		.join("\n");
}

function maskSecretValue(value: string): string {
	if (value === "") return "";
	return value.length <= 4 ? "****" : `****${value.slice(-4)}`;
}

function maskJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(maskJson);
	const object = asObject(value);
	if (object === undefined) return value;
	const masked: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(object)) {
		if (typeof item === "string" && /apikey|secret|token|encryptkey/i.test(key)) masked[key] = maskSecretValue(item);
		else masked[key] = maskJson(item);
	}
	return masked;
}

function maskFileContent(path: string, content: string): string {
	if (path.endsWith(".env")) return maskEnv(content);
	if (path.endsWith(".json")) {
		try {
			return `${JSON.stringify(maskJson(JSON.parse(content)), null, 2)}\n`;
		} catch {
			return content;
		}
	}
	return content;
}

function feishuMode(): "ws" | "http" {
	return process.env.FEISHU_MODE?.trim().toLowerCase() === "http" ? "http" : "ws";
}

/**
 * Keep the running process' view in sync with what was just written to
 * `.steve/.env`, so the console echoes saved values before a restart.
 * (Changes still need a restart to affect the live bot/connection.)
 */
function applyEnvUpdates(updates: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(updates)) {
		if (value === undefined || value === "") delete process.env[key];
		else process.env[key] = value;
	}
}

function feishuState(): { mode: "ws" | "http"; configured: boolean; appId: string; appSecret: string; verificationToken: string; encryptKey: string; apiBase: string } {
	const mode = feishuMode();
	const appId = process.env.FEISHU_APP_ID?.trim() ?? "";
	const appSecret = process.env.FEISHU_APP_SECRET?.trim() ?? "";
	const verificationToken = process.env.FEISHU_VERIFICATION_TOKEN?.trim() ?? "";
	const encryptKey = process.env.FEISHU_ENCRYPT_KEY?.trim() ?? "";
	const apiBase = process.env.FEISHU_API_BASE?.trim() || FEISHU_API_BASE_DEFAULT;
	const configured = appId !== "" && appSecret !== "" && (mode === "ws" || verificationToken !== "");
	return { mode, configured, appId, appSecret, verificationToken, encryptKey, apiBase };
}

/** Standard OpenAI-compatible listing path; tolerate a base that already has /v1. */
/**
 * The request headers a provider would send, as the save response reports them.
 * `sample-session` stands in for the conversation id so the console can show the
 * expansion; it is never sent to the provider from here.
 */
function sentHeadersFor(provider: ProviderEntry): Record<string, string> {
	const headers = providerHeaders(provider, hostOf(provider.baseUrl), { sessionId: "sample-session" });
	// The console's explicit opt-out also applies to the preview, or the preview
	// would show a header the request then does not send.
	if (provider.requestSessionHeader === false) delete headers["x-opencode-session"];
	return headers;
}

function modelsEndpoint(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	return /\/v\d+$/.test(trimmed) ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

interface ModelCandidate {
	id: string;
	ownedBy?: string;
	type?: string;
	contextWindow?: number;
	maxTokens?: number;
}

function positiveNumber(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
}

/** Pull the model id plus the spec fields providers commonly publish on /v1/models. */
function extractModels(payload: unknown): ModelCandidate[] {
	const record = asObject(payload);
	const list = Array.isArray(record?.data) ? record.data : Array.isArray(record?.models) ? record.models : [];
	const byId = new Map<string, ModelCandidate>();
	for (const item of list) {
		if (typeof item === "string") {
			if (item !== "" && !byId.has(item)) byId.set(item, { id: item });
			continue;
		}
		const model = asObject(item);
		if (model === undefined) continue;
		const id = asString(model.id);
		if (id === "" || byId.has(id)) continue;
		const ownedBy = asString(model.owned_by) || asString(model.ownedBy) || asString(model.provider) || asString(model.organization);
		const type = asString(model.type) || asString(model.object);
		const contextWindow =
			positiveNumber(model.context_window) ??
			positiveNumber(model.context_length) ??
			positiveNumber(model.max_context_length) ??
			positiveNumber(model.max_input_tokens) ??
			positiveNumber(model.input_token_limit);
		const maxTokens =
			positiveNumber(model.max_tokens) ?? positiveNumber(model.max_output_tokens) ?? positiveNumber(model.output_token_limit);
		byId.set(id, {
			id,
			...(ownedBy !== "" ? { ownedBy } : {}),
			...(type !== "" ? { type } : {}),
			...(contextWindow !== undefined ? { contextWindow } : {}),
			...(maxTokens !== undefined ? { maxTokens } : {}),
		});
	}
	return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function createAdminRoutes(deps: AdminDeps): HttpRoute[] {
	const { cwd, logger } = deps;

	const readConfig = (): Promise<AdminConfig> => readAdminConfig(cwd, (message) => logger.warn(message));

	return [
		{
			method: "GET",
			path: "/admin",
			handle: (exchange) => {
				exchange.text(200, deps.adminPage, "text/html; charset=utf-8");
			},
		},
		{
			method: "GET",
			path: "/admin/",
			handle: (exchange) => {
				exchange.text(200, deps.adminPage, "text/html; charset=utf-8");
			},
		},
		{
			method: "GET",
			path: `${ADMIN_API}/overview`,
			handle: async (exchange) => {
				const config = await readConfig();
				const provider = activeProvider(config);
				const feishu = feishuState();
				const streams = await deps.log.listStreams();
				exchange.json(200, {
					version: VERSION,
					node: process.version,
					uptimeMs: Math.round(process.uptime() * 1_000),
					startedAt: deps.startedAt,
					pid: process.pid,
					cwd,
					streamsDir: deps.streamsDir,
					watchEnabled: deps.watchEnabled,
					feishu: { configured: feishu.configured, apiBase: feishu.apiBase },
					activeProvider: provider?.name ?? null,
					providerCount: config.providers.length,
					logLevel: config.logLevel,
					logDir: config.logDir ?? deps.logger.dir ?? "",
					persona: config.persona ?? "",
					streams: streams.length,
				});
			},
		},
		{
			method: "GET",
			path: `${ADMIN_API}/providers`,
			handle: async (exchange) => {
				const config = await readConfig();
				exchange.json(200, {
					providers: config.providers.map((provider) => providerView(provider, config.activeProviderId)),
					activeProviderId: config.activeProviderId ?? null,
				});
			},
		},
		{
			method: "POST",
			path: `${ADMIN_API}/providers/models`,
			handle: async (exchange) => {
				let body: Record<string, unknown>;
				try {
					body = parseBody(exchange);
				} catch (error) {
					fail(exchange, 400, describe(error));
					return;
				}
				const config = await readConfig();
				const id = asString(body.id);
				const known = id !== "" ? config.providers.find((provider) => provider.id === id) : undefined;
				if (id !== "" && known === undefined) {
					fail(exchange, 404, `unknown provider "${id}"`);
					return;
				}
				const baseUrl = asString(body.baseUrl) || known?.baseUrl || "";
				if (!/^https?:\/\//i.test(baseUrl)) {
					fail(exchange, 400, "baseUrl must be an http(s) URL");
					return;
				}
				// Editing an existing provider: a blank key means "use the stored one".
				const apiKey = asString(body.apiKey) || known?.apiKey || "";
				if (apiKey === "") {
					fail(exchange, 400, "API key is required to list models");
					return;
				}
				const url = modelsEndpoint(baseUrl);
				const api = resolveApi(baseUrl);
				const headers: Record<string, string> =
					api === "anthropic-messages"
						? { "x-api-key": apiKey, "anthropic-version": "2023-06-01", accept: "application/json" }
						: { authorization: `Bearer ${apiKey}`, accept: "application/json" };
				// The provider's own request headers apply here too: a gateway that needs
				// x-opencode-session for routing rejects the key with a 400 otherwise,
				// and this listing would report "provider returned HTTP 400" forever.
				// The edit form's unsaved values win over the stored entry, so adding a
				// header to fix a 400 gateway works before the first save.
				const edited = body.headers === undefined && body.hosts === undefined ? undefined : coerceHeaderFields(body);
				const headerSource = known === undefined ? undefined : { ...known, ...(edited ?? { headers: known.headers ?? {} }) };
				if (headerSource !== undefined) {
					applyHeaders(headers, sentHeadersFor(headerSource));
				}
				let response: Response;
				try {
					response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
				} catch (error) {
					fail(exchange, 502, `could not reach ${url}: ${describe(error)}`);
					return;
				}
				const text = await response.text();
				if (!response.ok) {
					fail(exchange, 502, `provider returned HTTP ${response.status}: ${text.slice(0, 200).trim()}`);
					return;
				}
				let payload: unknown;
				try {
					payload = JSON.parse(text);
				} catch {
					fail(exchange, 502, "provider did not return JSON; /v1/models may be unsupported");
					return;
				}
				const items = extractModels(payload);
				if (items.length === 0) {
					fail(exchange, 502, "no models found; the provider may not support /v1/models");
					return;
				}
				const models = items.map((model) => model.id);
				exchange.json(200, { ok: true, models, items, count: models.length, url });
			},
		},
		{
			method: "POST",
			path: `${ADMIN_API}/providers/save`,
			handle: async (exchange) => {
				let body: Record<string, unknown>;
				let config: AdminConfig;
				try {
					body = parseBody(exchange);
					config = await readConfig();
				} catch (error) {
					fail(exchange, 400, describe(error));
					return;
				}
				const raw = asObject(body.provider);
				if (raw === undefined) {
					fail(exchange, 400, "provider must be an object");
					return;
				}
				const incomingId = asString(raw.id);
				const existing: ProviderEntry | undefined = incomingId === "" ? undefined : config.providers.find((provider) => provider.id === incomingId);
				if (incomingId !== "" && existing === undefined) {
					fail(exchange, 404, `unknown provider "${incomingId}"`);
					return;
				}
				let provider: ProviderEntry;
				try {
					provider = normalizeProviderInput(raw, existing);
				} catch (error) {
					fail(exchange, 400, describe(error));
					return;
				}
				const providers = existing === undefined ? [...config.providers, provider] : config.providers.map((item) => (item.id === existing.id ? provider : item));
				const next: AdminConfig = { ...config, providers };
				await writeAdminConfig(cwd, next);
				logger.info(`[admin] saved provider "${provider.name}" (${provider.id})`);
				exchange.json(200, {
					ok: true,
					provider: providerView(provider, config.activeProviderId),
					// What would actually be sent: placeholders expanded with a sample id,
					// so "did my ${sessionId} survive the save" is answered on the spot.
					sentHeaders: sentHeadersFor(provider),
					restartRequired: true,
				});
			},
		},
		{
			method: "POST",
			path: `${ADMIN_API}/providers/delete`,
			handle: async (exchange) => {
				let body: Record<string, unknown>;
				let config: AdminConfig;
				try {
					body = parseBody(exchange);
					config = await readConfig();
				} catch (error) {
					fail(exchange, 400, describe(error));
					return;
				}
				const id = asString(body.id);
				if (id === "") {
					fail(exchange, 400, "id is required");
					return;
				}
				if (!config.providers.some((provider) => provider.id === id)) {
					fail(exchange, 404, `unknown provider "${id}"`);
					return;
				}
				const providers = config.providers.filter((provider) => provider.id !== id);
				const next: AdminConfig = {
					providers,
					logLevel: config.logLevel,
					...(config.logDir !== undefined ? { logDir: config.logDir } : {}),
					...(config.persona !== undefined ? { persona: config.persona } : {}),
					...(config.activeProviderId !== undefined && config.activeProviderId !== id ? { activeProviderId: config.activeProviderId } : {}),
				};
				await writeAdminConfig(cwd, next);
				logger.info(`[admin] deleted provider ${id}`);
				exchange.json(200, { ok: true, restartRequired: true });
			},
		},
		{
			method: "POST",
			path: `${ADMIN_API}/providers/activate`,
			handle: async (exchange) => {
				let body: Record<string, unknown>;
				let config: AdminConfig;
				try {
					body = parseBody(exchange);
					config = await readConfig();
				} catch (error) {
					fail(exchange, 400, describe(error));
					return;
				}
				const id = asString(body.id);
				if (!config.providers.some((provider) => provider.id === id)) {
					fail(exchange, 404, `unknown provider "${id}"`);
					return;
				}
				await writeAdminConfig(cwd, { ...config, activeProviderId: id });
				logger.info(`[admin] activated provider ${id}`);
				exchange.json(200, { ok: true, activeProviderId: id, restartRequired: true });
			},
		},
		{
			method: "GET",
			path: `${ADMIN_API}/gateways`,
			handle: (exchange) => {
				const feishu = feishuState();
				const live = deps.feishuStatus?.() ?? {};
				exchange.json(200, {
					feishu: {
						mode: feishu.mode,
						configured: feishu.configured,
						verificationTokenRequired: feishu.mode === "http",
						appIdMasked: maskSecretValue(feishu.appId),
						hasSecret: feishu.appSecret !== "",
						hasVerificationToken: feishu.verificationToken !== "",
						hasEncryptKey: feishu.encryptKey !== "",
						apiBase: feishu.apiBase,
						connection: {
							mode: live.mode ?? feishu.mode,
							connected: live.connected ?? false,
							attempts: live.attempts ?? 0,
							fatal: live.fatal ?? false,
							...(live.lastError !== undefined ? { lastError: live.lastError } : {}),
						},
					},
					available: ["feishu"],
					planned: ["wecom", "qq"],
				});
			},
		},
		{
			method: "POST",
			path: `${ADMIN_API}/gateways/save`,
			handle: async (exchange) => {
				let body: Record<string, unknown>;
				try {
					body = parseBody(exchange);
				} catch (error) {
					fail(exchange, 400, describe(error));
					return;
				}
				const feishu = asObject(body.feishu);
				if (feishu === undefined && body.clear !== true) {
					fail(exchange, 400, "feishu must be an object");
					return;
				}
				const updates: Record<string, string | undefined> = {};
				if (body.clear === true) {
					updates.FEISHU_APP_ID = "";
					updates.FEISHU_APP_SECRET = "";
					updates.FEISHU_VERIFICATION_TOKEN = "";
					updates.FEISHU_ENCRYPT_KEY = "";
					updates.FEISHU_API_BASE = "";
					updates.FEISHU_MODE = "";
				} else if (feishu !== undefined) {
					let nextMode: "ws" | "http" = feishuMode();
					if (feishu.mode !== undefined) {
						const mode = asString(feishu.mode).toLowerCase();
						if (mode !== "ws" && mode !== "http") {
							fail(exchange, 400, 'feishu.mode must be "ws" or "http"');
							return;
						}
						nextMode = mode;
						updates.FEISHU_MODE = mode;
					}
					const mapping: [string, unknown][] = [
						["FEISHU_APP_ID", feishu.appId],
						["FEISHU_APP_SECRET", feishu.appSecret],
						["FEISHU_VERIFICATION_TOKEN", feishu.verificationToken],
						["FEISHU_ENCRYPT_KEY", feishu.encryptKey],
						["FEISHU_API_BASE", feishu.apiBase],
					];
					for (const [key, raw] of mapping) {
						if (raw === undefined) continue;
						const value = asString(raw);
						if (value !== "") updates[key] = value;
					}
					if (nextMode === "http") {
						const token = updates.FEISHU_VERIFICATION_TOKEN ?? process.env.FEISHU_VERIFICATION_TOKEN?.trim() ?? "";
						if (token === "") {
							fail(exchange, 400, "http callback mode needs a verification token");
							return;
						}
					}
				}
				if (Object.keys(updates).length === 0) {
					fail(exchange, 400, "nothing to update; leave a field blank to keep it");
					return;
				}
				try {
					await updateEnvFile(cwd, updates);
				} catch (error) {
					fail(exchange, 500, `could not write ${envFilePath(cwd)}: ${describe(error)}`);
					return;
				}
				applyEnvUpdates(updates);
				logger.info(`[admin] updated Feishu gateway settings in .steve/.env`);
				exchange.json(200, { ok: true, restartRequired: true });
			},
		},
		{
			method: "GET",
			path: `${ADMIN_API}/schedules`,
			handle: async (exchange) => {
				const watch = await readWatchFile(cwd, logger);
				exchange.json(200, { schedules: schedulesFromWatch(watch), watchFile: WATCH_FILE });
			},
		},
		{
			method: "POST",
			path: `${ADMIN_API}/schedules/save`,
			handle: async (exchange) => {
				let body: Record<string, unknown>;
				try {
					body = parseBody(exchange);
				} catch (error) {
					fail(exchange, 400, describe(error));
					return;
				}
				const name = asString(body.name);
				if (!SCHEDULE_NAME.test(name)) {
					fail(exchange, 400, "name must be 1-64 letters, digits, underscores or dashes");
					return;
				}
				const cron = asString(body.cron);
				if (cron === "") {
					fail(exchange, 400, "cron is required (5 fields: minute hour day-of-month month day-of-week)");
					return;
				}
				try {
					parseCron(cron);
				} catch (error) {
					fail(exchange, 400, `invalid cron: ${describe(error)}`);
					return;
				}
				const timezone = asString(body.timezone);
				if (timezone !== "" && !isValidTimezone(timezone)) {
					fail(exchange, 400, `unknown timezone "${timezone}"`);
					return;
				}
				const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
				if (prompt === "") {
					fail(exchange, 400, "prompt is required");
					return;
				}
				const targetStream = asString(body.targetStream);
				if (!isSessionId(targetStream)) {
					fail(exchange, 400, "targetStream must be a valid stream id (1-128 letters, digits, underscores or dashes)");
					return;
				}
				const mode = body.mode === "foreground" ? "foreground" : "background";
				const watch = await readWatchFile(cwd, logger);
				const triggers = asObject(watch.triggers) ?? {};
				triggers[name] = {
					kind: "cron",
					cron,
					...(timezone !== "" ? { timezone } : {}),
					targetStream,
					mode,
					prompt,
				};
				watch.triggers = triggers;
				try {
					await writeWatchFile(cwd, watch);
				} catch (error) {
					fail(exchange, 500, `could not write ${WATCH_FILE}: ${describe(error)}`);
					return;
				}
				logger.info(`[admin] saved schedule "${name}" (${cron})`);
				exchange.json(200, { ok: true, restartRequired: true });
			},
		},
		{
			method: "POST",
			path: `${ADMIN_API}/schedules/delete`,
			handle: async (exchange) => {
				let body: Record<string, unknown>;
				try {
					body = parseBody(exchange);
				} catch (error) {
					fail(exchange, 400, describe(error));
					return;
				}
				const name = asString(body.name);
				const watch = await readWatchFile(cwd, logger);
				const triggers = asObject(watch.triggers);
				if (triggers === undefined || triggers[name] === undefined) {
					fail(exchange, 404, `unknown schedule "${name}"`);
					return;
				}
				delete triggers[name];
				watch.triggers = triggers;
				try {
					await writeWatchFile(cwd, watch);
				} catch (error) {
					fail(exchange, 500, `could not write ${WATCH_FILE}: ${describe(error)}`);
					return;
				}
				logger.info(`[admin] deleted schedule "${name}"`);
				exchange.json(200, { ok: true, restartRequired: true });
			},
		},
		{
			method: "POST",
			path: `${ADMIN_API}/schedules/run`,
			handle: async (exchange) => {
				let body: Record<string, unknown>;
				try {
					body = parseBody(exchange);
				} catch (error) {
					fail(exchange, 400, describe(error));
					return;
				}
				const name = asString(body.name);
				const watch = await readWatchFile(cwd, logger);
				const schedule = schedulesFromWatch(watch).find((entry) => entry.name === name);
				if (schedule === undefined) {
					fail(exchange, 404, `unknown schedule "${name}"`);
					return;
				}
				const submitted = await deps.worker.submit(schedule.targetStream, { text: schedule.prompt }, schedule.mode);
				if (!submitted.accepted) {
					fail(exchange, 409, submitted.reason ?? "the worker is busy");
					return;
				}
				logger.info(`[admin] ran schedule "${name}" as ${submitted.runId}`);
				exchange.json(202, { ok: true, runId: submitted.runId, streamId: schedule.targetStream });
			},
		},
		{
			method: "GET",
			path: `${ADMIN_API}/system`,
			handle: async (exchange) => {
				const config = await readConfig();
				const files: { path: string; exists: boolean; size?: number; mtime?: string }[] = [];
				for (const path of RAW_FILES) {
					try {
						const info = await stat(join(cwd, path));
						files.push({ path, exists: true, size: info.size, mtime: info.mtime.toISOString() });
					} catch {
						files.push({ path, exists: false });
					}
				}
				exchange.json(200, {
					version: VERSION,
					node: process.version,
					pid: process.pid,
					cwd,
					streamsDir: deps.streamsDir,
					logLevel: config.logLevel,
					logDir: config.logDir ?? deps.logger.dir ?? "",
					persona: config.persona ?? "",
					watchEnabled: deps.watchEnabled,
					adminFile: adminConfigPath(cwd),
					envFile: envFilePath(cwd),
					watchFile: WATCH_FILE,
					files,
				});
			},
		},
		{
			method: "POST",
			path: `${ADMIN_API}/system/save`,
			handle: async (exchange) => {
				let body: Record<string, unknown>;
				try {
					body = parseBody(exchange);
				} catch (error) {
					fail(exchange, 400, describe(error));
					return;
				}
				const config = await readConfig();
				const rawLevel = body.logLevel;
				if (rawLevel !== undefined && !isLogLevel(rawLevel)) {
					fail(exchange, 400, "logLevel must be debug, info, warn or error");
					return;
				}
				let logDir: string | undefined = config.logDir;
				if (body.logDir !== undefined) {
					if (typeof body.logDir !== "string") {
						fail(exchange, 400, "logDir must be a string");
						return;
					}
					logDir = asString(body.logDir) === "" ? undefined : asString(body.logDir);
				}
				let persona: string | undefined = config.persona;
				if (body.persona !== undefined) {
					if (typeof body.persona !== "string") {
						fail(exchange, 400, "persona must be a string");
						return;
					}
					const trimmed = asString(body.persona).trim();
					persona = trimmed === "" ? undefined : trimmed;
				}
				const next: AdminConfig = {
					...config,
					...(isLogLevel(rawLevel) ? { logLevel: rawLevel } : {}),
					...(logDir !== undefined ? { logDir } : {}),
					...(persona !== undefined ? { persona } : {}),
				};
				if (logDir === undefined) delete next.logDir;
				if (persona === undefined) delete next.persona;
				await writeAdminConfig(cwd, next);
				deps.logger.setLevel(next.logLevel);
				deps.logger.setDir(next.logDir);
				logger.info(`[admin] logging set to ${next.logLevel} -> ${next.logDir ?? "default"}`);
				// The persona is read when a session starts, so a live session keeps the
				// prompt it was created with; the next one picks this up.
				if ((next.persona ?? "") !== (config.persona ?? "")) logger.info("[admin] persona updated; new sessions will use it");
				exchange.json(200, { ok: true, logLevel: next.logLevel, logDir: next.logDir ?? "", persona: next.persona ?? "" });
			},
		},
		{
			method: "GET",
			path: `${ADMIN_API}/files`,
			handle: async (exchange) => {
				const rawPath = (exchange.request.query.get("path") ?? "").replace(/^\.?\//, "");
				const matched = RAW_FILES.find((path) => path === rawPath);
				if (matched === undefined) {
					fail(exchange, 400, `path must be one of ${RAW_FILES.join(", ")}`);
					return;
				}
				const reveal = exchange.request.query.get("reveal") === "1" || exchange.request.query.get("reveal") === "true";
				let content: string;
				try {
					content = await readFile(join(cwd, matched), "utf8");
				} catch (error) {
					fail(exchange, 404, `could not read ${matched}: ${describe(error)}`);
					return;
				}
				exchange.json(200, {
					path: matched,
					content: reveal ? text(content, 512 * 1024) : maskFileContent(matched, text(content, 512 * 1024)),
					masked: !reveal,
				});
			},
		},
		{
			method: "POST",
			path: `${ADMIN_API}/system/restart`,
			handle: (exchange) => {
				logger.warn("[admin] restart requested");
				exchange.json(202, { ok: true, restarting: true });
				deps.restart();
			},
		},
	];
}
