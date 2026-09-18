/**
 * Permission policy: which tool calls need a human's blessing.
 *
 * The policy lives here so every front end shares one implementation. Asking the
 * *user* stays the caller's job (the ACP layer forwards the question to the
 * editor), which keeps this module free of transport details.
 */
import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";

/** What the user decided about one tool call. */
export type PermissionDecision = "allow_once" | "allow_always" | "deny" | "cancel";

export interface PermissionRequest {
	toolName: string;
	toolCallId: string;
	args: unknown;
}

export interface PermissionGateOptions {
	/** `allow` runs everything without asking (`--permissions allow`). */
	mode: "ask" | "allow";
	/** Tool names that need approval; everything else runs untouched. */
	requires: Iterable<string>;
	/** Asks the user, e.g. by sending `session/request_permission` to the editor. */
	ask: (request: PermissionRequest) => Promise<PermissionDecision>;
}

export type PermissionHook = (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

/**
 * Builds the `beforeToolCall` hook: a denial becomes `{ block: true }`, which pi
 * turns into an error tool result the model can read and react to.
 *
 * One gate belongs to one session, so "always allow" never leaks across sessions.
 */
export function createPermissionGate(options: PermissionGateOptions): PermissionHook {
	const required = new Set(options.requires);
	const alwaysAllowed = new Set<string>();

	return async ({ toolCall, args }) => {
		if (options.mode === "allow") return undefined;
		if (!required.has(toolCall.name) || alwaysAllowed.has(toolCall.name)) return undefined;

		let decision: PermissionDecision;
		try {
			decision = await options.ask({ toolName: toolCall.name, toolCallId: toolCall.id, args });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { block: true, reason: `Could not ask for permission: ${message}` };
		}

		switch (decision) {
			case "allow_once":
				return undefined;
			case "allow_always":
				alwaysAllowed.add(toolCall.name);
				return undefined;
			case "cancel":
				return { block: true, reason: "Permission request was cancelled." };
			default:
				return { block: true, reason: "The user denied permission for this tool call." };
		}
	};
}
