/**
 * The admin console's on-disk configuration: LLM providers, the active
 * provider and logging preferences (`~/.steve/admin.json`), plus small helpers
 * the console needs to edit `~/.steve/.env` without ever showing raw secrets.
 *
 * The functional layer must stay usable without a console, so nothing here is
 * required at startup: with no admin file the process behaves exactly as
 * before (environment variables only).
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveApi, steveHomeDir, type AppConfig } from "../model/config.js";
import type { Logger } from "../types.js";
import { isLogLevel, type LogLevel } from "./logging.js";
import { coerceRequestHeaders, normalizeRequestHeaders } from "./request-headers.js";

/** Hidden directory shared by every local configuration file (under the home dir). */
export const ADMIN_DIR = ".steve";
export const ADMIN_CONFIG_FILE = "admin.json";
export const ENV_FILE = ".env";

export interface ProviderEntry {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	defaultModel: string;
	models: string[];
	reasoning: boolean;
	/**
	 * Extra request headers for this provider (`request-headers.ts`). Values may
	 * use `${sessionId}`; `x-opencode-session` is filled in automatically.
	 */
	headers?: Record<string, string>;
	/** Hosts the headers apply to; absent = the provider's own host only. */
	hosts?: string[];
	/** `false` opts out of the automatic session header (gateways that don't route by session). */
	requestSessionHeader?: boolean;
	/**
	 * `false` opts this provider out of pictures. Absent = supported: vision is the
	 * norm now, and the cost of the old default was that every user had to discover
	 * a checkbox before their images did anything. A text-only model says so itself
	 * when an image arrives, and the front end turns that refusal into advice.
	 */
	images?: boolean;
}

export interface AdminConfig {
	providers: ProviderEntry[];
	activeProviderId?: string;
	logLevel: LogLevel;
	/** Log **directory**; one file per hour is created under it. Absent = `~/.steve/logs`. */
	logDir?: string;
	/** The user's own role instructions, layered on top of the built-in identity. Absent = none. */
	persona?: string;
}

export const DEFAULT_ADMIN_CONFIG: AdminConfig = { providers: [], logLevel: "info" };

/**
 * Paths are always resolved inside `~/.steve` (or `STEVE_HOME`), never relative
 * to the working directory — starting the service from another folder must not
 * silently read or write a different configuration.
 */
export function adminConfigPath(): string {
	return join(steveHomeDir(), ADMIN_CONFIG_FILE);
}

export function envFilePath(): string {
	return join(steveHomeDir(), ENV_FILE);
}

/** Never send a secret to the browser; keep a stable 4-character tail for recognition. */
export function maskSecret(value: string | undefined): string {
	if (value === undefined || value === "") return "";
	return value.length <= 4 ? "****" : `****${value.slice(-4)}`;
}

export interface ProviderView extends Omit<ProviderEntry, "apiKey"> {
	apiKeyMasked: string;
	hasApiKey: boolean;
	active: boolean;
}

export function providerView(provider: ProviderEntry, activeProviderId?: string): ProviderView {
	return {
		id: provider.id,
		name: provider.name,
		baseUrl: provider.baseUrl,
		defaultModel: provider.defaultModel,
		models: [...provider.models],
		reasoning: provider.reasoning,
		// Header values are connection info like baseUrl (the user chose not to mask
		// them); only apiKey stays a secret.
		headers: { ...(provider.headers ?? {}) },
		hosts: [...(provider.hosts ?? [])],
		requestSessionHeader: provider.requestSessionHeader !== false,
		images: provider.images !== false,
		apiKeyMasked: maskSecret(provider.apiKey),
		hasApiKey: provider.apiKey !== "",
		active: provider.id === activeProviderId,
	};
}

export function activeProvider(config: AdminConfig): ProviderEntry | undefined {
	if (config.activeProviderId === undefined) return undefined;
	return config.providers.find((provider) => provider.id === config.activeProviderId);
}

const THINKING_OFF = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null } as const;

/** Merge the active provider over an environment-derived config. */
export function applyProvider(base: AppConfig, config: AdminConfig): AppConfig {
	const provider = activeProvider(config);
	if (provider === undefined) return base;
	const baseUrl = provider.baseUrl.replace(/\/+$/, "");
	const model: AppConfig["model"] = {
		...base.model,
		id: provider.defaultModel,
		name: `${provider.name} / ${provider.defaultModel}`,
		baseUrl,
		api: resolveApi(baseUrl),
		reasoning: provider.reasoning,
		input: provider.images === false ? ["text"] : ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: base.model.contextWindow,
		maxTokens: base.model.maxTokens,
		...(provider.reasoning ? {} : { thinkingLevelMap: { ...THINKING_OFF } }),
	};
	// Provider request headers travel with the config so the stream layer (which
	// only sees a model) can still apply them.
	return { ...base, apiKey: provider.apiKey, model, requestHeaders: { provider, sessionId: base.requestHeaders?.sessionId } };
}

/**
 * Build a config from a provider alone (first run, before `~/.steve/.env` exists).
 * The shape mirrors `buildModel()` in `model/config.ts`; keeping it here avoids
 * touching the kernel layer, which is deliberately frozen.
 */
export function configFromProvider(provider: ProviderEntry): AppConfig {
	const baseUrl = provider.baseUrl.replace(/\/+$/, "");
	const model: AppConfig["model"] = {
		id: provider.defaultModel,
		name: `${provider.name} / ${provider.defaultModel}`,
		provider: "custom",
		baseUrl,
		api: resolveApi(baseUrl),
		reasoning: provider.reasoning,
		input: provider.images === false ? ["text"] : ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...(provider.reasoning ? {} : { thinkingLevelMap: { ...THINKING_OFF } }),
	};
	return { apiKey: provider.apiKey, model, authStyle: "auto", requestHeaders: { provider } };
}

/**
 * The config every entry point should run on: a provider saved in the console
 * wins over `~/.steve/.env`, and a persona (if any) rides along.
 *
 * Three cases, in order:
 *   1. no active provider     -> the environment must answer (`loadConfig()` throws);
 *   2. provider saved, and `~/.steve/.env` also works -> merge (keeps the env's
 *      context window, max tokens and gateway compatibility flags, swaps in the
 *      provider's key/model);
 *   3. provider saved but no usable environment -> build from the provider alone,
 *      so a fresh machine can be configured straight from the console.
 *
 * The result is the same whichever binary started (CLI, ACP, serve), which is the
 * point: configure once in the console, every entry point follows.
 */
export function resolveRuntimeConfig(
	loadEnvironment: () => AppConfig,
	admin: AdminConfig,
	onWarning?: (message: string) => void,
): AppConfig {
	const provider = activeProvider(admin);
	if (provider === undefined) return withPersona(loadEnvironment(), admin);
	let base: AppConfig | undefined;
	try {
		base = loadEnvironment();
	} catch (error) {
		onWarning?.(`environment config unavailable (${describe(error)}); using provider "${provider.name}"`);
	}
	return withPersona(base === undefined ? configFromProvider(provider) : applyProvider(base, admin), admin);
}

/**
 * Layers the console's persona onto a config. Kept in one place so every entry
 * point (CLI, ACP, serve) applies the user's role instructions the same way.
 */
export function withPersona(config: AppConfig, admin: AdminConfig): AppConfig {
	return admin.persona === undefined ? config : { ...config, persona: admin.persona };
}

const PROVIDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

/** Tolerant read used for the persisted file: one bad entry must not hide the rest. */
export function coerceProvider(raw: unknown, logger?: Logger): ProviderEntry | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const input = raw as Record<string, unknown>;
	const name = nonEmptyString(input.name);
	const baseUrl = nonEmptyString(input.baseUrl);
	const defaultModel = nonEmptyString(input.defaultModel);
	if (name === undefined || baseUrl === undefined || defaultModel === undefined) return undefined;
	if (!/^https?:\/\//i.test(baseUrl)) return undefined;
	const models = Array.isArray(input.models)
		? input.models.filter((model): model is string => typeof model === "string" && model.trim() !== "").map((model) => model.trim())
		: [];
	if (!models.includes(defaultModel)) models.unshift(defaultModel);
	const id = typeof input.id === "string" && PROVIDER_ID.test(input.id) ? input.id : randomBytes(4).toString("hex");
	const entry: ProviderEntry = {
		id,
		name,
		baseUrl: baseUrl.replace(/\/+$/, ""),
		apiKey: typeof input.apiKey === "string" ? input.apiKey : "",
		defaultModel,
		models: [...new Set(models)],
		reasoning: input.reasoning === true,
		...(input.images === false ? { images: false } : {}),
		...coerceHeaderFields(input, (message) => logger?.(`[admin] provider "${entry.name}" ${message}`)),
	};
	if (entry.apiKey === "") logger?.(`[admin] provider "${entry.name}" has no apiKey; it can only be used when the environment supplies one`);
	return entry;
}

/**
 * Strict normalisation for input coming from the console.
 * `existing` lets an edit keep its stored API key when the form leaves it blank.
 */
export function normalizeProviderInput(raw: unknown, existing?: ProviderEntry): ProviderEntry {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("provider must be an object");
	const input = raw as Record<string, unknown>;
	const name = nonEmptyString(input.name);
	if (name === undefined) throw new Error("provider name is required");
	const baseUrl = nonEmptyString(input.baseUrl);
	if (baseUrl === undefined) throw new Error("baseUrl is required");
	if (!/^https?:\/\//i.test(baseUrl)) throw new Error("baseUrl must start with http:// or https://");
	const defaultModel = nonEmptyString(input.defaultModel);
	if (defaultModel === undefined) throw new Error("defaultModel is required");
	const modelsRaw = Array.isArray(input.models) ? input.models : typeof input.models === "string" ? String(input.models).split(",") : [];
	const models = [...new Set([defaultModel, ...modelsRaw.filter((model): model is string => typeof model === "string").map((model) => model.trim()).filter((model) => model !== "")])];
	const incomingKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
	const apiKey = incomingKey !== "" ? incomingKey : (existing?.apiKey ?? "");
	if (apiKey === "") throw new Error("apiKey is required for a new provider");
	const id = existing?.id ?? (typeof input.id === "string" && PROVIDER_ID.test(input.id) ? input.id : randomBytes(4).toString("hex"));
	const headers = normalizeRequestHeaders(input.headers);
	return {
		id,
		name,
		baseUrl: baseUrl.replace(/\/+$/, ""),
		apiKey,
		defaultModel,
		models,
		reasoning: input.reasoning === true,
		// An edit that omits the field inherits the stored value: absence means
		// "use the default" on create, but silently re-enabling pictures on every
		// unrelated save would make the opt-out impossible to keep.
		...((input.images === false || (input.images === undefined && existing?.images === false)) ? { images: false } : {}),
		...(Object.keys(headers).length > 0 ? { headers } : {}),
		...normalizeHostsInput(input.hosts),
		...(input.requestSessionHeader === false ? { requestSessionHeader: false } : {}),
	};
}

/** Optional `hosts` list from the console: an array or a comma separated string. */
function normalizeHostsInput(raw: unknown): { hosts?: string[] } {
	const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
	const hosts = [...new Set(list.filter((host): host is string => typeof host === "string").map((host) => host.trim().toLowerCase()).filter((host) => host !== ""))];
	for (const host of hosts) {
		if (!/^[a-z0-9.-]+(:[0-9]+)?$/.test(host)) throw new Error(`invalid host "${host}"`);
	}
	return hosts.length > 0 ? { hosts } : {};
}

/** The persisted header fields, tolerant: a hand-edited typo costs the headers, not the provider. */
export function coerceHeaderFields(input: Record<string, unknown>, onDrop?: (message: string) => void): Pick<ProviderEntry, "headers" | "hosts" | "requestSessionHeader"> {
	const headers = coerceRequestHeaders(input.headers, onDrop);
	let hosts: { hosts?: string[] } = {};
	if (input.hosts !== undefined) {
		try {
			hosts = normalizeHostsInput(input.hosts);
		} catch (error) {
			onDrop?.(`ignored hosts: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return {
		...(Object.keys(headers).length > 0 ? { headers } : {}),
		...hosts,
		...(input.requestSessionHeader === false ? { requestSessionHeader: false } : {}),
	};
}

export async function readAdminConfig(logger?: Logger): Promise<AdminConfig> {
	const file = adminConfigPath();
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") logger?.(`[admin] could not read ${file}: ${describe(error)}`);
		return { ...DEFAULT_ADMIN_CONFIG };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		logger?.(`[admin] malformed ${file}: ${describe(error)}`);
		return { ...DEFAULT_ADMIN_CONFIG };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		logger?.(`[admin] malformed ${file}: expected an object`);
		return { ...DEFAULT_ADMIN_CONFIG };
	}
	const raw = parsed as Record<string, unknown>;
	const providersRaw = Array.isArray(raw.providers) ? raw.providers : [];
	const providers: ProviderEntry[] = [];
	for (const item of providersRaw) {
		const provider = coerceProvider(item, logger);
		if (provider !== undefined) providers.push(provider);
	}
	const activeId = typeof raw.activeProviderId === "string" && providers.some((provider) => provider.id === raw.activeProviderId) ? raw.activeProviderId : undefined;
	return {
		providers,
		...(activeId !== undefined ? { activeProviderId: activeId } : {}),
		logLevel: isLogLevel(raw.logLevel) ? raw.logLevel : "info",
		...(nonEmptyString(raw.logDir) !== undefined ? { logDir: nonEmptyString(raw.logDir) as string } : {}),
		...(nonEmptyString(raw.persona) !== undefined ? { persona: nonEmptyString(raw.persona) as string } : {}),
	};
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, content, "utf8");
	await rename(temporary, file);
}

export async function writeAdminConfig(config: AdminConfig): Promise<void> {
	const body = {
		providers: config.providers,
		...(config.activeProviderId !== undefined ? { activeProviderId: config.activeProviderId } : {}),
		logLevel: config.logLevel,
		...(config.logDir !== undefined ? { logDir: config.logDir } : {}),
		...(config.persona !== undefined ? { persona: config.persona } : {}),
	};
	await writeFileAtomic(adminConfigPath(), `${JSON.stringify(body, null, 2)}\n`);
}

function quoteEnvValue(value: string): string {
	if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Update keys in `~/.steve/.env` in place. `undefined` leaves the key alone, an
 * empty string removes the line — the console uses the empty string as "clear".
 * Comments and unrelated lines are preserved verbatim.
 */
export async function updateEnvFile(updates: Record<string, string | undefined>): Promise<void> {
	const file = envFilePath();
	let lines: string[] = [];
	try {
		lines = (await readFile(file, "utf8")).split(/\r?\n/);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const pending = new Map<string, string | undefined>(Object.entries(updates));
	const output: string[] = [];
	for (const line of lines) {
		const match = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/.exec(line);
		const key = match?.[2];
		if (key === undefined || !pending.has(key)) {
			output.push(line);
			continue;
		}
		const value = pending.get(key);
		pending.delete(key);
		if (value === undefined || value === "") continue;
		output.push(`${key}=${quoteEnvValue(value)}`);
	}
	for (const [key, value] of pending) {
		if (value !== undefined && value !== "") output.push(`${key}=${quoteEnvValue(value)}`);
	}
	const text = `${output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
	await writeFileAtomic(file, text);
}

export function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
