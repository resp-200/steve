#!/usr/bin/env node
// Keeps the copy of the ACP HTTP client that is inlined into
// test-acp-jsonrpc.html in sync with the canonical module
// (web/acp-http-client.js).
//
//   node scripts/sync-ui-client.mjs          # rewrite the inlined block
//   node scripts/sync-ui-client.mjs --check  # fail when it is out of date
//
// The page needs a copy because browsers refuse to load ES modules from
// file:// URLs, and "just open the HTML" should work.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = new URL("../", import.meta.url);
const MODULE_PATH = fileURLToPath(new URL("web/acp-http-client.js", ROOT));
const HTML_PATH = fileURLToPath(new URL("test-acp-jsonrpc.html", ROOT));

const BEGIN = "    <!-- BEGIN GENERATED from web/acp-http-client.js (npm run acp:ui-sync) -->";
const END = "    <!-- END GENERATED -->";

/** Strips ESM syntax and exposes the API on `window` so a classic script can use it. */
function buildInlineBlock(source) {
	const body = source
		.replace(/^export default .*$/gm, "")
		.replace(/^export (const|class|function|let) /gm, "$1 ")
		.replace(/^export \{[^}]*\};?$/gm, "")
		.trimEnd();

	const bridge = [
		"",
		"    // Classic-script bridge: the page (and file:// users) read the API from here.",
		"    window.ACP = { AcpHttpClient, AcpRequestError, PROTOCOL_VERSION, HEADER_CONNECTION_ID, HEADER_SESSION_ID, messageKey };",
	].join("\n");

	const indented = [body, bridge]
		.join("\n")
		.split("\n")
		.map((line) => (line.trim().length === 0 ? "" : `    ${line}`))
		.join("\n");

	return [BEGIN, "    <script>", "    (() => {", indented, "    })();", "    </script>", END].join("\n");
}

function main() {
	const source = readFileSync(MODULE_PATH, "utf8");
	const block = buildInlineBlock(source);
	const html = readFileSync(HTML_PATH, "utf8");

	const start = html.indexOf(BEGIN);
	const end = html.indexOf(END);
	if (start === -1 || end === -1) throw new Error(`markers not found in ${HTML_PATH}`);

	const current = html.slice(start, end + END.length);
	const updated = html.slice(0, start) + block + html.slice(end + END.length);

	if (current === block) {
		process.stderr.write("inlined ACP client is up to date\n");
		return;
	}
	if (process.argv.includes("--check")) {
		process.stderr.write("inlined ACP client is stale — run `npm run acp:ui-sync`\n");
		process.exitCode = 1;
		return;
	}
	writeFileSync(HTML_PATH, updated);
	process.stderr.write(`updated the inlined ACP client in ${HTML_PATH}\n`);
}

main();
