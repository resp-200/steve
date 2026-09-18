import {
	createAssistantMessageEventStream,
	hasApi,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import { streamSimple as anthropicStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as completionsStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responsesStreamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AuthStyle } from "./config.js";

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * The agent loop contract requires stream functions to never throw: failures
 * must be encoded inside the stream. `streamSimple` can throw synchronously
 * (e.g. missing auth), so we wrap it.
 */
function errorStream(model: Model<Api>, message: string): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const error: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
	stream.push({ type: "error", reason: "error", error });
	return stream;
}

/**
 * The Anthropic SDK authenticates with `x-api-key`, but many Anthropic-compatible
 * gateways (LiteLLM, one-api, vendor proxies) only accept `Authorization: Bearer`.
 * We send both when needed; the real Anthropic API is left untouched.
 */
function wantsBearerHeader(model: Model<Api>, authStyle: AuthStyle): boolean {
	if (model.api !== "anthropic-messages") return false;
	if (authStyle === "bearer") return true;
	if (authStyle === "api-key") return false;

	try {
		return new URL(model.baseUrl).hostname !== "api.anthropic.com";
	} catch {
		return true;
	}
}

/**
 * Routes `Agent` requests to pi-ai's streaming adapters. Everything a model
 * needs (baseUrl, compat, maxTokens) lives on the `Model` built in config.ts.
 */
export function createStreamFn(
	getApiKey: () => string | undefined,
	authStyle: AuthStyle = "auto",
	/** Mutates provider request headers in place; must be synchronous (the stream fn cannot await). */
	onHeaders?: (headers: Record<string, string>, model: Model<Api>) => void,
): StreamFn {
	return (model, context, options) => {
		const apiKey = options?.apiKey ?? getApiKey();
		if (!apiKey) {
			return errorStream(model, `No API key available for provider "${model.provider}".`);
		}

		try {
			const bearer = wantsBearerHeader(model, authStyle);
			let headers = options?.headers as Record<string, string> | undefined;
			if (bearer || onHeaders) {
				headers = { ...headers };
				if (bearer) headers.Authorization = `Bearer ${apiKey}`;
			}
			onHeaders?.(headers ?? {}, model);
			const streamOptions = { ...options, apiKey, headers };

			if (hasApi(model, "anthropic-messages")) return anthropicStreamSimple(model, context, streamOptions);
			if (hasApi(model, "openai-completions")) return completionsStreamSimple(model, context, streamOptions);
			if (hasApi(model, "openai-responses")) return responsesStreamSimple(model, context, streamOptions);
			return errorStream(model, `Unsupported model api "${model.api}".`);
		} catch (error) {
			return errorStream(model, error instanceof Error ? error.message : String(error));
		}
	};
}
