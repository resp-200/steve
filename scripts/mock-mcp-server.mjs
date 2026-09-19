#!/usr/bin/env node
// A tiny MCP server over stdio, used by `scripts/mcp-test.mjs`.
//
// It speaks just enough of the protocol to be useful as a fixture:
//   initialize -> tools/list -> tools/call
// Tools: `echo` (text), `sum` (schema with two numbers), `fail` (isError), `image`.
const TOOLS = [
	{
		name: "echo",
		description: "Echo the given text back.",
		inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	},
	{
		name: "sum",
		description: "Add two numbers.",
		inputSchema: {
			type: "object",
			properties: { a: { type: "number" }, b: { type: "number" } },
			required: ["a", "b"],
		},
	},
	{
		name: "fail",
		description: "Always fails, to exercise the error path.",
		inputSchema: { type: "object", properties: {}, required: [] },
	},
	{
		name: "image",
		description: "Returns a 1x1 PNG.",
		inputSchema: { type: "object", properties: {}, required: [] },
	},
];

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

function callTool(name, args) {
	switch (name) {
		case "echo":
			return { content: [{ type: "text", text: `echo: ${args?.text ?? ""}` }] };
		case "sum":
			return { content: [{ type: "text", text: String(Number(args?.a ?? 0) + Number(args?.b ?? 0)) }] };
		case "fail":
			return { content: [{ type: "text", text: "this tool always fails" }], isError: true };
		case "image":
			return { content: [{ type: "image", data: PNG, mimeType: "image/png" }] };
		default:
			return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		if (!line) continue;

		const message = JSON.parse(line);
		if (message.method === "notifications/initialized") continue;
		if (message.id === undefined) continue;

		const reply = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
		const fail = (code, text) =>
			process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code, message: text } })}\n`);

		if (message.method === "initialize") {
			reply({
				protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "mock-mcp", version: "1.0.0" },
			});
			continue;
		}

		if (message.method === "tools/list") {
			reply({ tools: TOOLS });
			continue;
		}

		if (message.method === "tools/call") {
			const { name, arguments: args } = message.params ?? {};
			if (name === "crash") {
				process.exit(3);
			}
			reply(callTool(name, args));
			continue;
		}

		fail(-32601, `method not found: ${message.method}`);
	}
});

process.stdin.on("end", () => process.exit(0));
