#!/usr/bin/env node
// Verifies the web tools (features/web-tools.ts):
//
//   A. in-process: URL/scheme/credential policy, SSRF refusal table (IPv4,
//      IPv6, mapped IPv6, hostnames), HTML→markdown, provider formatting and
//      provider selection
//   B. against a local HTTP server: fetch, redirects (same origin ok, cross
//      origin refused), size/charset/content-type handling, timeouts
//   C. the plugin: `web_fetch` always registers, `web_search` only with a key
//
//   npm run build && node scripts/web-tools-test.mjs
//
// Nothing here touches the public internet: the local server stands in for a
// website, and `resolveHost` is pinned so the SSRF checks are deterministic.
import { createServer } from "node:http";
import { spam } from "node:console"; // eslint-disable-line -- unused, kept out below
import process from "node:process";

const checks = [];
const check = (name, passed, detail = "") => {
	checks.push({ name, passed });
	process.stderr.write(`  ${passed ? "✓" : "✗"} ${name}${passed || !detail ? "" : ` — ${detail}`}\n`);
};

const failure = async (call) => {
	try {
		await call();
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
};

/* ----------------------- A. policy, in process -------------------------- */

async function policyChecks() {
	const web = await import("../dist/features/web-tools.js");

	check("只有 http(s) 能抓", (await failure(() => web.validateFetchUrl("file:///etc/passwd"))).includes("Only http and https"));
	check("file: 被拒绝", (await failure(() => web.validateFetchUrl("file:///etc/passwd"))).length > 0);
	check("URL 内嵌凭据被拒绝", (await failure(() => web.validateFetchUrl("https://user:pw@example.com/"))).includes("credentials"));
	check("相对 URL 被拒绝", (await failure(() => web.validateFetchUrl("/api/x"))).length > 0);
	check("超长 URL 被拒绝", (await failure(() => web.validateFetchUrl(`https://example.com/${"a".repeat(5000)}`))).includes("4096"));
	check("正常 https URL 通过", web.validateFetchUrl("https://example.com/a?b=1").host === "example.com");

	// --- SSRF: the table is the point, so every family gets a row -------------
	const privateIps = [
		"127.0.0.1", "127.1.2.3", "10.0.0.1", "172.16.0.1", "172.31.255.255",
		"192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
		"::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254",
	];
	const publicIps = ["8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "11.0.0.1", "2606:4700::1111", "::ffff:8.8.8.8"];
	const missed = privateIps.filter((ip) => !web.isPrivateAddress(ip));
	const overblocked = publicIps.filter((ip) => web.isPrivateAddress(ip));
	check("内网/回环/链路本地 IP 一律判私有（含 169.254.169.254 与 IPv4-mapped IPv6）", missed.length === 0, missed.join(","));
	check("公网 IP 不被误判（172.15/172.32 边界）", overblocked.length === 0, overblocked.join(","));

	const resolvingTo = (addresses) => async () => addresses;
	const localhostMsg = await failure(() => web.assertPublicHost(new URL("http://localhost/"), resolvingTo(["10.0.0.1"])));
	check("localhost 直接拒绝（连解析都不做）", localhostMsg.includes("not a public hostname"), localhostMsg);
	const metaMsg = await failure(() => web.assertPublicHost(new URL("https://evil.example.com/"), resolvingTo(["169.254.169.254"])));
	check("解析到元数据地址被拒绝", metaMsg.includes("resolves to a private address"), metaMsg);
	const mixedMsg = await failure(() => web.assertPublicHost(new URL("https://mixed.example.com/"), resolvingTo(["8.8.8.8", "127.0.0.1"])));
	check("混合解析结果（公网+内网）整体拒绝", mixedMsg.includes("127.0.0.1"), mixedMsg);
	check("解析到公网放行", (await failure(() => web.assertPublicHost(new URL("https://ok.example.com/"), resolvingTo(["8.8.8.8"])))).length === 0);
	check("字面量内网 IP 被拒绝", (await failure(() => web.assertPublicHost(new URL("http://10.1.2.3/"), resolvingTo([])))).includes("private address"));
	check("DNS 解析失败给出可读错误", (await failure(() => web.assertPublicHost(new URL("https://nope.example.com/"), async () => { throw new Error("ENOTFOUND"); }))).includes("Could not resolve"));

	// --- HTML → markdown ------------------------------------------------------
	const md = (html) => web.htmlToMarkdown(html, "https://example.com/dir/page");
	check("标题转 #", md("<h2>Hello</h2>") === "## Hello", md("<h2>Hello</h2>"));
	check("段落与加粗", md("<p>a <b>b</b> c</p>") === "a **b** c", md("<p>a <b>b</b> c</p>"));
	check("相对链接按 base 解析", md('<p><a href="../x">go</a></p>') === "[go](https://example.com/x)", md('<p><a href="../x">go</a></p>'));
	check("javascript: 链接只留文字", md('<p><a href="javascript:alert(1)">x</a></p>') === "x", md('<p><a href="javascript:alert(1)">x</a></p>'));
	check("无序列表合并成紧凑列表", md("<ul><li>a</li><li>b</li></ul>") === "- a\n- b", JSON.stringify(md("<ul><li>a</li><li>b</li></ul>")));
	check("有序列表编号递增", md("<ol><li>a</li><li>b</li></ol>") === "1. a\n2. b", JSON.stringify(md("<ol><li>a</li><li>b</li></ol>")));
	check("代码块保留原文且只套一层围栏", md("<pre><code>a\n  b</code></pre>") === "```\na\n  b\n```", JSON.stringify(md("<pre><code>a\n  b</code></pre>")));
	check("表格按行拼接单元格", md("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>") === "A | B\n\n1 | 2", JSON.stringify(md("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>")));
	check("script/style/head 不泄漏", md("<head><title>T</title></head><body><script>var x=1</script><style>.a{}</style><p>keep</p></body>") === "keep");
	check("实体解码", md("<p>&amp; &lt; &gt; &nbsp; &#65;</p>") === "& < > A", md("<p>&amp; &lt; &gt; &nbsp; &#65;</p>"));
	check("未闭合标签不抛错", md("<div><p>a <b>bold<p>b").includes("a **bold**"), md("<div><p>a <b>bold<p>b"));
	check("超深嵌套降级成纯文本而不挂", md(`${"<div>".repeat(2000)}deep${"</div>".repeat(2000)}`) === "deep");
	check("空文档不抛错", md("") === "");

	// --- formatting / provider selection -------------------------------------
	const outcome = {
		answer: "The answer is 42.",
		sources: [
			{ url: "https://a.example.com/1", title: "First", snippet: "about 42", publishedAt: "2025-01-02" },
			{ url: "https://b.example.com/2" },
		],
		truncated: true,
	};
	const text = web.formatSearchOutput("q", outcome);
	check("搜索结果带 markdown 链接", text.includes("[First](https://a.example.com/1)"));
	check("无标题的来源用 hostname 兜底", text.includes("[b.example.com](https://b.example.com/2)"));
	check("截断时提示收窄查询", text.includes("Refine the query"));
	check("末尾要求引用来源", text.trimEnd().endsWith("Cite the relevant URLs above as markdown links in your answer."));
	check("无结果时说搜不到", web.formatSearchOutput("q", { sources: [], truncated: false }).startsWith('No results found for "q".'));

	check("搜索上限默认 8、天花板 20", web.WEB_SEARCH_MAX_RESULTS === 8 && web.WEB_SEARCH_RESULT_CEILING === 20);
	check("抓取输出上限 200 000 字符", web.WEB_FETCH_MAX_OUTPUT_CHARS === 200_000);

	// Provider selection is pure env inspection, so no network is involved.
	check("没有 key 时不给搜索工具", web.resolveSearchProvider({}) === undefined);
	check("有 key 时选中对应 provider", web.resolveSearchProvider({ TAVILY_API_KEY: "k" })?.id === "tavily");
	check("WEB_SEARCH_PROVIDER 可显式指定", web.resolveSearchProvider({ EXA_API_KEY: "k", WEB_SEARCH_PROVIDER: "exa" })?.id === "exa");
	const warnings = [];
	const unknown = web.resolveSearchProvider({ BRAVE_API_KEY: "k", WEB_SEARCH_PROVIDER: "bing" }, (m) => warnings.push(m));
	check("未知 provider 说明并继续", unknown === undefined && warnings.some((m) => m.includes("unknown")), warnings.join(";"));
	check("没有 provider 时只注册 web_fetch", web.createWebTools({}).map((t) => t.name).join(",") === "web_fetch");
	const both = web.createWebTools({ provider: web.tavilyProvider });
	check("有 provider 时两个工具都在", both.map((t) => t.name).join(",") === "web_search,web_fetch");
	check("两个工具都不需要审批", both.every((tool) => tool.permission === "auto"));
}

/* -------------------- B. fetch against a local server ------------------- */

async function serve() {
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const path = url.pathname;
		if (path === "/page") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end("<html><body><h1>Title</h1><p>Hello <b>world</b></p></body></html>");
			return;
		}
		if (path === "/plain") {
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("plain text body");
			return;
		}
		if (path === "/greek") {
			response.writeHead(200, { "content-type": "text/plain; charset=iso-8859-7" });
			response.end(Buffer.from([0xe1, 0xe2, 0xe3]));
			return;
		}
		if (path === "/binary") {
			response.writeHead(200, { "content-type": "application/pdf" });
			response.end("%PDF-1.4");
			return;
		}
		if (path === "/big") {
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("x".repeat(50_000));
			return;
		}
		if (path === "/same-origin") {
			response.writeHead(302, { location: "/page" });
			response.end();
			return;
		}
		if (path === "/cross-origin") {
			response.writeHead(302, { location: "http://example.com/elsewhere" });
			response.end();
			return;
		}
		if (path === "/loop") {
			response.writeHead(302, { location: "/loop" });
			response.end();
			return;
		}
		if (path === "/missing") {
			response.writeHead(404, { "content-type": "text/plain" });
			response.end("nope");
			return;
		}
		if (path === "/slow") {
			setTimeout(() => {
				response.writeHead(200, { "content-type": "text/plain" });
				response.end("late");
			}, 2_000);
			return;
		}
		response.writeHead(500, { "content-type": "text/plain" });
		response.end("unknown path");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return { server, origin: `http://127.0.0.1:${port}` };
}

async function fetchChecks(origin) {
	const web = await import("../dist/features/web-tools.js");
	// The local server IS a private address, so these checks opt in explicitly —
	// that is the same switch production never sets.
	const opts = { allowPrivateHosts: true, timeoutMs: 3_000 };

	const page = await web.fetchUrl(`${origin}/page`, opts);
	check("抓取 HTML 转成 markdown", page.text === "# Title\n\nHello **world**", JSON.stringify(page.text));
	check("抓取结果记录状态码与类型", page.status === 200 && page.contentType.startsWith("text/html"));
	check("抓取输出带出处头", web.formatFetchOutput(page).startsWith(`Fetched ${origin}/page (HTTP 200`));

	const plain = await web.fetchUrl(`${origin}/plain`, opts);
	check("纯文本原样返回", plain.text === "plain text body", plain.text);
	check("非 UTF-8 按 charset 解码", (await web.fetchUrl(`${origin}/greek`, opts)).text === "αβγ");

	check("二进制类型被拒绝", (await failure(() => web.fetchUrl(`${origin}/binary`, opts))).includes("web_fetch reads HTML and text only"));
	check("404 给出状态码", (await failure(() => web.fetchUrl(`${origin}/missing`, opts))).includes("HTTP 404"));

	const big = await web.fetchUrl(`${origin}/big`, { ...opts, maxOutputChars: 100 });
	check("输出按字符上限截断并标注", big.truncated && big.text.length === 100);
	check("截断时附带提示", web.formatFetchOutput(big).includes("Content truncated"));

	const redirected = await web.fetchUrl(`${origin}/same-origin`, opts);
	check("同源重定向被跟随", redirected.url.endsWith("/page") && redirected.text.includes("# Title"));
	check("跨域重定向被拒绝", (await failure(() => web.fetchUrl(`${origin}/cross-origin`, opts))).includes("another origin"));
	check("重定向环路被截断", (await failure(() => web.fetchUrl(`${origin}/loop`, opts))).includes("redirects"));
	check("超时给出可读错误", (await failure(() => web.fetchUrl(`${origin}/slow`, { ...opts, timeoutMs: 150 }))).includes("timed out"));

	// SSRF end to end: the same URL that works with the switch on must fail with it off.
	check("默认拒绝内网地址（即使服务真的在跑）", (await failure(() => web.fetchUrl(`${origin}/page`, { timeoutMs: 3_000 }))).includes("Private-network"));
}

/* --------------------------- C. the plugin ------------------------------ */

async function pluginChecks() {
	const { webTools } = await import("../dist/extensions/builtin/web-tools.js");
	const load = async (env) => {
		const saved = {};
		for (const key of ["WEB_SEARCH_PROVIDER", "TAVILY_API_KEY", "EXA_API_KEY", "BRAVE_API_KEY"]) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		Object.assign(process.env, env);
		const tools = [];
		webTools({ ctx: { log: () => {} }, registerTool: (tool) => tools.push(tool) });
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		return tools.map((tool) => tool.name).sort().join(",");
	};
	check("无 key：插件只注册 web_fetch", (await load({})) === "web_fetch");
	check("有 key：插件注册两个工具", (await load({ TAVILY_API_KEY: "k" })) === "web_fetch,web_search");
}

/* -------------------------------- run ---------------------------------- */

const { server, origin } = await serve();
try {
	await policyChecks();
	await fetchChecks(origin);
	await pluginChecks();
} finally {
	server.close();
}

const failed = checks.filter((entry) => !entry.passed);
process.stderr.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
if (failed.length > 0) {
	process.stderr.write(`failed:\n${failed.map((entry) => `  - ${entry.name}`).join("\n")}\n`);
	process.exit(1);
}
