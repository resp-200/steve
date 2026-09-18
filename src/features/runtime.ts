import type { Agent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AppConfig } from "../model/config.js";
import { createKernelAgent } from "../kernel/agent.js";
import { tools } from "./tools.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface SendOptions {
	/** Extra attempts after a request fails before any tool ran. Default: 2. */
	retries?: number;
	/** Delay before attempt N (1-based retry index). */
	retryDelayMs?: (attempt: number) => number;
	onRetry?: (reason: string, attempt: number) => void;
}

export interface SendResult {
	/** True when the last assistant message ended in an error/abort. */
	failed: boolean;
	errorMessage?: string;
	/** Number of retries that were used. */
	retries: number;
}

export interface ChatAgent {
	agent: Agent;
	send(input: string, options?: SendOptions): Promise<SendResult>;
	reset(): void;
	stats(): AgentStats;
}

export interface AgentStats {
	turns: number;
	userMessages: number;
	toolCalls: number;
	inputTokens: number;
	outputTokens: number;
}

export function createChatAgent(config: AppConfig, agentTools: AgentTool<any>[] = tools): ChatAgent {
	const agent = createKernelAgent({ config, tools: agentTools });

	/** Failed turns that ran no tools can be rolled back and retried safely. */
	async function attempt(input: string, retries: number, options: SendOptions): Promise<SendResult> {
		for (let tryIndex = 0; ; tryIndex += 1) {
			const before = agent.state.messages.length;
			await agent.prompt(input);

			const appended: AgentMessage[] = agent.state.messages.slice(before);
			const last = appended.at(-1);
			let failure: string | undefined;
			if (last && last.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
				failure = last.errorMessage ?? `request ${last.stopReason}`;
			}

			const toolsRan = appended.some((message) => message.role === "toolResult");
			if (failure === undefined || toolsRan || tryIndex >= retries) {
				return { failed: failure !== undefined, ...(failure ? { errorMessage: failure } : {}), retries: tryIndex };
			}

			options.onRetry?.(failure, tryIndex + 1);
			// Drop the failed user/assistant pair so the retry starts from a clean transcript.
			agent.state.messages = agent.state.messages.slice(0, before);
			await sleep(options.retryDelayMs?.(tryIndex + 1) ?? Math.min(1_000 * 2 ** tryIndex, 8_000));
		}
	}

	return {
		agent,
		send: (input, options = {}) => attempt(input, options.retries ?? 2, options),
		reset: () => {
			agent.reset();
			agent.state.systemPrompt = config.systemPrompt;
			agent.state.tools = agentTools;
		},
		stats: () => {
			let turns = 0;
			let userMessages = 0;
			let toolCalls = 0;
			let inputTokens = 0;
			let outputTokens = 0;

			for (const message of agent.state.messages) {
				if (message.role === "user") userMessages += 1;
				if (message.role === "toolResult") toolCalls += 1;
				if (message.role === "assistant") {
					turns += 1;
					inputTokens += message.usage?.input ?? 0;
					outputTokens += message.usage?.output ?? 0;
				}
			}

			return { turns, userMessages, toolCalls, inputTokens, outputTokens };
		},
	};
}
