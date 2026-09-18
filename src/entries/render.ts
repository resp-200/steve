import type { AgentRuntimeEvent } from "../features/events.js";

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

function oneLine(text: string, max = 120): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/**
 * Renders normalised runtime events to a terminal: streamed text, thinking,
 * tool calls and per-turn failures.
 */
export class Renderer {
	private textStarted = false;
	private thinkingStarted = false;

	handle(event: AgentRuntimeEvent): void {
		switch (event.type) {
			case "turn_start":
				this.textStarted = false;
				this.thinkingStarted = false;
				break;

			case "text_delta":
				this.thinkingStarted = false;
				if (!this.textStarted) {
					this.textStarted = true;
					process.stdout.write(`\n${color.cyan("assistant")} ${color.dim("›")} `);
				}
				process.stdout.write(event.text);
				break;

			case "thinking_delta":
				if (!this.thinkingStarted) {
					this.thinkingStarted = true;
					process.stdout.write(`\n${color.dim("thinking › ")}`);
				}
				process.stdout.write(color.dim(event.text));
				break;

			case "tool_start":
				process.stdout.write(`\n${color.yellow("tool")} ${color.dim("›")} ${color.bold(event.name)} ${color.dim(JSON.stringify(event.args))}`);
				break;

			case "tool_end": {
				const label = event.isError ? color.red("error") : color.green("result");
				process.stdout.write(`\n  ${label} ${color.dim(oneLine(event.text))}\n`);
				break;
			}

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
}

export function printAssistantText(text: string): void {
	process.stdout.write(`\n${color.cyan("assistant")} ${color.dim("›")} ${text}\n`);
}
