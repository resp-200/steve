#!/usr/bin/env node
// Verifies the `send_feishu_card` tool and where it is allowed to exist.
//
// The tool is built per run, not registered globally: a card answers the message
// that started the run, so a CLI session or a timer-triggered run must not have a
// tool that cannot work. These checks cover both halves:
//
//   A. the tool replies through the injected reply function, with the card the
//      builder produced (not raw model JSON)
//   B. failures are reported to the model as a failed result, not thrown — the
//      model can fix the body and retry, and a thrown error would end the turn
//   C. once a card is sent, nobody sends the same content again as text (the
//      host tracks this through onSent)
//
//   npm run build && node scripts/feishu-card-tool-test.mjs
import process from "node:process";
import { createSendCardTool } from "../dist/features/feishu-card-tool.js";

const checks = [];
const check = (name, passed, detail = "") => {
	checks.push({ name, passed });
	process.stderr.write(`  ${passed ? "✓" : "✗"} ${name}${passed || !detail ? "" : ` — ${detail}`}\n`);
};

const textOf = (result) => (result?.content ?? []).map((part) => part.text ?? "").join(" ");

/* ---------- A. happy path ---------- */

{
	const sent = [];
	let notified = 0;
	const tool = createSendCardTool({
		reply: async (card) => {
			sent.push(card);
		},
		onSent: () => {
			notified += 1;
		},
	});

	check("the tool is named send_feishu_card", tool.name === "send_feishu_card");
	check("the tool declares a schema", tool.parameters !== undefined);
	check("the tool is presented as a plain call", tool.metadata?.kind === "other");

	const result = await tool.execute("call-1", { body: "- 列表", title: "结果", theme: "green" }, undefined, undefined);
	check("the card reached the reply function", sent.length === 1, `${sent.length} replies`);
	check("the card is the built card, not raw JSON", sent[0]?.elements?.[0]?.tag === "markdown", JSON.stringify(sent[0]));
	check("the title came through", sent[0]?.header?.title?.content === "结果");
	check("onSent fired once", notified === 1, String(notified));

	// Code is the reason card 2.0 exists here: a fenced block in 1.0's markdown
	// element shows as literal backticks, so the tool must send 2.0 for code.
	const codeResult = await tool.execute("call-code", { body: "\`\`\`ts\nconst a = 1;\n\`\`\`", title: "代码" }, undefined, undefined);
	const codeCard = sent[1];
	check("含代码的卡片是 2.0", codeCard?.schema === "2.0", JSON.stringify(Object.keys(codeCard ?? {})));
	check("代码块是 code_block 元素", codeCard?.body?.elements?.some((element) => element.tag === "code_block"), JSON.stringify(codeCard?.body?.elements));
	check("含代码的卡片也被报告为已发送", textOf(codeResult).startsWith("Card sent"), textOf(codeResult));

	check("the model is told it was sent", textOf(result).startsWith("Card sent"), textOf(result));
	check("the model is told not to repeat it", textOf(result).includes("do not repeat"), textOf(result));
	check("the result is not an error", result.details?.ok === true);
}

/* ---------- B. failures are reported, not thrown ---------- */

{
	const sent = [];
	const tool = createSendCardTool({ reply: async (card) => void sent.push(card) });

	const empty = await tool.execute("call-2", { body: "   " }, undefined, undefined);
	check("an empty body is reported as not sent", textOf(empty).startsWith("Card not sent"), textOf(empty));
	check("an empty body sends nothing", sent.length === 0);
	check("the failure is marked in details", empty.details?.ok === false);
	check("the model learns what was wrong", textOf(empty).includes("must not be empty"), textOf(empty));

	let notified = 0;
	const failing = createSendCardTool({
		reply: async () => {
			throw new Error("Feishu said no");
		},
		onSent: () => {
			notified += 1;
		},
	});
	const failed = await failing.execute("call-3", { body: "x" }, undefined, undefined);
	check("a transport failure is reported, not thrown", textOf(failed).includes("Feishu said no"), textOf(failed));
	check("a failed send does not count as sent", notified === 0, String(notified));
}

/* ---------- C. the host's reply bookkeeping ---------- */

{
	// The entry skips its own text reply once onSent has fired; a failed card
	// must leave the flag alone, or the user would get no reply at all.
	let cardSent = false;
	const ok = createSendCardTool({
		reply: async () => {},
		onSent: () => {
			cardSent = true;
		},
	});
	const refused = createSendCardTool({
		reply: async () => {
			throw new Error("nope");
		},
		onSent: () => {
			cardSent = true;
		},
	});

	await refused.execute("call-4", { body: "x" }, undefined, undefined);
	check("a failed card leaves the host free to send text", cardSent === false);
	await ok.execute("call-5", { body: "x" }, undefined, undefined);
	check("a sent card tells the host to stay quiet", cardSent === true);
}

/* ---------- summary ---------- */

const failed = checks.filter((item) => !item.passed);
process.stderr.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
if (failed.length > 0) process.exitCode = 1;
