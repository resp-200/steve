/**
 * Built-in plugin: the demo tool (`get_current_time`).
 *
 * It used to live in the core as `features/tools.ts`. Keeping it here is the
 * dogfooding check for the tool half of the extension API: registering a tool,
 * declaring its presentation metadata and building schemas through `pi.Type`
 * must be enough — no core access required.
 */
import { Type, type Static } from "../../features/contract.js";
import type { AnnotatedTool } from "../../features/tool-annotations.js";
import type { ExtensionAPI } from "../api.js";

const TimeParams = Type.Object({
	timeZone: Type.Optional(
		Type.String({ description: "IANA time zone such as 'Asia/Shanghai' or 'UTC'. Defaults to the machine's local zone." }),
	),
});

type TimeParams = Static<typeof TimeParams>;

export const getCurrentTimeTool: AnnotatedTool<typeof TimeParams> = {
	name: "get_current_time",
	label: "Current time",
	description: "Return the current date and time, optionally for a specific IANA time zone.",
	metadata: { kind: "other", title: "Get current time" },
	parameters: TimeParams,
	execute: async (_toolCallId, params) => {
		const timeZone = params.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
		let formatted: string;
		try {
			formatted = new Intl.DateTimeFormat("en-CA", {
				dateStyle: "full",
				timeStyle: "long",
				timeZone,
			}).format(new Date());
		} catch {
			// Throwing is the documented failure path too, but an unknown zone is
			// cheap to report inline: the model just picks a valid one and retries.
			return {
				content: [{ type: "text", text: `Unknown time zone "${timeZone}".` }],
				details: { timeZone, ok: false },
			};
		}
		return {
			content: [{ type: "text", text: `${formatted} (${timeZone})` }],
			details: { timeZone, iso: new Date().toISOString(), ok: true },
		};
	},
};

export function demoTools(pi: ExtensionAPI): void {
	// The tool already carries its annotations; hand them straight through.
	pi.registerTool(getCurrentTimeTool as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
}
