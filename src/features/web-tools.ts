/**
 * Web search / web fetch: the two read-only tools that let the model look things
 * up on the network.
 *
 * The capability lives here, the plugin shell lives in
 * `extensions/builtin/web-tools.ts` — the same split as the local tools, so an
 * entry point never learns a tool name or a provider's wire format.
 *
 * Three rules shape everything below:
 *
 *   1. **Providers are interchangeable.** A search provider turns a query into
 *      `{ answer?, sources[] }`; the tool owns the schema, the caps and the
 *      formatting, and knows no vendor. Adding one is a function in the table.
 *   2. **Caps belong to the product, not the model.** Source count, output
 *      characters and timeouts are options here; the model only asks a question.
 *   3. **A fetched URL is untrusted input that reaches the local network.**
 *      steve runs on the user's own machine — often inside a company intranet —
 *      so a private address is refused before a socket opens, including after
 *      every redirect (a public host that redirects to `169.254.169.254` is the
 *      classic way to read a cloud host's credentials).
 *
 * HTML→markdown is a deliberate hand-written converter: the project ships with
 * zero runtime dependencies, and the pages that matter (docs, blogs, issue
 * trackers, changelogs) use a small slice of HTML. When it cannot make sense of
 * a page it returns the text with the tags stripped, which degrades instead of
 * failing.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Type, type AgentTool } from "./contract.js";
import type { AnnotatedTool } from "./tool-annotations.js";

/* ------------------------------------------------------------------ */
/* Limits (product policy, not model arguments)                        */
/* ------------------------------------------------------------------ */

/** Sources one `web_search` returns by default; `8` matches DSH and OpenCode's Exa default. */
export const WEB_SEARCH_MAX_RESULTS = 8;
/** Hard ceiling on `maxResults`, whatever the model asks for. */
export const WEB_SEARCH_RESULT_CEILING = 20;
/** Characters of a fetched page handed to the model. */
export const WEB_FETCH_MAX_OUTPUT_CHARS = 200_000;
/** Bytes read off the wire before decoding stops. */
export const WEB_FETCH_MAX_BYTES = 5_000_000;
/** Redirect hops a `web_fetch` follows (same-origin only). */
export const WEB_FETCH_MAX_REDIRECTS = 3;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** One citeable search hit. */
export interface WebSource {
	url: string;
	title?: string;
	snippet?: string;
	publishedAt?: string;
}

/** What a search provider answers. */
export interface SearchOutcome {
	/** A provider-generated summary, when the provider makes one. */
	answer?: string;
	sources: WebSource[];
	/** True when the provider returned more than we asked for. */
	truncated: boolean;
}

export interface SearchProvider {
	/** Stable id, also the `WEB_SEARCH_PROVIDER` value. */
	id: string;
	/** Env var that must hold an API key. `undefined` for keyless providers. */
	apiKeyEnv?: string;
	search(query: string, maxResults: number, signal: AbortSignal): Promise<SearchOutcome>;
}

/** A fetched, decoded resource. */
export interface FetchOutcome {
	/** Final URL after allowed redirects. */
	url: string;
	status: number;
	/** The body as markdown (HTML) or verbatim (text). */
	text: string;
	contentType: string;
	/** True when a size or character cap cut the body. */
	truncated: boolean;
}

export interface WebToolOptions {
	/** Search provider to register; omit `web_search` entirely when unknown. */
	provider?: SearchProvider;
	/** Per-request timeout for both tools. Default: 30s. */
	timeoutMs?: number;
	/** Default `web_search` source count. Default: 8. */
	maxResults?: number;
	/** Cap on `web_fetch` output. Default: 200 000 characters. */
	maxOutputChars?: number;
	/** Allow private/loopback addresses (tests only). Default: false. */
	allowPrivateHosts?: boolean;
	/** DNS resolution override (tests point it at a local server). */
	resolveHost?: (host: string) => Promise<string[]>;
}

/** Errors a tool reports back to the model verbatim: they say what to do next. */
export class WebError extends Error {}

/* ------------------------------------------------------------------ */
/* URL hygiene + SSRF                                                  */
/* ------------------------------------------------------------------ */

const MAX_URL_LENGTH = 4_096;

/** `URL` for a safe http(s) URL; throws with a reason the model can act on. */
export function validateFetchUrl(input: string): URL {
	if (input.length > MAX_URL_LENGTH) throw new WebError(`URL exceeds ${MAX_URL_LENGTH} characters.`);
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new WebError(`"${input}" is not a valid URL.`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new WebError(`Only http and https URLs can be fetched, not "${url.protocol}".`);
	}
	if (url.username || url.password) throw new WebError("URLs with embedded credentials are refused.");
	return url;
}

/** A refusal is a policy decision, not a name-resolution failure. */
function blocked(reason: string): WebError {
	return new WebError(`${reason} Private-network addresses are not reachable through web_fetch.`);
}

/**
 * Whether an IP literal is private, loopback, link-local or otherwise not a
 * public internet address. Covers IPv4, IPv6 and IPv4-mapped IPv6.
 */
export function isPrivateAddress(ip: string): boolean {
	const version = isIP(ip);
	if (version === 4) return isPrivateV4(ip);
	if (version === 6) return isPrivateV6(ip);
	return false;
}

function isPrivateV4(ip: string): boolean {
	const [a = 0, b = 0] = ip.split(".").map(Number);
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 metadata
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
	if (a === 198 && (b === 18 || b === 19)) return true;
	if (a >= 224) return true; // multicast + reserved
	return false;
}

function isPrivateV6(raw: string): boolean {
	const address = raw.toLowerCase().split("%")[0] ?? "";
	if (address === "::" || address === "::1") return true;
	// An IPv4-mapped literal keeps its IPv4 policy: ::ffff:127.0.0.1 is loopback.
	const mapped = address.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped?.[1]) return isPrivateV4(mapped[1]);
	if (address.startsWith("fe80")) return true; // link-local
	if (address.startsWith("fc") || address.startsWith("fd")) return true; // unique local
	if (address.startsWith("ff")) return true; // multicast
	return false;
}

/**
 * Resolve a URL's host and refuse it when any address it maps to is not public.
 *
 * Resolving here (instead of letting `fetch` do it later) is what makes the check
 * meaningful: the addresses we inspect are the addresses the request would use.
 * A host that resolves to several addresses is refused if *any* of them is
 * private, because which one is dialled is not ours to choose.
 */
export async function assertPublicHost(url: URL, resolve: (host: string) => Promise<string[]>): Promise<void> {
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (isIP(host)) {
		if (isPrivateAddress(host)) throw blocked(`"${host}" is a private address.`);
		return;
	}
	if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw blocked(`"${host}" is not a public hostname.`);

	let addresses: string[];
	try {
		addresses = await resolve(host);
	} catch {
		throw new WebError(`Could not resolve "${host}".`);
	}
	if (addresses.length === 0) throw new WebError(`Could not resolve "${host}".`);
	for (const address of addresses) {
		if (isPrivateAddress(address)) throw blocked(`"${host}" resolves to a private address (${address}).`);
	}
}

/* ------------------------------------------------------------------ */
/* Fetch                                                               */
/* ------------------------------------------------------------------ */

/** Body kinds `web_fetch` renders. Anything else is refused before reading. */
export type BodyKind = "html" | "text";

export function classifyContentType(contentType: string | null): BodyKind | undefined {
	const mime = (contentType ?? "").replace(/;.*$/s, "").trim().toLowerCase();
	if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
	if (mime.startsWith("text/")) return "text";
	if (mime === "application/json" || mime === "application/xml" || mime.endsWith("+json") || mime.endsWith("+xml")) return "text";
	return undefined;
}

/** `charset=` from a Content-Type, for decoding non-UTF-8 pages. */
export function charsetOf(contentType: string | null): string | undefined {
	const match = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType ?? "");
	return match?.[1]?.toLowerCase();
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function isSameOrigin(a: URL, b: URL): boolean {
	return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;
}

/** Reads at most `limit` bytes; reports whether the body continued past it. */
async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	if (!response.body) return { bytes: new Uint8Array(), truncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			if (total + value.length > limit) {
				chunks.push(value.subarray(0, limit - total));
				truncated = true;
				break;
			}
			chunks.push(value);
			total += value.length;
		}
	} finally {
		if (truncated) await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	if (signal.aborted) throw signal.reason;
	const bytes = new Uint8Array(total + (truncated ? limit - total : 0));
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return { bytes, truncated };
}

/**
 * Fetch one URL: validate it, follow same-origin redirects only, cap the body,
 * decode it and render it. Every hop is re-validated, so a redirect cannot walk
 * the request into the local network.
 */
export async function fetchUrl(
	rawUrl: string,
	options: { timeoutMs?: number; maxOutputChars?: number; allowPrivateHosts?: boolean; resolveHost?: (host: string) => Promise<string[]> } = {},
): Promise<FetchOutcome> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const maxOutputChars = options.maxOutputChars ?? WEB_FETCH_MAX_OUTPUT_CHARS;
	const resolve = options.resolveHost ?? (async (host: string) => (await lookup(host, { all: true })).map((entry) => entry.address));
	const check = async (url: URL): Promise<void> => {
		if (!options.allowPrivateHosts) await assertPublicHost(url, resolve);
	};

	const signal = AbortSignal.timeout(timeoutMs);
	let url = validateFetchUrl(rawUrl);
	await check(url);

	for (let hop = 0; ; hop += 1) {
		const response = await fetch(url, {
			redirect: "manual",
			signal,
			headers: {
				// An honest identity: some hosts serve different content to unknown UAs.
				"user-agent": "steve/0.1 (+https://github.com/resp-200/steve)",
				accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5",
			},
		}).catch((error: unknown) => {
			if (signal.aborted) throw new WebError(`${url.href} timed out after ${timeoutMs}ms.`);
			throw new WebError(`Could not reach ${url.host}: ${error instanceof Error ? error.message : String(error)}`);
		});

		if (REDIRECT_STATUS.has(response.status)) {
			await response.body?.cancel().catch(() => undefined);
			const location = response.headers.get("location");
			if (!location) throw new WebError(`HTTP ${response.status} redirect from ${url.href} without a Location header.`);
			if (hop >= WEB_FETCH_MAX_REDIRECTS) throw new WebError(`Exceeded ${WEB_FETCH_MAX_REDIRECTS} redirects starting at ${rawUrl}.`);
			const next = new URL(location, url);
			// Cross-origin redirects are refused: each new origin should need a fresh
			// tool call, so the user's rule ("only this host") cannot be walked around.
			if (!isSameOrigin(url, next)) {
				throw new WebError(`${url.href} redirected to another origin (${next.origin}). Fetch that URL directly instead.`);
			}
			url = validateFetchUrl(next.href);
			await check(url);
			continue;
		}

		const contentType = response.headers.get("content-type");
		const kind = classifyContentType(contentType);
		if (!kind) {
			await response.body?.cancel().catch(() => undefined);
			throw new WebError(`${url.href} returned ${contentType ?? "an unknown content type"}; web_fetch reads HTML and text only.`);
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new WebError(`${url.href} returned HTTP ${response.status} ${response.statusText}.`.trim());
		}

		const { bytes, truncated: bodyCut } = await readBounded(response, WEB_FETCH_MAX_BYTES, signal);
		const decoded = decodeBody(bytes, charsetOf(contentType));
		const rendered = kind === "html" ? htmlToMarkdown(decoded) : decoded;
		const text = rendered.length > maxOutputChars ? rendered.slice(0, maxOutputChars) : rendered;
		return {
			url: url.href,
			status: response.status,
			text,
			contentType: contentType ?? "",
			truncated: bodyCut || text.length !== rendered.length,
		};
	}
}

/** Decode with the declared charset, falling back to UTF-8 rather than mangling. */
export function decodeBody(bytes: Uint8Array, charset: string | undefined): string {
	if (charset && charset !== "utf-8" && charset !== "utf8") {
		try {
			return new TextDecoder(charset).decode(bytes);
		} catch {
			// Unknown label: UTF-8 below is the better guess for a modern page.
		}
	}
	return new TextDecoder("utf-8").decode(bytes);
}

/* ------------------------------------------------------------------ */
/* HTML → markdown                                                     */
/* ------------------------------------------------------------------ */

const BLOCK_TAGS = new Set([
	"address", "article", "aside", "blockquote", "body", "dd", "details", "div", "dl", "dt",
	"fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
	"header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody",
	"td", "tfoot", "th", "thead", "tr", "ul",
]);
/** Dropped with their content: none of them is page text. */
const DROP_TAGS = new Set(["script", "style", "noscript", "svg", "canvas", "template", "iframe", "object", "head"]);
const VOID_TAGS = new Set([
	"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);
const INLINE_TAGS = new Set(["a", "abbr", "b", "bdi", "bdo", "cite", "code", "del", "dfn", "em", "i", "ins", "kbd", "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var"]);

/** Above this much nesting the converter falls back to plain text: an unclosed-tag
 * document otherwise makes the walk superlinear while blocking the event loop. */
const MAX_DEPTH = 512;

const ENTITIES: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
	hellip: "…", copy: "©", reg: "®", trade: "™", times: "×", divide: "÷", deg: "°",
	rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", laquo: "«", raquo: "»", middot: "·", bull: "•",
	larr: "←", rarr: "→", uarr: "↑", darr: "↓", euro: "€", pound: "£", yen: "¥", cent: "¢",
};

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
		if (body.startsWith("#x") || body.startsWith("#X")) {
			const code = Number.parseInt(body.slice(2), 16);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		if (body.startsWith("#")) {
			const code = Number.parseInt(body.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return ENTITIES[body.toLowerCase()] ?? whole;
	});
}

interface OpenElement {
	name: string;
	/** Set for the elements whose inline content is collected before rendering. */
	buffer?: string[];
	/** Presentation of an inline element (`**`, `*`, …), applied when it closes. */
	mark?: boolean;
	/** Tag body, for `a` (href) and `img` (src/alt). */
	tagBody?: string;
}

/** Collapse whitespace the way a browser renders it, keeping paragraph breaks. */
function collapse(text: string): string {
	return text
		.replace(/[ \t\f\v\u00a0]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function attr(tagBody: string, name: string): string | undefined {
	const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tagBody);
	if (!match) return undefined;
	return decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
}

/** Resolve a possibly-relative URL against the page's base. */
function absolute(href: string, base: URL | undefined): string {
	try {
		return base ? new URL(href, base).href : href;
	} catch {
		return href;
	}
}

/**
 * Convert an HTML document to markdown.
 *
 * A small tolerant tokenizer, not a DOM. Text is always appended to the nearest
 * open element that collects content (a paragraph, heading, list item or `pre`
 * — or, when none is open, the document itself), so `<b>bold</b> plain text`
 * stays in order. Inline elements only decide *presentation*: they push a marker
 * when they open and wrap the text that arrived while they were open when they
 * close. Elements that are never page text (`script`, `style`, `nav` chrome is
 * kept on purpose — link text is often the answer) are dropped.
 *
 * Malformed markup degrades instead of throwing: past {@link MAX_DEPTH} nesting
 * the converter stops tracking structure and returns plain text, because an
 * unclosed-tag document otherwise makes the walk superlinear while blocking the
 * event loop.
 */
export function htmlToMarkdown(html: string, base?: string): string {
	let baseUrl: URL | undefined;
	if (base) {
		try {
			baseUrl = new URL(base);
		} catch {
			baseUrl = undefined;
		}
	}

	const stack: OpenElement[] = [];
	/** Output blocks, in document order. */
	const blocks: string[] = [];
	/** Text of the block being built (headings, paragraphs, list items). */
	let block: string[] = [];
	/** Raw character count held in `block`, cap for the block buffer. */
	let blockChars = 0;
	let listStack: { ordered: boolean; index: number }[] = [];

	const owner = (): string[] => {
		for (let i = stack.length - 1; i >= 0; i -= 1) {
			const buffer = stack[i]?.buffer;
			if (buffer) return buffer;
		}
		return block;
	};

	const append = (text: string): void => {
		if (!text) return;
		const buffer = owner();
		if (buffer === block) blockChars += text.length;
		buffer.push(text);
	};

	/** Close the current block: render it and start a new one. */
	const breakBlock = (): void => {
		const pending = collapse(block.join(""));
		block = [];
		blockChars = 0;
		if (pending) blocks.push(pending);
	};

	const lastBlock = (): string | undefined => blocks[blocks.length - 1];

	/** List items that continue the same list join the previous block. */
	function pushListItem(line: string, ordered: boolean): void {
		const previous = lastBlock();
		const continues = previous !== undefined && (ordered ? /^\d+\. /.test(previous) : previous.startsWith("- "));
		if (continues) blocks[blocks.length - 1] = `${previous}\n${line}`;
		else blocks.push(line);
	}

	let index = 0;
	const lower = html.toLowerCase();
	while (index < html.length) {
		const start = html.indexOf("<", index);
		if (start === -1) {
			append(decodeEntities(html.slice(index)));
			break;
		}
		if (start > index) append(decodeEntities(html.slice(index, start)));

		if (html.startsWith("<!--", start)) {
			const close = html.indexOf("-->", start + 4);
			index = close === -1 ? html.length : close + 3;
			continue;
		}
		if (html.startsWith("<!", start) || html.startsWith("<?", start)) {
			const close = html.indexOf(">", start);
			index = close === -1 ? html.length : close + 1;
			continue;
		}

		const end = findTagEnd(html, start + 1);
		if (end === -1) {
			append(decodeEntities(html.slice(start)));
			break;
		}
		const body = html.slice(start + 1, end);
		index = end + 1;

		const closing = body.startsWith("/");
		const nameMatch = /^\s*\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(body);
		if (!nameMatch?.[1]) continue;
		const name = nameMatch[1].toLowerCase();

		// Raw-text elements: their content is code, never markup.
		if (name === "script" || name === "style" || name === "template") {
			if (!closing) {
				const close = findRawTextEnd(lower, name, index);
				index = close === -1 ? html.length : close;
			}
			continue;
		}

		if (closing) {
			const at = findOnStack(stack, name);
			if (at === -1) continue;
			const opened = stack.splice(at);
			for (let i = opened.length - 1; i >= 0; i -= 1) {
				const element = opened[i];
				if (element) closeElement(element);
			}
			continue;
		}

		const selfClosing = body.trimEnd().endsWith("/");

		if (DROP_TAGS.has(name)) {
			if (!selfClosing) {
				const close = findRawTextEnd(lower, name, index);
				index = close === -1 ? html.length : close;
			}
			continue;
		}

		if (name === "br") {
			append("\n");
			continue;
		}
		if (VOID_TAGS.has(name)) {
			if (name === "img") {
				const src = attr(body, "src");
				if (src) {
					const alt = attr(body, "alt") ?? "";
					append(alt ? `![${alt}](${absolute(src, baseUrl)})` : "");
				}
			}
			continue;
		}

		if (INLINE_TAGS.has(name)) {
			if (selfClosing) continue;
			if (stack.length >= MAX_DEPTH) continue;
			// `code` inside `pre` is already a code block: adding backticks would
			// nest them inside the fence.
			const inPre = stack.some((element) => element.name === "pre");
			const mark = !inPre && (name === "strong" || name === "b" || name === "em" || name === "i" || name === "del" || name === "s" || name === "code" || name === "a");
			stack.push({ name, mark, tagBody: body, ...(mark ? { buffer: [] } : {}) });
			continue;
		}

		// Block element.
		if (name === "hr") {
			breakBlock();
			blocks.push("---");
			continue;
		}
		if (selfClosing) continue;
		if (stack.length >= MAX_DEPTH) {
			// Pathological nesting: stop tracking and let the remaining text through.
			for (const text of textOnly(html.slice(index))) blocks.push(text);
			index = html.length;
			break;
		}

		const headingLevel = /^h([1-6])$/.exec(name)?.[1];
		if (headingLevel) {
			breakBlock();
			stack.push({ name, buffer: [] });
			continue;
		}
		if (name === "pre") {
			breakBlock();
			stack.push({ name, buffer: [] });
			continue;
		}
		if (name === "ul" || name === "ol") {
			breakBlock();
			listStack.push({ ordered: name === "ol", index: 1 });
			stack.push({ name });
			continue;
		}
		if (name === "li" || name === "td" || name === "th") {
			// Lists and rows collect their own content, so the marker or separator is
			// decided by the parent instead of guessed at the leaf.
			stack.push({ name, buffer: [] });
			continue;
		}
		if (name === "p" || name === "dd" || name === "dt" || name === "summary" || name === "figcaption" || name === "blockquote") {
			breakBlock();
			stack.push({ name, buffer: [] });
			continue;
		}
		if (name === "table" || name === "thead" || name === "tbody" || name === "tfoot") {
			stack.push({ name });
			continue;
		}
		if (name === "tr") {
			breakBlock();
			stack.push({ name, buffer: [] });
			continue;
		}
		stack.push({ name });
	}

	while (stack.length > 0) {
		const element = stack.pop();
		if (element) closeElement(element);
	}
	breakBlock();

	return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();

	/** Apply one element's closing behaviour (inline marks, block boundaries). */
	function closeElement(element: OpenElement): void {
		const inner = element.buffer === undefined ? undefined : element.buffer.join("");

		if (element.mark && inner !== undefined) {
			const text = collapse(inner);
			let rendered = text;
			switch (element.name) {
				case "strong": case "b":
					rendered = text ? `**${text}**` : "";
					break;
				case "em": case "i":
					rendered = text ? `*${text}*` : "";
					break;
				case "del": case "s":
					rendered = text ? `~~${text}~~` : "";
					break;
				case "code":
					rendered = text ? `\`${text.replace(/`/g, "'")}\`` : "";
					break;
				case "a": {
					const href = element.tagBody ? attr(element.tagBody, "href") : undefined;
					rendered = !text || !href || href.startsWith("#") || /^javascript:/i.test(href) ? text : `[${text}](${absolute(href, baseUrl)})`;
					break;
				}
				default:
					break;
			}
			append(rendered);
			return;
		}

		if (inner === undefined) return;
		const text = collapse(inner);
		const heading = /^h([1-6])$/.exec(element.name);
		if (heading?.[1]) {
			breakBlock();
			if (text) blocks.push(`${"#".repeat(Number(heading[1]))} ${text}`);
			return;
		}
		if (element.name === "pre") {
			const code = inner.replace(/^\n+/, "").replace(/\s+$/, "");
			breakBlock();
			if (code) blocks.push(`\`\`\`\n${code}\n\`\`\``);
			return;
		}
		if (element.name === "ul" || element.name === "ol") {
			const list = listStack.pop();
			if (list && text) {
				const marker = list.ordered ? `${list.index}. ` : "- ";
				// Nested list content is already markdown lines; indent it under the item.
				breakBlock();
				blocks.push(text.split("\n").map((line, i) => (i === 0 ? `${marker}${line}` : `  ${line}`)).join("\n"));
			} else if (text) {
				breakBlock();
				blocks.push(text);
			}
			return;
		}
		if (element.name === "li") {
			const list = listStack.at(-1);
			const marker = list ? (list.ordered ? `${list.index}. ` : "- ") : "";
			if (list?.ordered) list.index += 1;
			breakBlock();
			if (text) pushListItem(`${marker}${text.replace(/\n/g, "\n  ")}`, list?.ordered ?? false);
			return;
		}
		if (element.name === "td" || element.name === "th") {
			if (text) append(`${text} | `);
			return;
		}
		if (element.name === "tr") {
			const row = collapse(text).replace(/\s*\|\s*$/, "");
			if (row) blocks.push(row);
			return;
		}
		if (text) {
			breakBlock();
			blocks.push(text);
		}
	}
}

function findTagEnd(html: string, from: number): number {
	let quote: string | undefined;
	for (let i = from; i < html.length; i += 1) {
		const char = html[i];
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (char === ">") return i;
	}
	return -1;
}

function findOnStack(stack: OpenElement[], name: string): number {
	for (let i = stack.length - 1; i >= 0; i -= 1) {
		if (stack[i]?.name === name) return i;
	}
	return -1;
}

function findRawTextEnd(lower: string, name: string, from: number): number {
	const prefix = `</${name}`;
	let at = lower.indexOf(prefix, from);
	while (at !== -1) {
		const next = lower[at + prefix.length];
		if (next === undefined || next === ">" || /\s/.test(next)) {
			const end = lower.indexOf(">", at);
			return end === -1 ? -1 : end + 1;
		}
		at = lower.indexOf(prefix, at + prefix.length);
	}
	return -1;
}

/** Last resort for pathological input: strip every tag, keep the text. */
function textOnly(html: string): string[] {
	return collapse(decodeEntities(html.replace(/<[^>]*>/g, " ")))
		.split("\n\n")
		.filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** Label for a source: its title, else its hostname, else the raw URL. */
function sourceLabel(url: string, title: string | undefined): string {
	if (title) return title;
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

/**
 * The model-facing text of a search. The closing instruction is not decoration:
 * telling the model to cite inside the tool result is the one place it reads on
 * every call, and it is what turns "I looked it up" into a verifiable claim.
 */
export function formatSearchOutput(query: string, outcome: SearchOutcome): string {
	const parts: string[] = [];
	if (outcome.answer) parts.push(outcome.answer);
	if (outcome.sources.length > 0) {
		const lines = outcome.sources.map((source) => {
			const meta = [source.snippet, source.publishedAt ? `(${source.publishedAt})` : ""].filter(Boolean).join(" ");
			return `- [${sourceLabel(source.url, source.title)}](${source.url})${meta ? ` — ${meta}` : ""}`;
		});
		parts.push(`Sources:\n${lines.join("\n")}`);
	} else if (!outcome.answer) {
		parts.push(`No results found for "${query}".`);
	}
	if (outcome.truncated) parts.push(`(Showing the first ${outcome.sources.length} sources. Refine the query for more.)`);
	parts.push("Cite the relevant URLs above as markdown links in your answer.");
	return parts.join("\n\n");
}

/** The model-facing text of a fetch: a one-line provenance header, then content. */
export function formatFetchOutput(outcome: FetchOutcome): string {
	const header = `Fetched ${outcome.url} (HTTP ${outcome.status}, ${outcome.contentType || "unknown type"})`;
	const body = outcome.text.trim() || "(the page had no readable text)";
	const footer = outcome.truncated ? "\n\n(Content truncated. Fetch a more specific URL or section for the full text.)" : "";
	return `${header}\n\n${body}${footer}`;
}

/* ------------------------------------------------------------------ */
/* Search providers                                                    */
/* ------------------------------------------------------------------ */

/** JSON with a clear error when the endpoint answers HTML (usually a wrong URL). */
async function postJson(url: string, body: unknown, headers: Record<string, string>, signal: AbortSignal, what: string): Promise<any> {
	const response = await fetch(url, {
		method: "POST",
		signal,
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const detail = (await response.text().catch(() => "")).slice(0, 300).trim();
		throw new WebError(`${what} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
	}
	return response.json();
}

/** Asks the endpoint's own key from `.env` (loaded by the CLI), never from a tool argument. */
function apiKey(id: string, env: string): string {
	const key = process.env[env]?.trim() ?? "";
	if (!key) throw new WebError(`web_search provider "${id}" needs ${env} in ~/.steve/.env.`);
	return key;
}

/** Tavily: clean summaries, an optional one-paragraph answer, generous free tier. */
export const tavilyProvider: SearchProvider = {
	id: "tavily",
	apiKeyEnv: "TAVILY_API_KEY",
	async search(query, maxResults, signal) {
		const data = await postJson(
			"https://api.tavily.com/search",
			{ query, max_results: maxResults, include_answer: true, search_depth: "basic" },
			{ authorization: `Bearer ${apiKey("tavily", "TAVILY_API_KEY")}` },
			signal,
			"Tavily",
		);
		const results: any[] = Array.isArray(data?.results) ? data.results : [];
		return {
			...(typeof data?.answer === "string" && data.answer ? { answer: data.answer } : {}),
			sources: results.slice(0, maxResults).map((result) => ({
				url: String(result.url ?? ""),
				...(result.title ? { title: String(result.title) } : {}),
				...(result.content ? { snippet: String(result.content) } : {}),
				...(result.published_date ? { publishedAt: String(result.published_date) } : {}),
			})),
			truncated: results.length > maxResults,
		};
	},
};

/** Exa: semantic search with page text; the default in OpenCode. */
export const exaProvider: SearchProvider = {
	id: "exa",
	apiKeyEnv: "EXA_API_KEY",
	async search(query, maxResults, signal) {
		const data = await postJson(
			"https://api.exa.ai/search",
			{ query, numResults: maxResults, contents: { text: { maxCharacters: 1_000 } } },
			{ "x-api-key": apiKey("exa", "EXA_API_KEY") },
			signal,
			"Exa",
		);
		const results: any[] = Array.isArray(data?.results) ? data.results : [];
		return {
			sources: results.slice(0, maxResults).map((result) => ({
				url: String(result.url ?? ""),
				...(result.title ? { title: String(result.title) } : {}),
				...(result.text ? { snippet: String(result.text).replace(/\s+/g, " ").slice(0, 400) } : {}),
				...(result.publishedDate ? { publishedAt: String(result.publishedDate) } : {}),
			})),
			truncated: results.length > maxResults,
		};
	},
};

/** Brave: cheapest per call, best for plain lookups; descriptions are HTML. */
export const braveProvider: SearchProvider = {
	id: "brave",
	apiKeyEnv: "BRAVE_API_KEY",
	async search(query, maxResults, signal) {
		const url = new URL("https://api.search.brave.com/res/v1/web/search");
		url.searchParams.set("q", query);
		url.searchParams.set("count", String(Math.min(maxResults, 20)));
		const response = await fetch(url, {
			signal,
			headers: { accept: "application/json", "x-subscription-token": apiKey("brave", "BRAVE_API_KEY") },
		});
		if (!response.ok) throw new WebError(`Brave returned HTTP ${response.status}.`);
		const data = (await response.json()) as { web?: { results?: any[] } };
		const results: any[] = Array.isArray(data.web?.results) ? data.web.results : [];
		return {
			sources: results.slice(0, maxResults).map((result) => ({
				url: String(result.url ?? ""),
				...(result.title ? { title: decodeEntities(String(result.title)) } : {}),
				...(result.description ? { snippet: decodeEntities(String(result.description).replace(/<[^>]*>/g, "")) } : {}),
				...(result.age ? { publishedAt: String(result.age) } : {}),
			})),
			truncated: results.length > maxResults,
		};
	},
};

/** Provider table, keyed by the `WEB_SEARCH_PROVIDER` value. */
export const SEARCH_PROVIDERS: Record<string, SearchProvider> = {
	tavily: tavilyProvider,
	exa: exaProvider,
	brave: braveProvider,
};

/**
 * The provider named by the environment, or `undefined` when none is usable —
 * `web_search` is then not registered at all, so `/tools` never lists a tool that
 * cannot work. A named provider without its key logs why instead of failing the
 * session.
 */
export function resolveSearchProvider(env: NodeJS.ProcessEnv = process.env, log?: (message: string) => void): SearchProvider | undefined {
	const requested = env.WEB_SEARCH_PROVIDER?.trim().toLowerCase();
	const candidates = requested ? [requested] : Object.keys(SEARCH_PROVIDERS);
	for (const id of candidates) {
		const provider = SEARCH_PROVIDERS[id];
		if (!provider) {
			log?.(`unknown WEB_SEARCH_PROVIDER "${id}" (known: ${Object.keys(SEARCH_PROVIDERS).join(", ")})`);
			continue;
		}
		if (provider.apiKeyEnv && !env[provider.apiKeyEnv]?.trim()) continue;
		return provider;
	}
	return undefined;
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

const SearchParams = Type.Object({
	query: Type.String({ description: "What to look up. Phrase it like a search query, with the year for anything time-sensitive." }),
	maxResults: Type.Optional(Type.Number({ description: `How many sources to return (1-${WEB_SEARCH_RESULT_CEILING}). Default ${WEB_SEARCH_MAX_RESULTS}.` })),
});

const FetchParams = Type.Object({
	url: Type.String({ description: "Absolute http(s) URL to fetch. Inline the exact page that holds the answer, not a homepage." }),
});

type SearchParams = Parameters<AgentTool<typeof SearchParams>["execute"]>[1];
type FetchParams = Parameters<AgentTool<typeof FetchParams>["execute"]>[1];

/**
 * Build the web tools for one session.
 *
 * `web_search` only exists when a provider with a key is configured. Both tools
 * are read-only and declare `permission: "auto"`: a lookup has no side effects,
 * and asking every time teaches the model to stop looking things up. The fetch
 * `describe` still tells the user which host is about to be contacted.
 */
export function createWebTools(options: WebToolOptions = {}): AnnotatedTool[] {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const defaultResults = Math.min(options.maxResults ?? WEB_SEARCH_MAX_RESULTS, WEB_SEARCH_RESULT_CEILING);
	// Typed loosely on purpose: each tool is built against its own schema, and the
	// registry erases the parameter type anyway.
	const tools: AnnotatedTool[] = [];
	const provider = options.provider;

	if (provider) {
		const searchTool: AnnotatedTool<typeof SearchParams> = {
			name: "web_search",
			label: "Web search",
			description:
				`Search the web and return up to ${defaultResults} sources (title, URL, snippet, date). ` +
				"Use it for facts you do not know or that change over time — versions, prices, news, API signatures, library usage. " +
				"Follow up with web_fetch on a promising URL when a snippet is not enough.",
			permission: "auto",
			metadata: { kind: "search", title: (args) => `Search ${(args as { query?: string })?.query ?? "the web"}` },
			parameters: SearchParams,
			execute: async (_toolCallId, params: SearchParams) => {
				const query = params.query.trim();
				if (!query) throw new WebError("query must be a non-empty string.");
				const requested = Math.floor(params.maxResults ?? defaultResults);
				const maxResults = Math.max(1, Math.min(Number.isFinite(requested) ? requested : defaultResults, WEB_SEARCH_RESULT_CEILING));
				const outcome = await provider.search(query, maxResults, AbortSignal.timeout(timeoutMs));
				return {
					content: [{ type: "text", text: formatSearchOutput(query, outcome) }],
					details: { provider: provider.id, query, sources: outcome.sources, truncated: outcome.truncated },
				};
			},
		};
		tools.push(searchTool as AnnotatedTool);
	}

	const fetchTool: AnnotatedTool<typeof FetchParams> = {
		name: "web_fetch",
		label: "Web fetch",
		description:
			"Fetch one URL and return its content as markdown (HTML pages) or text. " +
			"Only http(s), only public hosts, redirects within the same origin, and a bounded amount of text.",
		permission: "auto",
		metadata: { kind: "fetch", title: (args) => `Fetch ${hostOf((args as { url?: string })?.url)}` },
		describe: (args) => {
			const url = (args as { url?: string })?.url;
			return { summary: `fetch ${url ?? "(no URL)"}` };
		},
		parameters: FetchParams,
		execute: async (_toolCallId, params: FetchParams) => {
			if (!params.url.trim()) throw new WebError("url must be a non-empty string.");
			const outcome = await fetchUrl(params.url.trim(), {
				timeoutMs,
				...(options.maxOutputChars !== undefined ? { maxOutputChars: options.maxOutputChars } : {}),
				...(options.allowPrivateHosts !== undefined ? { allowPrivateHosts: options.allowPrivateHosts } : {}),
				...(options.resolveHost !== undefined ? { resolveHost: options.resolveHost } : {}),
			});
			return {
				content: [{ type: "text", text: formatFetchOutput(outcome) }],
				details: { url: outcome.url, status: outcome.status, contentType: outcome.contentType, truncated: outcome.truncated },
			};
		},
	};
	tools.push(fetchTool as AnnotatedTool);

	return tools;
}

function hostOf(url: string | undefined): string {
	if (!url) return "a page";
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}
