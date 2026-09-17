import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ProviderId } from "@earendil-works/pi-ai";

/**
 * Tiny .env loader so this project has zero runtime dependencies beyond pi.
 * Existing process.env values always win over the file.
 */
export function loadEnvFile(file = resolve(process.cwd(), ".env")): void {
	if (!existsSync(file)) return;

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
		if (key && !(key in process.env)) process.env[key] = value;
	}
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

export interface AppConfig {
	apiKey: string;
	model: Model<SupportedApi>;
	systemPrompt: string;
	authStyle: AuthStyle;
}

function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`);
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

export const DEFAULT_SYSTEM_PROMPT = [
	"You are a concise, friendly assistant running inside a small CLI demo built on pi-agent-core.",
	"Use the provided tools whenever they can answer the question more accurately than reasoning alone.",
	"Prefer short answers. Reply in the same language the user writes in.",
].join(" ");

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
		input: ["text"] as ("text" | "image")[],
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

/** Directory of the installed project (dist/ or src/ -> project root). */
function packageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function loadConfig(): AppConfig {
	// cwd first (normal CLI use), then the project's own .env so editors that
	// spawn the ACP server from another working directory still find credentials.
	loadEnvFile();
	loadEnvFile(resolve(packageRoot(), ".env"));
	return {
		apiKey: requireEnv("LLM_API_KEY"),
		model: buildModel(),
		systemPrompt: process.env.LLM_SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT,
		authStyle: resolveAuthStyle(),
	};
}
