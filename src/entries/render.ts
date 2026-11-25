import type { StreamEventBody } from "../features/events.js";
import { oneLine, type ProjectedEvent, type UserProjectedBody } from "../features/projection.js";

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

const paint = (code: string, text: string): string => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);

export const color = {
	dim: (text: string) => paint("2", text),
	bold: (text: string) => paint("1", text),
	cyan: (text: string) => paint("36", text),
	green: (text: string) => paint("32", text),
	yellow: (text: string) => paint("33", text),
	red: (text: string) => paint("31", text),
	magenta: (text: string) => paint("35", text),
};

/**
 * Renders projected events to a terminal: streamed text, tool calls and per-turn
 * failures. What it receives has already been narrowed by `project()` — with the
 * `user` audience it never sees raw tool arguments, tool output text or model
 * thinking, so this class cannot accidentally print them.
 */
export class Renderer {
	private textStarted = false;
	private thinkingStarted = false;

	handle(projected: ProjectedEvent): void {
		if (projected.audience === "user") {
			this.handleUser(projected.event);
			return;
		}
		this.handleFull(projected.event);
	}

	/** Everything audiences: the CLI `--audience full` view, unchanged from before. */
	private handleFull(event: StreamEventBody): void {
		switch (event.type) {
			case "turn_start":
				this.reset();
				break;

			case "text_delta":
				this.writeText(event.text);
				break;

			case "thinking_delta":
				if (!this.thinkingStarted) {
					this.thinkingStarted = true;
					process.stdout.write(`\n${color.dim("thinking › ")}`);
				}
				process.stdout.write(color.dim(event.text));
				break;

			case "tool_start":
				process.stdout.write(
					`\n${color.yellow("tool")} ${color.dim("›")} ${color.bold(event.name)} ${color.dim(JSON.stringify(event.args))}`,
				);
				break;

			case "tool_end":
				process.stdout.write(`\n  ${this.resultLabel(event.isError)} ${color.dim(oneLine(event.text))}\n`);
				break;

			case "turn_end":
				if (event.errorMessage) {
					process.stdout.write(`\n${color.red("error")} ${color.dim(event.errorMessage)}\n`);
				}
				process.stdout.write("\n");
				break;

			default:
				break;
		}
	}

	/** `user` audience: no arguments, no output text, no thinking — only summaries. */
	private handleUser(event: UserProjectedBody): void {
		switch (event.type) {
			case "turn_start":
				this.reset();
				break;

			case "text_delta":
				this.writeText(event.text);
				break;

			case "thinking_delta":
				// The placeholder says thinking happened; its text stays internal.
				if (!this.thinkingStarted) {
					this.thinkingStarted = true;
					process.stdout.write(`\n${color.dim("thinking › …")}`);
				}
				break;

			case "tool_start":
				process.stdout.write(
					`\n${color.yellow("tool")} ${color.dim("›")} ${color.bold(event.name)}${event.title ? ` ${color.dim(event.title)}` : ""}`,
				);
				break;

			case "tool_end":
				process.stdout.write(`\n  ${this.resultLabel(event.isError)} ${color.dim(event.summary ?? "")}\n`);
				break;

			case "turn_end":
				process.stdout.write("\n");
				break;

			default:
				break;
		}
	}

	private reset(): void {
		this.textStarted = false;
		this.thinkingStarted = false;
	}

	private writeText(text: string): void {
		this.thinkingStarted = false;
		if (!this.textStarted) {
			this.textStarted = true;
			process.stdout.write(`\n${color.cyan("assistant")} ${color.dim("›")} `);
		}
		process.stdout.write(text);
	}

	private resultLabel(isError: boolean): string {
		return isError ? color.red("error") : color.green("result");
	}
}

export function printAssistantText(text: string): void {
	process.stdout.write(`\n${color.cyan("assistant")} ${color.dim("›")} ${text}\n`);
}
