// Observes the stream: logs every turn's stop reason and token usage, and tags
// provider requests with a trace header.
//
//   STEVE_EXTENSIONS=examples/extensions/turn-logger.mjs npm run dev
//
// Shows the two "observer" seams: normalised runtime events (`on("turn_end")`)
// and the synchronous `before_provider_headers` hook.

export default function turnLogger(pi) {
	pi.on("turn_end", (event) => {
		pi.ctx.log(`turn ${event.stopReason} · in/out ${event.usage.input}/${event.usage.output}${event.failed ? ` · failed: ${event.errorMessage}` : ""}`);
	});

	pi.on("before_provider_headers", (headers) => {
		headers["x-steve-plugin"] = "turn-logger";
	});
}
