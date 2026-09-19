// Offline OpenAI-compatible mock server (no API key or network needed).
//
//   node scripts/mock-server.mjs      # or: npm run mock
//   LLM_API_KEY=mock LLM_MODEL_ID=mock-model LLM_BASE_URL=http://127.0.0.1:8899/v1 npm run dev "hello"
//
// It serves both wire protocols used by this demo:
//   POST /v1/chat/completions   (LLM_API=openai-completions, default)
//   POST /v1/responses          (LLM_API=openai-responses)
//
// Behaviour: a user message containing "21" triggers a `calculate` tool call,
// "boom" triggers a tool call with an invalid expression (tool error path), and
// a tool result produces the final answer; anything else streams a fixed reply.
// A message containing "flaky" gets two HTTP 429s before succeeding (retry path);
// one containing "rm -rf" plans a destructive run_command (guard-hook path).
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8899);
const REPLY = "你好！我是一个基于 pi-agent-core 与 pi-ai 的最小对话 Agent。";
const FINAL = "21 * 2 = 42 ✅ (computed with the calculate tool)";

// Failure injection so retry behaviour is testable offline: a turn that mentions
// "flaky" is answered with HTTP 429 until it happened FLAKY_FAILURES times, then the
// successful reply carries FLAKY_MARKER plus how many failures were injected.
const FLAKY_FAILURES = 2;
const FLAKY_MARKER = "flaky-recovered";
let flakyFailures = 0;

const usage = () => ({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });

/* ---------------------------- chat completions --------------------------- */

const chunk = (delta, finishReason = null) =>
	`data: ${JSON.stringify({
		id: "chatcmpl-mock",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "mock-model",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	})}\n\n`;

function completionEvents(text) {
	return [
		chunk({ role: "assistant", content: "" }),
		...text.split(/(\s+)/).filter(Boolean).map((piece) => chunk({ content: piece })),
		chunk({}, "stop"),
		`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", choices: [], usage: usage() })}\n\n`,
		"data: [DONE]\n\n",
	];
}

function completionToolCallEvents(name, input) {
	const args = JSON.stringify(input);
	return [
		chunk({
			role: "assistant",
			content: "",
			tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: "" } }],
		}),
		chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }),
		chunk({}, "tool_calls"),
		"data: [DONE]\n\n",
	];
}

/* ------------------------------ responses API ---------------------------- */

const sse = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

function responseEvents(text) {
	const message = (status, content = []) => ({ id: "msg_1", type: "message", status, role: "assistant", content });
	const part = { type: "output_text", text, annotations: [] };
	const model = { id: "resp_1", object: "response", created_at: 1, status: "completed", model: "mock-model", parallel_tool_calls: true, tool_choice: "auto", tools: [] };

	const events = [
		{ type: "response.created", sequence_number: 0, response: { ...model, status: "in_progress", output: [] } },
		{ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: message("in_progress") },
		{ type: "response.content_part.added", sequence_number: 2, item_id: "msg_1", output_index: 0, content_index: 0, part: { ...part, text: "" } },
		{ type: "response.output_text.delta", sequence_number: 3, item_id: "msg_1", output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_text.done", sequence_number: 4, item_id: "msg_1", output_index: 0, content_index: 0, text },
		{ type: "response.output_item.done", sequence_number: 5, output_index: 0, item: message("completed", [part]) },
		{
			type: "response.completed",
			sequence_number: 6,
			response: {
				...model,
				output: [message("completed", [part])],
				usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
			},
		},
	];
	return events.map(sse);
}

/* --------------------------------- server -------------------------------- */
/* ---------------------------- anthropic messages -------------------------- */

function anthropicEvents(blocks, stopReason, usage) {
	const events = [
		{
			type: "message_start",
			message: { id: "msg_mock", type: "message", role: "assistant", model: "mock-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } },
		},
	];

	for (const [index, block] of blocks.entries()) {
		events.push({ type: "content_block_start", index, content_block: block.start });
		for (const delta of block.deltas) events.push({ type: "content_block_delta", index, delta });
		events.push({ type: "content_block_stop", index });
	}

	events.push(
		{ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } },
		{ type: "message_stop" },
	);
	return events.map(sse);
}

const anthropicText = (text) =>
	anthropicEvents(
		[{ start: { type: "text", text: "" }, deltas: text.split(/(\s+)/).filter(Boolean).map((piece) => ({ type: "text_delta", text: piece })) }],
		"end_turn",
		{ input_tokens: 11, output_tokens: 7 },
	);

const anthropicToolCall = (toolName, input) =>
	anthropicEvents(
		[
			{
				start: { type: "tool_use", id: "toolu_mock", name: toolName, input: {} },
				deltas: [{ type: "input_json_delta", partial_json: JSON.stringify(input) }],
			},
		],
		"tool_use",
		{ input_tokens: 11, output_tokens: 7 },
	);

/**
 * Keyword-driven tool routing so ACP scenarios (fs / terminal / permissions)
 * can be exercised offline: "read <abs path>", "write <abs path>", "run ...".
 */
function planToolCall(text) {
	const path = (text.match(/\/[^\s"'`,;)]+/) ?? [])[0];
	if (/\b(read|cat|open)\b/i.test(text) && path) return { name: "read_file", input: { path, limit: 20 } };
	if (/\b(write|save|create)\b/i.test(text) && path) return { name: "write_file", input: { path, content: "hello from the mock model\n" } };
	// Lets the MCP passthrough be exercised end to end (see scripts/mcp-test.mjs).
	if (/\bmcp-echo\b/i.test(text)) return { name: "mcp__mock__echo", input: { text: "hello from the gateway" } };
	// A destructive-looking command, so tool_call guards are reachable offline.
	if (/\brm\b/i.test(text) && /-rf|--recursive/i.test(text)) {
		return { name: "run_command", input: { command: "rm", args: ["-rf", "/tmp/steve-demo"] } };
	}
	if (/\b(run|exec|execute|ls|shell)\b/i.test(text)) return { name: "run_command", input: { command: "ls" } };
	if (text.includes("boom")) return { name: "calculate", input: { expression: "1 +" } };
	if (text.includes("21")) return { name: "calculate", input: { expression: "21 * 2" } };
	return undefined;
}

/** Text a tool result carried, so the final answer proves the round trip. */
function toolResultText(messages) {
	for (const message of [...messages].reverse()) {
		if (message.role === "tool" && typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "tool_result") {
				const inner = Array.isArray(block.content) ? block.content : [block.content];
				return inner.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join(" ");
			}
		}
	}
	return undefined;
}

function streamEvents(res, events, delayMs = 12) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	let index = 0;
	const timer = setInterval(() => {
		if (index >= events.length) {
			clearInterval(timer);
			res.end();
			return;
		}
		res.write(events[index++]);
	}, delayMs);
}

createServer((req, res) => {
	let body = "";
	req.on("data", (piece) => (body += piece));
	req.on("end", () => {
		const pathname = (req.url ?? "").split("?")[0] ?? "";   // anthropic uses /v1/messages?beta=true
		if (!pathname.endsWith("/chat/completions") && !pathname.endsWith("/responses") && !pathname.endsWith("/messages")) {
			res.writeHead(404).end("not found");
			return;
		}

		const payload = JSON.parse(body || "{}");
		const responsesApi = pathname.endsWith("/responses");
		const messages = payload.messages ?? payload.input ?? [];
		const list = Array.isArray(messages) ? messages : [];
		// Only the *current* turn matters: a trailing tool result means "answer now".
		const lastMessage = list.at(-1);
		const sawToolResult = Boolean(
			lastMessage &&
				((lastMessage.type ?? lastMessage.role) === "function_call_output" ||
					lastMessage.role === "tool" ||
					(Array.isArray(lastMessage.content) && lastMessage.content.some((block) => block.type === "tool_result"))),
		);
		const asked = JSON.stringify(list.at(-1)?.content ?? list.at(-1)?.content?.[0]?.text ?? payload.input ?? "");

		if (!asked.includes("flaky")) {
			flakyFailures = 0; // a different turn resets the scenario
		} else if (flakyFailures < FLAKY_FAILURES) {
			flakyFailures += 1;
			console.log(`[mock] injected 429 ${flakyFailures}/${FLAKY_FAILURES}`);
			res.writeHead(429, { "content-type": "application/json" });
			res.end(
				JSON.stringify(
					pathname.endsWith("/messages")
						? { type: "error", error: { type: "rate_limit_error", message: "gateway_concurrency_limit" } }
						: { error: { type: "rate_limit_error", message: "gateway_concurrency_limit", code: "rate_limit_exceeded" } },
				),
			);
			return;
		}

		const planned = sawToolResult ? undefined : planToolCall(asked);
		const toolResult = sawToolResult ? toolResultText(list) : undefined;
		const answer = toolResult ? `工具返回：${toolResult.slice(0, 400)}` : FINAL;
		const reply = asked.includes("flaky")
			? `${REPLY} [${FLAKY_MARKER} after ${flakyFailures} injected 429s]`
			: REPLY;

		let events;
		if (pathname.endsWith("/messages")) {
			events = sawToolResult
				? anthropicText(answer)
				: planned
					? anthropicToolCall(planned.name, planned.input)
					: anthropicText(reply);
		} else if (responsesApi) {
			events = responseEvents(sawToolResult ? answer : reply);
		} else {
			events = sawToolResult
				? completionEvents(answer)
				: planned
					? completionToolCallEvents(planned.name, planned.input)
					: completionEvents(reply);
		}

		const pluginHeader = req.headers["x-steve-plugin"];
		console.log(
			`[mock] ${req.url} model=${payload.model} messages=${list.length} tools=${payload.tools?.length ?? 0} toolResult=${sawToolResult}${pluginHeader ? ` plugin-header=${pluginHeader}` : ""}`,
		);
		streamEvents(res, events);
	});
}).listen(PORT, "127.0.0.1", () => console.log(`[mock] listening on http://127.0.0.1:${PORT}/v1`));
