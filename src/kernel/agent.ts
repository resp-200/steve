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
} from "@earendil-works/pi-agent-core";
import type { AppConfig } from "../model/config.js";
import { createStreamFn } from "../model/stream.js";

/** Seams the layers above may hook into without touching the wiring below. */
export interface KernelHooks {
	/** Runs before every tool call; return `{ block: true }` to refuse it. */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
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
		streamFn: createStreamFn(() => options.config.apiKey, options.config.authStyle),
		getApiKey: () => options.config.apiKey,
		transformContext: async (messages) => withoutFailedTurns(messages),
		beforeToolCall: options.hooks?.beforeToolCall,
		initialState: {
			systemPrompt: options.systemPrompt ?? options.config.systemPrompt,
			model: options.config.model,
			thinkingLevel: options.config.model.reasoning ? "low" : "off",
			tools: options.tools,
			messages: [],
		},
	});
}
