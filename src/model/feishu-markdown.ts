/**
 * Feishu message formatting rules (model layer, zero upward dependencies).
 *
 * A Feishu reply is sent as one of two message types, and the choice decides
 * whether the model's markdown is rendered or displayed as source:
 *
 * - `text` renders **nothing** — `## 标题` and `| a | b |` arrive verbatim,
 *   pipes and dashes included. It is only right for prose.
 * - `post` with an `md` element renders headings, tables, code blocks, lists,
 *   bold, links. This is the type any answer with structure must use.
 *
 * The adapter used to send everything as `text`, so every structured answer
 * looked like the raw source. This module holds the decision (does this look
 * like markdown?) and the two conversions we need: to a `post` body, and to
 * plain text for the fallback when Feishu refuses the post.
 */

/** Feishu's per-message ceiling. Split before this; there is no point sending more. */
export const MAX_MESSAGE_CHARS = 8_000;

/**
 * Room reserved when splitting, so the `(1/3)` marker does not push a chunk over.
 */
const INDICATOR_RESERVE = 16;

/**
 * What makes a message "markdown" rather than prose.
 *
 * Anchored forms need to start a line (headings, list items, quotes, fences);
 * inline forms can appear anywhere. A bare `*` or `_` is deliberately absent:
 * prose with an asterisk should stay prose rather than switch renderers.
 */
export const MARKDOWN_HINT = new RegExp(
	[
		// Pipe table: a header line followed by a separator line.
		String.raw`^\|.*\|\s*$[\r\n]+\|[-:|\s]+\|`,
		String.raw`^#{1,6}\s`,
		String.raw`^\s*[-*]\s`,
		String.raw`^\s*\d+\.\s`,
		String.raw`^\s*---+\s*$`,
		String.raw`^\s*>\s`,
		String.raw`~~~`,
		"```",
		"`[^`\n]+`",
		String.raw`\*\*[^*\n].+?\*\*`,
		String.raw`~~[^~\n].+?~~`,
		String.raw`\[[^\]]+\]\([^)]+\)`,
	].join("|"),
	"m",
);

/** True when the text contains anything Feishu only renders in a `post`. */
export function looksLikeMarkdown(text: string): boolean {
	return MARKDOWN_HINT.test(text);
}

/**
 * One row of a `post` body: a list of inline elements. We only ever emit `md`
 * elements; the array-of-arrays shape is what Feishu expects.
 */
export type PostRow = { tag: "md"; text: string }[];

export interface PostContent {
	zh_cn: { content: PostRow[] };
}

/**
 * Builds the `content` object for a `msg_type: "post"` message.
 *
 * A fenced code block gets its own row. Inside one `md` element Feishu's
 * renderer swallows whatever follows a fence — a reply with a code block and
 * then prose loses the prose. Splitting at real fence lines (not at innermost
 * ones, and not inside a fence) keeps both halves visible.
 */
export function buildPostContent(text: string): PostContent {
	const body = text.trim();
	if (body === "") return { zh_cn: { content: [[{ tag: "md", text: "" }]] } };
	if (!body.includes("```")) return { zh_cn: { content: [[{ tag: "md", text: body }]] } };

	const rows: PostRow[] = [];
	let current: string[] = [];
	let inFence = false;
	const flush = (): void => {
		const segment = current.join("\n").trim();
		if (segment !== "") rows.push([{ tag: "md", text: segment }]);
		current = [];
	};

	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		const isFence = !inFence ? /^```[^`]*$/.test(trimmed) : /^```$/.test(trimmed);
		if (isFence && !inFence) flush();
		current.push(line);
		if (isFence) {
			inFence = !inFence;
			if (!inFence) flush();
		}
	}
	flush();
	return { zh_cn: { content: rows.length > 0 ? rows : [[{ tag: "md", text: body }]] } };
}

/**
 * Markdown → plain text, for the fallback when Feishu rejects a `post`.
 *
 * This is not a formatter: it only removes the source syntax so the reader does
 * not see `**bold**` and `##` marks. A table becomes its rows, pipes and
 * separator line dropped; the cells stay readable which is the point of falling
 * back at all.
 */
export function stripMarkdown(text: string): string {
	let out = text.replace(/\r\n/g, "\n");
	// Fences and their closing marker disappear; the code itself stays.
	out = out.replace(/^```[a-zA-Z0-9_+-]*\s*$/gm, "");
	out = out.replace(/`([^`\n]+)`/g, "$1");
	out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1");
	out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => (label === url ? url : `${label} (${url})`));
	out = out.replace(/\*\*([^*\n]+)\*\*/g, "$1");
	out = out.replace(/~~([^~\n]+)~~/g, "$1");
	out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,，。])/g, "$1$2");
	out = out.replace(/^#{1,6}\s+/gm, "");
	out = out.replace(/^>\s?/gm, "");
	out = out.replace(/^\s*---+\s*$/gm, "---");
	// Table: drop the separator line, then the leading/trailing pipes.
	out = out.replace(/^\|[-:|\s]+\|\s*$/gm, "");
	out = out.replace(/^\|(.*)\|\s*$/gm, (_match, row: string) =>
		row
			.split("|")
			.map((cell) => cell.trim())
			.filter((cell) => cell !== "")
			.join("  "),
	);
	return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Splits a message into chunks Feishu will accept, closing and reopening a
 * fenced code block across the boundary and repeating a table's header row.
 *
 * Truncating instead would be one line shorter and one answer poorer: the tail
 * of a long answer is usually the conclusion. A `(1/3)` marker tells the reader
 * the parts belong together.
 */
export function splitMessage(text: string, maxChars: number = MAX_MESSAGE_CHARS): string[] {
	const body = text.trim();
	if (body === "") return [body];
	if (body.length <= maxChars) return [body];

	const budget = Math.max(64, maxChars - INDICATOR_RESERVE);
	const chunks: string[] = [];
	let remaining = body;
	/** Fence still open from the previous chunk: reopening keeps the code a code block. */
	let carryFence: string | undefined;
	/** Table header to repeat: without it the next part has anonymous columns. */
	let carryHeader: string | undefined;

	while (remaining !== "") {
		const prefix = carryFence !== undefined ? "```".concat(carryFence, "\n") : carryHeader !== undefined ? "".concat(carryHeader, "\n") : "";
		const closeCost = carryFence !== undefined ? 4 : 0;
		const room = budget - prefix.length - closeCost;

		// Everything left fits: take it and close whatever is still open.
		if (prefix.length + remaining.length + closeCost <= budget) {
			const final = prefix + remaining;
			chunks.push(openFence(final) === undefined ? final : `${final}\n\`\`\``);
			break;
		}

		// Break at a line boundary where possible; a paragraph is prettier than a
		// word cut in half, and Feishu renders both.
		let cut = remaining.lastIndexOf("\n", room);
		if (cut < room / 2) cut = remaining.lastIndexOf(" ", room);
		if (cut < 1) cut = room;

		const piece = prefix + remaining.slice(0, cut);
		remaining = remaining.slice(cut).replace(/^\n+/, "");

		const open = openFence(piece);
		if (open !== undefined) {
			chunks.push(piece + "\n```");
			carryFence = open;
			carryHeader = undefined;
		} else {
			chunks.push(piece);
			carryFence = undefined;
			carryHeader = tableHeader(piece.slice(prefix.length));
		}
	}

	if (chunks.length <= 1) return chunks;
	return chunks.map((chunk, index) => `${chunk} (${index + 1}/${chunks.length})`);
}

/**
 * The language tag of a fence left open at the end of `text`, if any.
 *
 * Only a line that *consists* of a fence counts — an inline triple backtick in
 * prose does not open a block, and treating it as one would make the splitter
 * close a fence that was never opened.
 */
function openFence(text: string): string | undefined {
	let open: string | undefined;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		const opened = /^```([^`]*)$/.exec(trimmed);
		if (opened === null) continue;
		if (open === undefined) {
			open = opened[1] ?? "";
		} else if (/^```$/.test(trimmed)) {
			open = undefined;
		}
	}
	return open;
}

/** Header + separator of the table `text` starts with, if it starts with one. */
function tableHeader(text: string): string | undefined {
	const lines = text.split("\n");
	const [header, separator] = lines;
	if (header === undefined || separator === undefined) return undefined;
	if (!/^\|.*\|\s*$/.test(header) || !/^\|[-:|\s]+\|/.test(separator)) return undefined;
	return `${header}\n${separator}`;
}
