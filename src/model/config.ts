import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Model, ProviderId } from "@earendil-works/pi-ai";
import type { RequestHeadersProvider } from "./request-headers.js";

/**
 * Parses one .env file into key/value pairs (no expansion, no interpolation).
 *
 * Exported because `scripts/steve-acp-serve.mjs` reads `ACP_TOKEN` out of
 * `~/.steve/.env` with exactly these rules — one parser, so the two can't drift.
 */
export function parseEnvFile(file: string): [string, string][] {
	const entries: [string, string][] = [];
	for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		const separator = line.indexOf("=");
		if (separator === -1) continue;

		const key = line.slice(0, separator).trim();
		let value = line.slice(separator + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key) entries.push([key, value]);
	}
	return entries;
}

/**
 * Tiny .env loader so this project has zero runtime dependencies beyond pi.
 *
 * `files` is ordered lowest priority first: later files override earlier ones,
 * but a real environment variable always wins over every file.
 */
export function loadEnvFiles(files: string[]): void {
	const fromFiles = new Set<string>();
	for (const file of files) {
		if (!existsSync(file)) continue;
		for (const [key, value] of parseEnvFile(file)) {
			// `fromFiles` distinguishes "set by an earlier file" (overridable) from
			// "set by the real environment" (never touched).
			if (key in process.env && !fromFiles.has(key)) continue;
			process.env[key] = value;
			fromFiles.add(key);
		}
	}
}

/**
 * The one global state directory: `~/.steve`.
 *
 * Everything Steve persists — `.env` credentials, `admin.json`, `watch.json`,
 * `mcp.json`, `streams/`, `sessions/`, `logs/` — lives here, so starting the
 * same install from different working directories always reads the same
 * configuration. `STEVE_HOME` overrides the directory (tests and unusual
 * installs point it at a scratch location).
 */
export function steveHomeDir(): string {
	const override = process.env.STEVE_HOME?.trim();
	if (override !== undefined && override !== "") return resolve(override);
	return join(homedir(), ".steve");
}

/** Create `~/.steve` if needed and return it. */
export function ensureSteveHome(): string {
	const dir = steveHomeDir();
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Where credentials are looked for. There is exactly one file now: the global
 * `~/.steve/.env`. Real environment variables still win over it (see
 * `loadEnvFiles`); project-local `.env` files are deliberately ignored so a
 * checkout can never silently override the user's keys.
 */
export function envFileCandidates(): string[] {
	return [join(steveHomeDir(), ".env")];
}

/** Wire protocols this demo can talk to. */
export const SUPPORTED_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type SupportedApi = (typeof SUPPORTED_APIS)[number];

/**
 * How the API key is transmitted.
 * - `bearer`: also send `Authorization: Bearer <key>` (x-api-key still goes out for Anthropic)
 * - `api-key`: leave the adapter default alone
 * - `auto`: Bearer for Anthropic-compatible gateways, api-key only for api.anthropic.com
 */
export type AuthStyle = "auto" | "bearer" | "api-key";

/**
 * Per-provider request headers (see `model/request-headers.ts`). `provider` is
 * the selected console entry — absent when the provider comes from `.env`, where
 * there is no entry to configure.
 *
 * `sessionId` is the conversation every request of this run belongs to: a
 * session id for chat surfaces, a stream id for one-shot runs, `undefined` when
 * neither exists. It feeds the `${sessionId}` placeholder; the last resort when
 * it is missing is the provider id.
 */
export interface RequestHeaderConfig {
	provider?: RequestHeadersProvider;
	sessionId?: string;
}

export interface AppConfig {
	apiKey: string;
	model: Model<SupportedApi>;
	/** Replaces the identity body of the system prompt; see `model/prompt.ts`. */
	identity?: string;
	/** The console's role instructions, layered on top of the identity. */
	persona?: string;
	authStyle: AuthStyle;
	requestHeaders?: RequestHeaderConfig;
}

function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(
			`Missing required environment variable ${name}. Put it in ${envFileCandidates()[0]} (copy .env.example there), ` +
				"or save a provider in the admin console (steve-serve, then /admin).",
		);
	}
	return value;
}

function boolEnv(name: string, fallback: boolean): boolean {
	const value = process.env[name]?.trim().toLowerCase();
	if (value === undefined || value === "") return fallback;
	return value === "1" || value === "true" || value === "yes";
}

function intEnv(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name]?.trim() ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** `LLM_API` wins, otherwise the base URL decides (Anthropic-style gateways are recognisable). */
export function resolveApi(baseUrl: string): SupportedApi {
	const configured = process.env.LLM_API?.trim();
	if (configured) {
		if (!(SUPPORTED_APIS as readonly string[]).includes(configured)) {
			throw new Error(`LLM_API must be one of ${SUPPORTED_APIS.join(", ")} (got "${configured}")`);
		}
		return configured as SupportedApi;
	}
	return /anthropic|\/v1\/messages/i.test(baseUrl) ? "anthropic-messages" : "openai-completions";
}

/**
 * Builds a pi `Model` for any OpenAI- or Anthropic-compatible endpoint.
 * `api` decides which pi-ai streaming adapter turns it into a request.
 */
export function buildModel(): Model<SupportedApi> {
	const id = requireEnv("LLM_MODEL_ID");
	const baseUrl = requireEnv("LLM_BASE_URL").replace(/\/+$/, "");
	const provider = (process.env.LLM_PROVIDER?.trim() || "custom") as ProviderId;
	const reasoning = boolEnv("LLM_REASONING", false);
	const api = resolveApi(baseUrl);

	const common = {
		id,
		name: id,
		provider,
		baseUrl,
		reasoning,
		// Without reasoning support, hide every thinking level from the agent.
		thinkingLevelMap: reasoning
			? undefined
			: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
		// Opt-in: an OpenAI-compatible gateway that only does text answers an image
		// with a 400, so vision is declared rather than guessed.
		input: (boolEnv("LLM_IMAGES", true) ? ["text", "image"] : ["text"]) as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: intEnv("LLM_CONTEXT_WINDOW", 128_000),
		maxTokens: intEnv("LLM_MAX_TOKENS", 8_192),
	};

	switch (api) {
		case "anthropic-messages":
			// The Anthropic SDK posts to `<baseUrl>/v1/messages`; compat defaults are fine
			// (they only add standard fields such as cache_control / eager_input_streaming).
			return { ...common, api };

		case "openai-responses":
			// Custom Codex-style gateways often reject OpenAI-only request fields.
			return { ...common, api, compat: { supportsDeveloperRole: false, supportsMaxOutputTokens: false } };

		default:
			return {
				...common,
				api: "openai-completions",
				compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: reasoning },
			};
	}
}

function resolveAuthStyle(): AuthStyle {
	const configured = process.env.LLM_AUTH_STYLE?.trim().toLowerCase();
	if (configured === "bearer" || configured === "api-key" || configured === "auto") return configured;
	if (configured) throw new Error(`LLM_AUTH_STYLE must be auto, bearer or api-key (got "${configured}")`);
	return "auto";
}

export function loadConfig(): AppConfig {
	// One global config file: ~/.steve/.env. Create the directory on first run so
	// the admin console and the gateway editor have somewhere to write.
	ensureSteveHome();
	loadEnvFiles(envFileCandidates());
	return {
		apiKey: requireEnv("LLM_API_KEY"),
		model: buildModel(),
		...(process.env.LLM_SYSTEM_PROMPT?.trim() ? { identity: process.env.LLM_SYSTEM_PROMPT.trim() } : {}),
		authStyle: resolveAuthStyle(),
	};
}
