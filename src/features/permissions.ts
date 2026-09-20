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

/**
 * What a pending tool call is about to change, so the user can approve it with
 * their eyes open. Front ends render whatever they can: terminals print `text`,
 * ACP clients get `file` as a real diff.
 */
export interface ToolChangePreview {
	/** One-line summary, e.g. `edit src/app.ts (2 lines)`. */
	summary: string;
	/** Compact diff for terminals and logs. */
	text?: string;
	/** Structured change for clients that render diffs. */
	file?: { path: string; oldText?: string; newText?: string };
}

export interface PermissionRequest {
	toolName: string;
	toolCallId: string;
	args: unknown;
	/** Filled in by the gate when a `describe` callback is configured. */
	preview?: ToolChangePreview;
}

export interface PermissionGateOptions {
	/** `allow` runs everything without asking (`--permissions allow`). */
	mode: "ask" | "allow";
	/**
	 * Tool names that need approval; everything else runs untouched. A function is
	 * evaluated per call, which is how the runtime asks its own tool registry.
	 */
	requires: Iterable<string> | (() => Iterable<string>);
	/** Asks the user, e.g. by sending `session/request_permission` to the editor. */
	ask: (request: PermissionRequest) => Promise<PermissionDecision>;
	/**
	 * Optional: summarise what the call is about to change. The result is handed to
	 * `ask` as `request.preview`, so both front ends show the same diff.
	 */
	describe?: (request: PermissionRequest) => Promise<ToolChangePreview | undefined> | ToolChangePreview | undefined;
}

export type PermissionHook = (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

/**
 * Builds the `beforeToolCall` hook: a denial becomes `{ block: true }`, which pi
 * turns into an error tool result the model can read and react to.
 *
 * One gate belongs to one session, so "always allow" never leaks across sessions.
 */
export function createPermissionGate(options: PermissionGateOptions): PermissionHook {
	const alwaysAllowed = new Set<string>();
	const requiredNames = (): Set<string> =>
		new Set(typeof options.requires === "function" ? options.requires() : options.requires);

	return async ({ toolCall, args }) => {
		if (options.mode === "allow") return undefined;
		if (!requiredNames().has(toolCall.name) || alwaysAllowed.has(toolCall.name)) return undefined;

		const request: PermissionRequest = { toolName: toolCall.name, toolCallId: toolCall.id, args };
		if (options.describe) {
			try {
				const preview = await options.describe(request);
				if (preview) request.preview = preview;
			} catch (error) {
				// A preview is a courtesy: a failure must not block the permission flow.
				const message = error instanceof Error ? error.message : String(error);
				request.preview = { summary: `${toolCall.name} (preview unavailable: ${message})` };
			}
		}

		let decision: PermissionDecision;
		try {
			decision = await options.ask(request);
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
