/**
 * Feishu interactive card builder (model layer, zero upward dependencies).
 *
 * The model never hands us raw card JSON: a wrong nesting there is a reply that
 * Feishu refuses, and the user just sees silence. It fills a handful of fields
 * (title, body, colour) and this module produces the card, so anything it
 * returns is a card Feishu will accept.
 *
 * Shape (Feishu "card 2.0"-safe subset): a header with a plain-text title and an
 * optional colour, then either one markdown element or — when the body has fenced
 * code — a run of alternating markdown and code-block elements.
 *
 * Code blocks are split out on purpose. A fenced block inside a card's `markdown`
 * element arrives as literal backticks: the card renderer treats the element as
 * inline markdown, so lists and bold work and fences do not. Feishu's dedicated
 * `code_block` element is the one that renders as code, so a body with fences
 * becomes [markdown, code_block, markdown, …] and the prose around the code keeps
 * rendering as prose.
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

export interface FeishuCard {
	config: { wide_screen_mode: boolean };
	elements: CardElement[];
	header?: { title: { tag: "plain_text"; content: string }; template: string };
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

/**
 * Builds a card from model-supplied fields. Returns the card body Feishu's
 * `interactive` message type expects, ready to be JSON-stringified.
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

	const card: FeishuCard = {
		config: { wide_screen_mode: true },
		elements: segmentCardBody(body),
	};

	const title = input.title?.trim() ?? "";
	if (title !== "") {
		const theme = input.theme?.trim() ?? "";
		card.header = {
			title: { tag: "plain_text", content: title.slice(0, MAX_CARD_TITLE_CHARS) },
			template: isTheme(theme) ? theme : "blue",
		};
	}

	return card;
}
