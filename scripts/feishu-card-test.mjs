#!/usr/bin/env node
// Verifies the Feishu card builder (model/feishu-card.ts).
//
// The model never sends raw card JSON — that is the whole point of this module:
// a wrong nesting is a card Feishu refuses, and the user just sees no reply.
// So the checks below are about what must always hold, not about layout taste:
//
//   A. a minimal card is valid and markdown is passed through untouched
//   B. the header appears only when there is a title, and colours are whitelisted
//   C. bad input fails loudly (empty body, oversized body) instead of sending
//      something blank; title length is clamped rather than rejected
//
//   npm run build && node scripts/feishu-card-test.mjs
import process from "node:process";
import { CARD_THEMES, MAX_CARD_BODY_CHARS, buildFeishuCard } from "../dist/model/feishu-card.js";

const checks = [];
const check = (name, passed, detail = "") => {
	checks.push({ name, passed });
	process.stderr.write(`  ${passed ? "✓" : "✗"} ${name}${passed || !detail ? "" : ` — ${detail}`}\n`);
};

/* ---------- A. minimal card ---------- */

{
	const card = buildFeishuCard({ body: "**加粗**\n\n- 列表" });
	check("a body alone produces a card", Array.isArray(card.elements) && card.elements.length === 1);
	check("markdown is passed through verbatim", card.elements[0].content === "**加粗**\n\n- 列表", String(card.elements[0].content));
	check("the element is markdown", card.elements[0].tag === "markdown");
	check("no header without a title", card.header === undefined, JSON.stringify(card.header));
	check("wide screen is on", card.config.wide_screen_mode === true);
	check("body whitespace is trimmed", buildFeishuCard({ body: "\n  回答  \n" }).elements[0].content === "回答");
	check("the card is JSON-serialisable", typeof JSON.stringify(buildFeishuCard({ body: "x" })) === "string");
}

/* ---------- A2. fenced code ---------- */

{
	// A fence inside a card's `markdown` element arrives as literal backticks, so
	// each fenced run has to become a code_block element of its own.
	const card = buildFeishuCard({ body: "先说明。\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n\n**复杂度**：O(n²)" });
	check("围栏代码块被拆成独立元素", card.elements.length === 3, JSON.stringify(card.elements).slice(0, 200));
	check("代码块元素是 code_block", card.elements[1]?.tag === "code_block", String(card.elements[1]?.tag));
	check("代码块的语言被保留", card.elements[1]?.language === "typescript", String(card.elements[1]?.language));
	check("代码块正文不含围栏", card.elements[1]?.text === "const a = 1;", String(card.elements[1]?.text));
	check("代码块前后的说明仍是 markdown", card.elements[0]?.content === "先说明。" && card.elements[2]?.content.includes("复杂度"));

	const alias = buildFeishuCard({ body: "\`\`\`js\nx()\n\`\`\`" });
	check("语言别名归一化", alias.elements[0]?.language === "javascript", String(alias.elements[0]?.language));

	const unknown = buildFeishuCard({ body: "\`\`\`nonsense\nx\n\`\`\`" });
	check("未知语言回落 plaintext", unknown.elements[0]?.language === "plaintext", String(unknown.elements[0]?.language));

	const noLanguage = buildFeishuCard({ body: "\`\`\`\nx\n\`\`\`" });
	check("无语言标记也能识别", noLanguage.elements[0]?.tag === "code_block" && noLanguage.elements[0]?.language === "plaintext", String(noLanguage.elements[0]?.tag));

	const twoBlocks = buildFeishuCard({ body: "\`\`\`go\na\n\`\`\`\n\n中间\n\n\`\`\`sql\nb\n\`\`\`" });
	check("多个代码块各自成元素", twoBlocks.elements.filter((element) => element.tag === "code_block").length === 2, JSON.stringify(twoBlocks.elements.map((element) => element.tag)));
	check("代码块之间的散文保留", twoBlocks.elements.some((element) => element.tag === "markdown" && element.content === "中间"), JSON.stringify(twoBlocks.elements.map((element) => element.tag)));

	const unclosed = buildFeishuCard({ body: "前言\n\`\`\`ts\nconst a = 1;" });
	check("没闭合的围栏不会吞掉整篇", unclosed.elements.length === 1 && unclosed.elements[0]?.tag === "markdown", JSON.stringify(unclosed.elements.map((element) => element.tag)));

	const noFence = buildFeishuCard({ body: "- 列表\n- **粗体**" });
	check("没有围栏时仍是一个 markdown 元素", noFence.elements.length === 1 && noFence.elements[0]?.tag === "markdown");
}

/* ---------- B. header ---------- */

{
	const card = buildFeishuCard({ body: "x", title: "结果", theme: "green" });
	check("a title produces a header", card.header !== undefined);
	check("the title is plain text", card.header.title.tag === "plain_text");
	check("the title is kept", card.header.title.content === "结果");
	check("the colour is kept", card.header.template === "green");

	const fallback = buildFeishuCard({ body: "x", title: "结果", theme: "chartreuse" });
	check("an unknown colour falls back instead of failing", fallback.header?.template === "blue", String(fallback.header?.template));

	const noTheme = buildFeishuCard({ body: "x", title: "结果" });
	check("a title without a colour gets the default", noTheme.header?.template === "blue");

	check("a blank title means no header", buildFeishuCard({ body: "x", title: "   " }).header === undefined);
	check("every documented colour is accepted", CARD_THEMES.every((theme) => buildFeishuCard({ body: "x", title: "t", theme })?.header?.template === theme));

	const longTitle = "标".repeat(500);
	const clamped = buildFeishuCard({ body: "x", title: longTitle });
	check("an oversized title is clamped, not rejected", (clamped.header?.title?.content?.length ?? 0) <= 100, String(clamped.header?.title?.content?.length));
}

/* ---------- C. bad input ---------- */

{
	let empty = "";
	try {
		buildFeishuCard({ body: "   \n  " });
	} catch (error) {
		empty = error instanceof Error ? error.message : String(error);
	}
	check("an empty body is refused", empty.includes("must not be empty"), empty);

	let oversized = "";
	try {
		buildFeishuCard({ body: "x".repeat(MAX_CARD_BODY_CHARS + 1) });
	} catch (error) {
		oversized = error instanceof Error ? error.message : String(error);
	}
	check("an oversized body is refused", oversized.includes("too long"), oversized);

	const atLimit = buildFeishuCard({ body: "x".repeat(MAX_CARD_BODY_CHARS) });
	check("a body exactly at the limit is accepted", atLimit.elements[0].content.length === MAX_CARD_BODY_CHARS);
}

/* ---------- summary ---------- */

const failed = checks.filter((item) => !item.passed);
process.stderr.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
if (failed.length > 0) process.exitCode = 1;
