import type { AgentEvent } from "@earendil-works/pi-agent-core";

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

function summarizeToolResult(event: Extract<AgentEvent, { type: "tool_execution_end" }>): string {
	const result = event.result as { content?: Array<{ type: string; text?: string }> } | undefined;
	const text = result?.content?.find((part) => part.type === "text")?.text;
	if (!text) return event.isError ? "failed" : "done";
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

/**
 * Renders agent stream events to a terminal: streamed text, thinking,
 * tool calls and per-turn token usage.
 */
export class Renderer {
	private textStarted = false;
	private thinkingStarted = false;

	handle(event: AgentEvent): void {
		switch (event.type) {
			case "turn_start":
				this.textStarted = false;
				this.thinkingStarted = false;
				break;

			case "message_update": {
				const inner = event.assistantMessageEvent;
				if (inner.type === "text_delta") {
					this.thinkingStarted = false;
					if (!this.textStarted) {
						this.textStarted = true;
						process.stdout.write(`\n${color.cyan("assistant")} ${color.dim("›")} `);
					}
					process.stdout.write(inner.delta);
				} else if (inner.type === "thinking_delta") {
					if (!this.thinkingStarted) {
						this.thinkingStarted = true;
						process.stdout.write(`\n${color.dim("thinking › ")}`);
					}
					process.stdout.write(color.dim(inner.delta));
				}
				break;
			}

			case "tool_execution_start":
				process.stdout.write(
					`\n${color.yellow("tool")} ${color.dim("›")} ${color.bold(event.toolName)} ${color.dim(JSON.stringify(event.args))}`,
				);
				break;

			case "tool_execution_end": {
				const result = summarizeToolResult(event);
				const label = event.isError ? color.red("error") : color.green("result");
				process.stdout.write(`\n  ${label} ${color.dim(result)}\n`);
				break;
			}

			case "message_end": {
				const message = event.message;
				if (message.role === "assistant" && message.errorMessage) {
					process.stdout.write(`\n${color.red("error")} ${color.dim(message.errorMessage)}\n`);
				}
				break;
			}

			case "agent_end":
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
