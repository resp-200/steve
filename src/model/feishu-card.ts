/**
 * Feishu interactive card builder (model layer, zero upward dependencies).
 *
 * The model never hands us raw card JSON: a wrong nesting there is a reply that
 * Feishu refuses, and the user just sees silence. It fills a handful of fields
 * (title, body, colour) and this module produces the card, so anything it
 * returns is a card Feishu will accept.
 *
 * Shape (Feishu "card 2.0"-safe subset): a header with a plain-text title and an
 * optional colour, then one markdown element. Markdown is what makes the card
 * worth sending — lists, bold, code blocks render, which is exactly what the
 * plain `text` message type cannot do.
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

export interface FeishuCard {
	config: { wide_screen_mode: boolean };
	elements: Record<string, unknown>[];
	header?: { title: { tag: "plain_text"; content: string }; template: string };
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
		elements: [{ tag: "markdown", content: body }],
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
