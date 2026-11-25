/**
 * Everything this session sends *to* the client: live runtime events as
 * `session/update` notifications, plus the replayed stored transcript.
 *
 * `session.ts` keeps the session lifecycle; this file owns the protocol's
 * update vocabulary, so the two concerns can change independently.
 */
import type { SessionUpdate, ToolKind } from "@agentclientprotocol/sdk";
import type { StreamEventBody, TranscriptEntry } from "../../features/events.js";
import type { Logger } from "../../types.js";
import { locationsFromArgs } from "./content.js";
import { toolCallContent } from "./tool-call.js";

export interface AcpPublisherOptions {
	sessionId: string;
	/** How a `session/update` notification reaches the client. */
	send: (update: SessionUpdate) => Promise<void>;
	/** How a tool call should be presented (declared by the tool, never by name). */
	kindFor: (toolName: string) => ToolKind;
	titleFor: (toolName: string, args: unknown) => string;
	logger: Logger;
}

export interface AcpPublisher {
	send(update: SessionUpdate): Promise<void>;
	/** Fire-and-forget: a failed notification must not break the agent loop. */
	publish(event: StreamEventBody): void;
	/** Events the client has no representation for are ignored. */
	publishEvent(event: StreamEventBody): Promise<void>;
	/** Replays a stored transcript to the client (used by `session/load`). */
	replay(entries: TranscriptEntry[]): Promise<void>;
}

export function createAcpPublisher(options: AcpPublisherOptions): AcpPublisher {
	const publishEvent = async (event: StreamEventBody): Promise<void> => {
		switch (event.type) {
			case "text_delta":
				await options.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } });
				break;

			case "thinking_delta":
				await options.send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.text } });
				break;

			case "tool_start":
				await options.send({
					sessionUpdate: "tool_call",
					toolCallId: event.id,
					title: options.titleFor(event.name, event.args),
					name: event.name,
					kind: options.kindFor(event.name),
					status: "in_progress",
					rawInput: event.args,
					locations: locationsFromArgs(event.args),
				});
				break;

			case "tool_update":
				await options.send({
					sessionUpdate: "tool_call_update",
					toolCallId: event.id,
					status: "in_progress",
					content: toolCallContent(event.text, undefined),
				});
				break;

			case "tool_end":
				await options.send({
					sessionUpdate: "tool_call_update",
					toolCallId: event.id,
					status: event.isError ? "failed" : "completed",
					content: toolCallContent(event.text, event.details, event.images),
					rawOutput: event.details ?? null,
				});
				break;

			default:
				// turn_start / turn_end and stream-lifecycle events carry nothing the
				// client needs; projection decides what reaches this layer at all.
				break;
		}
	};

	const replay = async (entries: TranscriptEntry[]): Promise<void> => {
		for (const entry of entries) {
			if (entry.role === "user") {
				const suffix = entry.images > 0 ? `\n[${entry.images} image(s)]` : "";
				await options.send({ sessionUpdate: "user_message_chunk", content: { type: "text", text: `${entry.text}${suffix}` } });
				continue;
			}

			if (entry.role === "assistant") {
				if (entry.thinking) await options.send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: entry.thinking } });
				if (entry.text) await options.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: entry.text } });
				for (const call of entry.toolCalls) {
					await options.send({
						sessionUpdate: "tool_call",
						toolCallId: call.id,
						title: options.titleFor(call.name, call.args),
						name: call.name,
						kind: options.kindFor(call.name),
						status: "in_progress",
						rawInput: call.args,
						locations: locationsFromArgs(call.args),
					});
				}
				continue;
			}

			await options.send({
				sessionUpdate: "tool_call_update",
				toolCallId: entry.toolCallId,
				status: entry.isError ? "failed" : "completed",
				content: toolCallContent(entry.text, undefined),
			});
		}
	};

	return {
		send: options.send,
		replay,
		publishEvent,
		publish(event) {
			void publishEvent(event).catch((error: unknown) => {
				options.logger(`session ${options.sessionId}: failed to send update: ${String(error)}`);
			});
		},
	};
}
