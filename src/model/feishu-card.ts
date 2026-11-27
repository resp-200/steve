/**
 * Feishu interactive card builder (model layer, zero upward dependencies).
 *
 * The model never hands us raw card JSON: a wrong nesting there is a reply that
 * Feishu refuses — and a refused card is silence, not an error the user can act
 * on. It fills a handful of fields (title, body, colour) and this module produces
 * the card, so anything it returns is a card Feishu accepts.
 *
 * Two card shapes exist and only one of them renders code:
 *
 * - Card JSON 1.0: `{ config, elements, header }`. Its `markdown` element is
 *   inline markdown only — lists, bold, links, tables render; a fenced code
 *   block shows up as literal backticks.
 * - Card JSON 2.0: `{ schema: "2.0", config, body: { elements }, header }`. Its
 *   `markdown` element renders GFM including fences, and it has a dedicated
 *   `code_block` element with syntax highlighting.
 *
 * 1.0 was what we sent, so code in cards arrived as ```ts … ``` source. 2.0 fixes
 * that, at the cost of a shape older clients may reject — so `buildFeishuCard`
 * returns 1.0 when there is no code (nothing to gain, less to break) and 2.0 when
 * there is, and `toCardV1` converts a 2.0 card back for the retry path.
 */

/** Feishu's documented header themes; anything else is dropped rather than sent. */
export const CARD_THEMES = ["blue", "wathet", "turquoise", "green", "yellow", "orange", "red", "carmine", "violet", "purple", "indigo", "grey"] as const;

export type CardTheme = (typeof CARD_THEMES)[number];

/** A card is a message; Feishu rejects oversized ones, so cap the body well under the limit. */
export const MAX_CARD_BODY_CHARS = 20_000;
export const MAX_CARD_TITLE_CHARS = 100;

export interface CardInput {
	/** Header title. Omitted: the card renders without a header. */
	title?: string;
	/** Markdown body. */
	body: string;
	/** Header colour; unknown values are ignored. */
	theme?: string;
}

/** A fenced-code language Feishu will syntax-highlight; anything else is plain text. */
const CODE_LANGUAGES = new Set([
	"plaintext", "bash", "shell", "sh", "zsh", "powershell", "sql", "json", "json5", "xml", "html", "css", "scss", "less",
	"javascript", "js", "typescript", "ts", "tsx", "jsx", "python", "py", "go", "golang", "rust", "rs", "java", "kotlin",
	"swift", "objectivec", "c", "cpp", "c++", "csharp", "cs", "php", "ruby", "rb", "scala", "dart", "lua", "perl", "r",
	"yaml", "yml", "toml", "ini", "dockerfile", "makefile", "graphql", "protobuf", "diff", "markdown", "md", "text", "txt",
]);

/** One card element: prose as inline markdown, code as Feishu's code element. */
export type CardElement =
	| { tag: "markdown"; content: string }
	| { tag: "code_block"; language: string; text: string };

interface CardHeader {
	title: { tag: "plain_text"; content: string };
	template: string;
}

/** Feishu's `interactive` message content. Which fields exist depends on the version. */
export interface FeishuCard {
	/** Present only on 2.0 cards; a 1.0 card is recognised by its absence. */
	schema?: "2.0";
	config: { wide_screen_mode: boolean; update_multi?: boolean };
	/** 1.0 puts elements here. */
	elements?: CardElement[];
	/** 2.0 nests them one level down. */
	body?: { elements: CardElement[] };
	header?: CardHeader;
}

export function isCardV2(card: FeishuCard): boolean {
	return card.schema === "2.0";
}

function normalizeLanguage(raw: string): string {
	const language = raw.trim().toLowerCase();
	if (language === "c++") return "cpp";
	if (language === "js") return "javascript";
	if (language === "ts") return "typescript";
	if (language === "py") return "python";
	if (language === "rs") return "rust";
	return CODE_LANGUAGES.has(language) ? language : "plaintext";
}

/**
 * Splits a card body into prose and code runs.
 *
 * A fence that is never closed is *not* swallowed to the end of the body: taking
 * the rest as code is how a model that forgot its closing fence turns a whole
 * answer into one grey block. It stays prose instead, where the reader sees the
 * text they were meant to read.
 */
export function segmentCardBody(body: string): CardElement[] {
	if (!body.includes("```")) return [{ tag: "markdown", content: body }];

	const elements: CardElement[] = [];
	let prose: string[] = [];
	const flushProse = (): void => {
		const text = prose.join("\n").trim();
		if (text !== "") elements.push({ tag: "markdown", content: text });
		prose = [];
	};

	const lines = body.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const opening = /^\s*```([^`]*)$/.exec(line);
		if (opening === null) {
			prose.push(line);
			continue;
		}
		let closing = -1;
		for (let scan = index + 1; scan < lines.length; scan += 1) {
			if (/^\s*```\s*$/.test(lines[scan] ?? "")) {
				closing = scan;
				break;
			}
		}
		if (closing < 0) {
			prose.push(line);
			continue;
		}
		flushProse();
		elements.push({
			tag: "code_block",
			language: normalizeLanguage(opening[1] ?? ""),
			text: lines.slice(index + 1, closing).join("\n"),
		});
		index = closing;
	}
	flushProse();
	return elements.length > 0 ? elements : [{ tag: "markdown", content: body }];
}

function isTheme(value: string): value is CardTheme {
	return (CARD_THEMES as readonly string[]).includes(value);
}

function cardHeader(input: CardInput): CardHeader | undefined {
	const title = input.title?.trim() ?? "";
	if (title === "") return undefined;
	const theme = input.theme?.trim() ?? "";
	return {
		title: { tag: "plain_text", content: title.slice(0, MAX_CARD_TITLE_CHARS) },
		template: isTheme(theme) ? theme : "blue",
	};
}

/**
 * Builds a card from model-supplied fields. Returns the card JSON Feishu's
 * `interactive` message type expects, ready to be JSON-stringified.
 *
 * Card 2.0 only when the body has code — that is the only thing 2.0 buys us here.
 * Everything else stays 1.0, which every client renders.
 *
 * Throws on an empty body: a card with nothing in it is never what was meant,
 * and the model can retry with content instead of the user receiving a blank box.
 */
export function buildFeishuCard(input: CardInput): FeishuCard {
	const body = input.body.trim();
	if (body === "") throw new Error("card body must not be empty");
	if (body.length > MAX_CARD_BODY_CHARS) {
		throw new Error(`card body is too long (${body.length} chars, max ${MAX_CARD_BODY_CHARS})`);
	}

	const elements = segmentCardBody(body);
	const header = cardHeader(input);

	if (!elements.some((element) => element.tag === "code_block")) {
		const card: FeishuCard = { config: { wide_screen_mode: true }, elements };
		if (header !== undefined) card.header = header;
		return card;
	}

	const card: FeishuCard = {
		// update_multi lets a card be updated in place; cards we send today are not,
		// but declaring it costs nothing and saves a breaking change later.
		schema: "2.0",
		config: { wide_screen_mode: true, update_multi: true },
		body: { elements },
	};
	if (header !== undefined) card.header = header;
	return card;
}

/**
 * Converts any card to card JSON 1.0, for the retry path when Feishu rejects 2.0.
 *
 * `code_block` has no 1.0 equivalent, so it becomes a fenced markdown element:
 * the reader sees the code, unhighlighted — which is what they would have got
 * before 2.0 existed, and better than no reply at all.
 */
export function toCardV1(card: FeishuCard): FeishuCard {
	if (!isCardV2(card)) return card;
	const elements: CardElement[] = (card.body?.elements ?? []).map((element) =>
		element.tag === "code_block"
			? { tag: "markdown", content: `\`\`\`${element.language}\n${element.text}\n\`\`\`` }
			: element,
	);
	const fallback: FeishuCard = { config: { wide_screen_mode: true }, elements };
	if (card.header !== undefined) fallback.header = card.header;
	return fallback;
}
