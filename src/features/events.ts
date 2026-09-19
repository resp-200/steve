/**
 * The functional layer's event vocabulary.
 *
 * Everything above this layer (protocols, entries) speaks only these types, so
 * the layers that talk to clients never have to know how pi names its events —
 * and one vocabulary serves every front end (terminal, ACP, future protocols).
 */

/** Where a turn ended, in terms a UI understands (no provider vocabulary). */
export type TurnStopReason = "stop" | "tool_use" | "length" | "cancelled" | "error";

export interface TurnUsage {
	input: number;
	output: number;
	total: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
}

/** An image attached to a prompt, independent of any provider's schema. */
export interface PromptImage {
	mimeType: string;
	data: string;
}

/** One entry of a replayed transcript, in provider-neutral terms. */
export type TranscriptEntry =
	| { role: "user"; text: string; images: number }
	| { role: "assistant"; thinking: string; text: string; toolCalls: { id: string; name: string; args: unknown }[] }
	| { role: "tool"; toolCallId: string; name: string; isError: boolean; text: string };

export type AgentRuntimeEvent =
	| { type: "turn_start" }
	| { type: "text_delta"; text: string }
	| { type: "thinking_delta"; text: string }
	| { type: "tool_start"; id: string; name: string; args: unknown }
	| { type: "tool_update"; id: string; name: string; text: string }
	| { type: "tool_end"; id: string; name: string; isError: boolean; text: string; details?: unknown; images?: PromptImage[] }
	| {
			type: "turn_end";
			stopReason: TurnStopReason;
			/** Usage reported by the provider for the final assistant message of the turn. */
			usage: TurnUsage;
			/** Tokens the transcript occupied after this turn (used by `usage_update`). */
			contextTokens: number;
			failed: boolean;
			errorMessage?: string;
			/** Retries that were needed before the turn settled. */
			retries: number;
	  };
