/**
 * Kernel layer: the one place where a pi-agent-core `Agent` is assembled.
 *
 * Every layer above talks to pi through this factory, so the wiring — stream
 * function, context sanitising, thinking level, initial state — exists exactly
 * once. Policies (retry, permissions, prompts) stay in the layers above and are
 * injected through `hooks`, which is also where the extension layer will plug in.
 */
import {
	Agent,
	type AgentMessage,
	type AgentTool,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	type AfterToolCallContext,
	type AfterToolCallResult,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AppConfig } from "../model/config.js";
import { createStreamFn } from "../model/stream.js";

/** Seams the layers above may hook into without touching the wiring below. */
export interface KernelHooks {
	/** Runs before every tool call; return `{ block: true }` to refuse it. */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	/** Observes/rewrites a tool result before the model sees it. */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	/** Refines the transcript after the built-in failed-turn filter ran. */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> | AgentMessage[];
	/** Mutates provider request headers in place (synchronous, see `createStreamFn`). */
	beforeProviderHeaders?: (headers: Record<string, string>, model: Model<Api>) => void;
}

export interface KernelAgentOptions {
	config: AppConfig;
	tools: AgentTool<any>[];
	/** Defaults to `config.systemPrompt` (ACP sessions compose their own prompt). */
	systemPrompt?: string;
	hooks?: KernelHooks;
}

/**
 * A turn that failed before producing any content must never be replayed to the
 * provider, so it is filtered out of the context sent with the next request.
 */
function withoutFailedTurns(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter(
		(message) =>
			!(
				message.role === "assistant" &&
				message.content.length === 0 &&
				(message.stopReason === "error" || message.stopReason === "aborted")
			),
	);
}

export function createKernelAgent(options: KernelAgentOptions): Agent {
	return new Agent({
		streamFn: createStreamFn(() => options.config.apiKey, options.config.authStyle, options.hooks?.beforeProviderHeaders),
		getApiKey: () => options.config.apiKey,
		// The failed-turn filter always runs first; extensions may refine it further.
		transformContext: async (messages, signal) => {
			const filtered = withoutFailedTurns(messages);
			return options.hooks?.transformContext ? options.hooks.transformContext(filtered, signal) : filtered;
		},
		beforeToolCall: options.hooks?.beforeToolCall,
		afterToolCall: options.hooks?.afterToolCall,
		initialState: {
			systemPrompt: options.systemPrompt ?? options.config.systemPrompt,
			model: options.config.model,
			thinkingLevel: options.config.model.reasoning ? "low" : "off",
			tools: options.tools,
			messages: [],
		},
	});
}
