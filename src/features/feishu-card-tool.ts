/**
 * The `send_feishu_card` tool, built per run.
 *
 * It is not a standing tool: a card is a reply to a message on a channel, so the
 * tool only exists inside a run that was started by a Feishu message and knows
 * both the chat and the message to answer. Registering it globally would give
 * every CLI session a tool that cannot work.
 *
 * The model decides *whether* a card is a good idea — a comparison table reads
 * better as a card, a one-line answer does not. What the model does not decide
 * is the JSON: it fills title/body/theme and `buildFeishuCard` produces a card
 * Feishu accepts.
 *
 * Once the tool has sent one card, the entry no longer sends its own text reply:
 * two messages arriving for one question is noise, and the card was the answer.
 */
import { Type, type Static } from "../features/contract.js";
import type { AnnotatedTool } from "../features/tool-annotations.js";
import { buildFeishuCard, CARD_THEMES, type CardInput } from "../model/feishu-card.js";

const CardParams = Type.Object({
	body: Type.String({
		description:
			"Card body in Markdown. Lists, bold, links and tables render as written; fenced code blocks become Feishu code elements, so always fence code. This is the reply the user reads, so write the answer here.",
	}),
	title: Type.Optional(Type.String({ description: "Header title, one short line. Omit for a card with no header." })),
	theme: Type.Optional(
		Type.String({
			description: `Header colour, one of: ${CARD_THEMES.join(", ")}. Only used when a title is given. A successful result usually deserves "green", a failure or warning "orange" or "red".`,
		}),
	),
});

type CardParams = Static<typeof CardParams>;

export type SendCardTool = AnnotatedTool<typeof CardParams>;

export interface SendCardToolOptions {
	/** Replies with an interactive card in the thread of the incoming message. */
	reply: (card: unknown) => Promise<void>;
	/** Called after a card actually reached Feishu. */
	onSent?: () => void;
}

/**
 * Builds the tool for one run. `reply` closes over the message being answered —
 * the tool has no way to address another chat, so a run cannot post cards
 * wherever it likes.
 */
export function createSendCardTool(options: SendCardToolOptions): SendCardTool {
	return {
		name: "send_feishu_card",
		label: "Send Feishu card",
		description:
			"Send the reply to the user as a Feishu interactive card instead of plain text. Use it when the answer benefits from structure: tables, several sections, side-by-side comparisons, or when you want a coloured header to signal success or failure. For a short plain answer, just reply normally — do not send both.",
		metadata: { kind: "other", title: "Send Feishu card" },
		parameters: CardParams,
		execute: async (_toolCallId, params: CardParams) => {
			let card: unknown;
			try {
				const input: CardInput = {
					body: params.body,
					...(params.title !== undefined ? { title: params.title } : {}),
					...(params.theme !== undefined ? { theme: params.theme } : {}),
				};
				card = buildFeishuCard(input);
			} catch (error) {
				// Reported inline rather than thrown: the model can fix the body and
				// retry, and a thrown error would end the turn instead.
				return {
					content: [{ type: "text", text: `Card not sent: ${error instanceof Error ? error.message : String(error)}` }],
					details: { ok: false },
				};
			}
			try {
				await options.reply(card);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Card not sent: ${error instanceof Error ? error.message : String(error)}` }],
					details: { ok: false },
				};
			}
			options.onSent?.();
			return {
				content: [{ type: "text", text: "Card sent. The user is reading it now — do not repeat the same content as text." }],
				details: { ok: true },
			};
		},
	};
}
