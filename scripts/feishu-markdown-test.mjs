/**
 * Feishu message formatting rules: markdown detection, post body, plain fallback,
 * and splitting. Pure functions — no server, no network.
 */
import { strict as assert } from "node:assert";

const checks = [];
function check(name, fn) {
	try {
		fn();
		checks.push({ name, passed: true });
		process.stdout.write(`  ✓ ${name}\n`);
	} catch (error) {
		checks.push({ name, passed: false, error });
		process.stdout.write(`  ✗ ${name} — ${error instanceof Error ? error.message : String(error)}\n`);
	}
}

const { MAX_MESSAGE_CHARS, buildPostContent, looksLikeMarkdown, splitMessage, stripMarkdown } = await import(
	"../dist/model/feishu-markdown.js"
);

/* ------------------------- A. markdown detection ------------------------ */

check("表格被认成 markdown", () => {
	assert.equal(looksLikeMarkdown("| 列一 | 列二 |\n| --- | --- |\n| a | 1 |"), true);
});
check("标题被认成 markdown", () => assert.equal(looksLikeMarkdown("## 标题"), true));
check("无序列表被认成 markdown", () => assert.equal(looksLikeMarkdown("- 一条"), true));
check("有序列表被认成 markdown", () => assert.equal(looksLikeMarkdown("1. 一条"), true));
check("代码块被认成 markdown", () => assert.equal(looksLikeMarkdown("```ts\nconst a = 1;\n```"), true));
check("行内代码被认成 markdown", () => assert.equal(looksLikeMarkdown("用 `npm test` 跑"), true));
check("粗体被认成 markdown", () => assert.equal(looksLikeMarkdown("**重点**"), true));
check("链接被认成 markdown", () => assert.equal(looksLikeMarkdown("见 [文档](https://example.com)"), true));
check("引用被认成 markdown", () => assert.equal(looksLikeMarkdown("> 引用"), true));
check("纯中文散文不是 markdown", () => assert.equal(looksLikeMarkdown("已经改好了，测试也过了。"), false));
check("英文散文不是 markdown", () => assert.equal(looksLikeMarkdown("Done. Tests pass."), false));
check("单个星号不触发 markdown", () => assert.equal(looksLikeMarkdown("2 * 3 = 6"), false));
check("行内提及井号不触发 markdown", () => assert.equal(looksLikeMarkdown("这是 #1 条"), false));

/* --------------------------- B. post body ------------------------------- */

check("无代码块：整个内容一个 md 元素", () => {
	const post = buildPostContent("## 标题\n\n正文");
	assert.equal(post.zh_cn.content.length, 1);
	assert.deepEqual(post.zh_cn.content[0], [{ tag: "md", text: "## 标题\n\n正文" }]);
});
check("有代码块：围栏单独成行", () => {
	const post = buildPostContent("先看这段：\n\n```ts\nconst a = 1;\n```\n\n然后再看结论。");
	assert.equal(post.zh_cn.content.length, 3);
	assert.equal(post.zh_cn.content[1][0].text, "```ts\nconst a = 1;\n```");
});
check("行首行尾空白被去掉", () => {
	const post = buildPostContent("\n\n  正文  \n\n");
	assert.equal(post.zh_cn.content[0][0].text, "正文");
});
check("空文本也产出一个合法 post", () => {
	const post = buildPostContent("   ");
	assert.equal(post.zh_cn.content.length, 1);
});
check("所有元素都是 md 标签", () => {
	const post = buildPostContent("# 标题\n\n```\ncode\n```\n\n尾巴");
	for (const row of post.zh_cn.content) for (const element of row) assert.equal(element.tag, "md");
});

/* ------------------------- C. plain fallback ---------------------------- */

check("标题符号被去掉", () => assert.equal(stripMarkdown("## 标题"), "标题"));
check("粗体符号被去掉", () => assert.equal(stripMarkdown("**重点**"), "重点"));
check("行内代码反引号被去掉", () => assert.equal(stripMarkdown("用 `npm test` 跑"), "用 npm test 跑"));
check("代码块的围栏被去掉但代码保留", () => {
	const plain = stripMarkdown("```ts\nconst a = 1;\n```");
	assert.equal(plain, "const a = 1;");
});
check("表格保留内容、去掉竖线与分隔行", () => {
	const plain = stripMarkdown("| 列一 | 列二 |\n| --- | --- |\n| a | 1 |");
	assert.equal(plain, "列一  列二\na  1");
});
check("链接保留链接地址", () => assert.equal(stripMarkdown("[文档](https://example.com)"), "文档 (https://example.com)"));
check("相同文字与地址的链接只留一份", () => assert.equal(stripMarkdown("[https://example.com](https://example.com)"), "https://example.com"));
check("引用符号被去掉", () => assert.equal(stripMarkdown("> 引用"), "引用"));
check("删除线被去掉", () => assert.equal(stripMarkdown("~~废弃~~"), "废弃"));
check("连续空行被压缩", () => assert.equal(stripMarkdown("a\n\n\n\nb"), "a\n\nb"));

/* ---------------------------- D. splitting ------------------------------ */

check("短消息不切", () => assert.deepEqual(splitMessage("就一句话"), ["就一句话"]));
check("空消息返回一个空块", () => assert.deepEqual(splitMessage("   "), [""]));
check("超长消息被切", () => {
	const chunks = splitMessage("字".repeat(MAX_MESSAGE_CHARS + 500));
	assert.equal(chunks.length, 2);
});
check("每块都不超过上限", () => {
	const chunks = splitMessage("字".repeat(MAX_MESSAGE_CHARS * 3));
	for (const chunk of chunks) assert.ok(chunk.length <= MAX_MESSAGE_CHARS, `${chunk.length} > ${MAX_MESSAGE_CHARS}`);
});
check("多块带 (1/N) 标号", () => {
	const chunks = splitMessage("字".repeat(MAX_MESSAGE_CHARS + 500));
	assert.ok(chunks[0].endsWith("(1/2)"), chunks[0].slice(-12));
	assert.ok(chunks[1].endsWith("(2/2)"), chunks[1].slice(-12));
});
check("优先在换行处切", () => {
	const line = "这是一行内容".repeat(10);
	const body = Array.from({ length: 200 }, () => line).join("\n");
	const chunks = splitMessage(body, 500);
	assert.ok(chunks[0].includes("\n"), "第一块里应当有换行");
	assert.ok(!chunks[0].slice(0, -8).endsWith("\n"));
});
check("跨块的代码块会重新围栏", () => {
	const body = `开头。\n\n\`\`\`js\n${Array.from({ length: 60 }, (_, index) => `const v${index} = ${index};`).join("\n")}\n\`\`\`\n\n结尾。`;
	const chunks = splitMessage(body, 400);
	assert.ok(chunks.length >= 2);
	assert.ok(chunks[1].startsWith("```js"), chunks[1].slice(0, 12));
});
check("每个代码块都闭合", () => {
	const body = `\`\`\`js\n${Array.from({ length: 60 }, (_, index) => `const v${index} = ${index};`).join("\n")}\n\`\`\`\n\n尾。`;
	const chunks = splitMessage(body, 400);
	for (const chunk of chunks) {
		const fences = chunk.split("\n").filter((line) => line.trim().startsWith("```")).length;
		assert.equal(fences % 2, 0, `未闭合：${chunk.slice(0, 40)}`);
	}
});
check("跨块的表格重复表头", () => {
	const header = "| 编号 | 内容 |\n| --- | --- |";
	const rows = Array.from({ length: 40 }, (_, index) => `| ${index} | 一行内容 |`);
	const chunks = splitMessage([header, ...rows].join("\n"), 300);
	assert.ok(chunks.length >= 2);
	assert.ok(chunks[1].includes("| 编号 | 内容 |"), chunks[1].slice(0, 40));
});
check("长文结尾不会被截掉", () => {
	const body = `${"字".repeat(MAX_MESSAGE_CHARS)}\n\n## 结论\n\n最后一句话。`;
	const chunks = splitMessage(body);
	assert.ok(chunks.at(-1).includes("最后一句话。"), chunks.at(-1).slice(-20));
});

const failed = checks.filter((entry) => !entry.passed);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
if (failed.length > 0) {
	process.stderr.write(`failed:\n${failed.map((entry) => `  - ${entry.name}`).join("\n")}\n`);
	process.exit(1);
}
