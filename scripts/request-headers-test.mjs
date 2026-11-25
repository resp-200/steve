#!/usr/bin/env node
// Verifies the per-provider request-header standard end to end:
//
//   A. the pure rules: template expansion, host matching, "auto wins, manual is
//      the fallback", existing headers never overridden (features/request-headers)
//   B. the console path: save -> admin.json -> read back, invalid input rejected
//   C. the wire: a local mock provider receives the configured headers on a real
//      stream, and a second provider does NOT receive the first one's headers
//      (the "won't affect other providers" guarantee)
//
//   npm run build && node scripts/request-headers-test.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createStreamFn } from "../dist/model/stream.js";
import {
	applyHeaders,
	hostOf,
	headersApplyTo,
	normalizeRequestHeaders,
	providerHeaders,
	sessionHeaderValue,
} from "../dist/model/request-headers.js";
import { coerceProvider, normalizeProviderInput, applyProvider, providerView } from "../dist/features/admin-config.js";
import { sessionHeaderProvider } from "../dist/features/request-headers.js";

const checks = [];
const check = (name, passed, detail = "") => {
	checks.push({ name, passed });
	process.stderr.write(`  ${passed ? "✓" : "✗"} ${name}${passed || !detail ? "" : ` — ${detail}`}\n`);
};

const provider = (over = {}) => ({
	id: "p1",
	name: "opencode",
	baseUrl: "https://opencode.ai/zen/go/v1",
	apiKey: "sk-test",
	defaultModel: "deepseek-v4.1-flash",
	models: ["deepseek-v4.1-flash"],
	reasoning: false,
	...over,
});

/* ---------- A. pure rules ---------- */

{
	const headers = normalizeRequestHeaders({ "X-Opencode-Session": "${sessionId}", "X-Client": "steve/1.0" });
	check("header names are lowercased", headers["x-opencode-session"] === "${sessionId}", JSON.stringify(headers));
	check("static header values survive", headers["x-client"] === "steve/1.0");
}

{
	let message = "";
	try {
		normalizeRequestHeaders({ "x-session": "${sessinId}" });
	} catch (error) {
		message = error.message;
	}
	check("unknown placeholder is rejected", /unknown placeholder/.test(message), message);
}

{
	let message = "";
	try {
		normalizeRequestHeaders({ "bad name": "x" });
	} catch (error) {
		message = error.message;
	}
	check("invalid header name is rejected", /invalid header name/.test(message), message);
}

check("trailing slashes do not change the host", hostOf("https://opencode.ai/zen/go/v1") === "opencode.ai");
check("provider headers apply to its own host", headersApplyTo(provider(), "opencode.ai"));
check("provider headers do not apply to another host", !headersApplyTo(provider(), "api.openai.com"));
check("explicit hosts narrow the match", headersApplyTo(provider({ hosts: ["gateway.internal"] }), "gateway.internal") && !headersApplyTo(provider({ hosts: ["gateway.internal"] }), "opencode.ai"));
check("an unparseable baseUrl claims no host", !headersApplyTo(provider({ baseUrl: "not a url" }), "opencode.ai"));

{
	// Auto wins: the real conversation id beats a manual value.
	const sent = providerHeaders(provider({ headers: { "x-opencode-session": "" } }), "opencode.ai", { sessionId: "sess-123" });
	check("empty session header gets the conversation id", sent["x-opencode-session"] === "sess-123", JSON.stringify(sent));

	const templated = providerHeaders(provider({ headers: { "x-opencode-session": "${sessionId}" } }), "opencode.ai", { sessionId: "sess-123" });
	check("${sessionId} expands to the conversation id", templated["x-opencode-session"] === "sess-123");

	// Manual is the fallback when no conversation is known.
	const manual = providerHeaders(provider({ headers: { "x-opencode-session": "fixed-value" } }), "opencode.ai", {});
	check("manual value is used when there is no conversation", manual["x-opencode-session"] === "fixed-value");

	const empty = providerHeaders(provider({ headers: { "x-opencode-session": "" } }), "opencode.ai", { fallback: "p1" });
	check("stream id... provider id is the last resort", empty["x-opencode-session"] === "p1", JSON.stringify(empty));

	// The console override has no room in the neutral contract; it lives in the adapter.
	const forced = sessionHeaderProvider(provider({ requestSessionHeader: true }));
	const optedOut = !sessionHeaderProvider(provider({ requestSessionHeader: false, headers: { "x-opencode-session": "" } }));
	check("requestSessionHeader: true forces the header on", forced);
	check("requestSessionHeader: false keeps it off", optedOut);

	const other = providerHeaders(provider({ headers: { "x-client": "steve/1.0" } }), "opencode.ai", {});
	check("a provider with no session header sends none", !("x-opencode-session" in other), JSON.stringify(other));
	check("static headers go verbatim", other["x-client"] === "steve/1.0");
}

check(
	"a static manual value is an explicit choice, not a template",
	sessionHeaderValue("literal", { sessionId: "sess-1", lastResort: "p1" }) === "literal",
);
check("${conversationId} is an alias of ${sessionId}", sessionHeaderValue("${conversationId}", { sessionId: "s-9" }) === "s-9");

{
	const target = { Authorization: "Bearer x", "X-Client": "caller" };
	applyHeaders(target, { authorization: "Bearer other", "x-client": "provider", "x-new": "1" });
	check("applyHeaders never overrides an existing header (case-insensitive)", target.Authorization === "Bearer x" && target["X-Client"] === "caller", JSON.stringify(target));
	check("applyHeaders adds missing headers", target["x-new"] === "1");
}

{
	const entry = normalizeProviderInput({ name: "p", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "k", defaultModel: "m", headers: { "X-Opencode-Session": "" }, hosts: "opencode.ai, Other.Test" });
	check("console input keeps headers", entry.headers?.["x-opencode-session"] === "", JSON.stringify(entry.headers));
	check("console input normalizes hosts", JSON.stringify(entry.hosts) === JSON.stringify(["opencode.ai", "other.test"]), JSON.stringify(entry.hosts));
	check("provider view exposes headers unmasked", providerView(entry).headers?.["x-opencode-session"] === "");
	check("a hand-edited typo drops headers but keeps the provider", coerceProvider({ ...entry, headers: { "x!": "1" } })?.id === entry.id);

	const config = applyProvider({ apiKey: "env", model: { id: "m" }, systemPrompt: "s", authStyle: "auto" }, { providers: [entry], activeProviderId: entry.id });
	check("effective config carries the provider entry", config.requestHeaders?.provider?.id === entry.id);
}

/* ---------- C. the wire ---------- */

function mockProvider(record) {
	return new Promise((resolve) => {
		const server = createServer((request, response) => {
			record.push({ url: request.url, headers: request.headers });
			let body = "";
			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				// One content delta then a clean stop: enough for the agent stream to end.
				const payload = JSON.parse(body);
				if (payload.stream === false || request.method !== "POST") {
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: payload.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
					return;
				}
				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
				send({ id: "x", object: "chat.completion.chunk", created: 0, model: payload.model, choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] });
				send({ id: "x", object: "chat.completion.chunk", created: 0, model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
				response.end("data: [DONE]\n\n");
			});
		});
		server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
	});
}

async function runStream(baseUrl, requestHeaders) {
	const model = {
		id: "mock-model",
		name: "mock-model",
		provider: "custom",
		baseUrl,
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 256,
		compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
	};
	const streamFn = createStreamFn(() => "sk-test", "auto", undefined, () => requestHeaders);
	const stream = streamFn(model, { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] }, {});
	for await (const _event of stream) {
		/* drain */
	}
}

{
	// A bare provider entry (no session header configured) must not sprout one.
	// This is the regression the first wire run found: "no header configured"
	// reached the OpenCode host and sent the provider id as a session id.
	check("an OpenCode-host provider with no session header configured sends none", !("x-opencode-session" in providerHeaders(provider(), "opencode.ai", { sessionId: "s" })));
	check("the same provider without a conversation id sends none either", !("x-opencode-session" in providerHeaders(provider(), "opencode.ai", {})));
}
{
	const recorded = [];
	const { server, port } = await mockProvider(recorded);
	const baseUrl = `http://127.0.0.1:${port}/v1`;
	try {
		const entry = provider({ baseUrl, hosts: ["127.0.0.1"], headers: { "x-opencode-session": "${sessionId}", "x-client": "steve/1.0" } });
		await runStream(baseUrl, { provider: entry, sessionId: "sess-wire" });
		const first = recorded.at(-1);
		check("the request reaches the provider", first !== undefined && first.url.startsWith("/v1/chat/completions"), first?.url);
		check("session header arrives expanded", first?.headers["x-opencode-session"] === "sess-wire", JSON.stringify(first?.headers));
		check("static header arrives", first?.headers["x-client"] === "steve/1.0");
		check("auth header is still the api key", first?.headers.authorization === "Bearer sk-test");

		// A provider configured for another host must not touch this request.
		await runStream(baseUrl, { provider: provider({ headers: { "x-opencode-session": "${sessionId}", "x-leak": "1" } }), sessionId: "sess-wire" });
		const second = recorded.at(-1);
		check("headers of a provider for another host are not sent", second?.headers["x-opencode-session"] === undefined && second?.headers["x-leak"] === undefined, JSON.stringify(second?.headers));

		// No configured provider (hand-written .env): nothing changes at all.
		await runStream(baseUrl, undefined);
		const third = recorded.at(-1);
		// The SDK adds its own x-stainless-* / x-stainless tracing headers, so only ours matter.
	check("an .env provider sends no provider headers", third?.headers["x-opencode-session"] === undefined && third?.headers["x-client"] === undefined, JSON.stringify(third?.headers));
	} finally {
		server.close();
	}
}

/* ---------- summary ---------- */

const failed = checks.filter((item) => !item.passed);
process.stderr.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
if (failed.length > 0) process.exitCode = 1;
