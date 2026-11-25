import type { Model, ProviderId } from "@earendil-works/pi-ai";

/**
 * Per-provider request headers — the "standard" for gateways that need a custom
 * header (routing, attribution, quota buckets, session affinity).
 *
 * Stored on each provider in `.steve/admin.json`:
 *
 *   "headers": { "x-opencode-session": "", "X-Client": "steve/{sessionId}" }
 *
 * Rules (each one is a decision, not an implementation detail):
 *
 * 1. **Values are templates.** A value may contain `${sessionId}` or any of its
 *    aliases (`${session}`, `${conversationId}`, `${threadId}`, `${chatId}`) —
 *    they all expand to the same per-conversation id (see
 *    `sessionHeaderValue`). Other `${...}` names are rejected at save time so a
 *    typo is an error instead of a literal string sent to the provider.
 * 2. **Hosts decide where the headers may go.** `hosts` (optional) narrows them
 *    to the listed hosts; without it they apply exactly when the request goes to
 *    the provider's own host. A provider whose baseUrl was changed therefore
 *    never sends headers that belong somewhere else.
 * 3. **The session header is opt-in.** Nothing is sent unless the provider
 *    configured `x-opencode-session` (an empty or `${sessionId}` value means
 *    "fill it in"). Plain OpenAI/Anthropic gateways, including a hand-written
 *    `.env` provider, are byte-for-byte unchanged.
 * 4. **Auto wins, manual is the fallback.** For the session header the real
 *    conversation id is used; without one the manual value stands; without both
 *    the provider id is the last resort. A static value is always sent verbatim.
 * 5. **Header values stay visible in the console.** They are connection info
 *    like baseUrl; only apiKey is masked.
 *
 * This module is the model layer's view of the provider (the same seam as
 * `Model`): `features/admin-config.ts` owns persistence and adapts its
 * `ProviderEntry` to `RequestHeadersProvider`.
 */
export interface RequestHeadersProvider {
	/** Stable id, the last resort for the session header. */
	readonly id: string;
	readonly baseUrl: string;
	readonly headers?: Record<string, string>;
	/** Hosts the headers apply to; absent = the provider's own host only. */
	readonly hosts?: readonly string[];
}

/** The header OpenCode Go requires for routing and prompt caching. */
export const SESSION_HEADER = "x-opencode-session";

/** Placeholder names that all mean "this conversation". */
export const SESSION_PLACEHOLDERS = ["sessionId", "session", "conversationId", "threadId", "chatId"] as const;

const PLACEHOLDER = /\$\{([A-Za-z0-9_]*)\}/g;

/** Uppercase for OpenAI's convention; the SDKs also send lowercase, so the choice is cosmetic. */
export function normalizeHeaderName(name: string): string {
	return name.trim().toLowerCase();
}

export function isSessionPlaceholder(name: string): boolean {
	return (SESSION_PLACEHOLDERS as readonly string[]).includes(name);
}

/**
 * Strict normalisation for input coming from the console or a plugin. Throws with
 * a readable message: headers are edited in a form, so the console can show it.
 */
export function normalizeRequestHeaders(raw: unknown): Record<string, string> {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("headers must be an object of name → value");
	const out: Record<string, string> = {};
	for (const [rawName, rawValue] of Object.entries(raw as Record<string, unknown>)) {
		const name = normalizeHeaderName(rawName);
		if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) throw new Error(`invalid header name "${rawName}"`);
		if (typeof rawValue !== "string") throw new Error(`header "${rawName}" must be a string`);
		const value = rawValue.trim();
		for (const [, placeholder] of value.matchAll(PLACEHOLDER)) {
			if (!isSessionPlaceholder(placeholder ?? "")) {
				throw new Error(`header "${rawName}" uses unknown placeholder \${${placeholder}} (only \${sessionId} is supported)`);
			}
		}
		if (/[\r\n]/.test(value)) throw new Error(`header "${rawName}" must not contain line breaks`);
		out[name] = value;
	}
	return out;
}

/** Tolerant read of the persisted file: one bad entry must not hide the rest. */
export function coerceRequestHeaders(raw: unknown, onDrop?: (message: string) => void): Record<string, string> {
	try {
		return normalizeRequestHeaders(raw);
	} catch (error) {
		onDrop?.(`ignored provider headers: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
}

/** `host` from a baseUrl; `undefined` when it does not parse (a broken baseUrl is caught elsewhere). */
export function hostOf(baseUrl: string): string | undefined {
	try {
		return new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

/**
 * Whether `provider` opted into the session header.
 *
 * Configuring the header at all — including the empty value, which is how "let
 * steve fill it with the conversation id" is spelled — counts as opting in.
 */
export function sessionHeaderConfigured(provider: RequestHeadersProvider): boolean {
	return provider.headers !== undefined && Object.hasOwn(provider.headers, SESSION_HEADER);
}

/** Hostnames known to route by session id (used by the console hint, never to add a header). */
export const SESSION_HOSTS = ["opencode.ai"];

/** Is `provider`'s baseUrl an OpenCode host? */
export function sessionHeaderHost(provider: RequestHeadersProvider): boolean {
	const host = hostOf(provider.baseUrl);
	return host !== undefined && SESSION_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}

/** Do this provider's headers belong on a request to `host`? */
export function headersApplyTo(provider: RequestHeadersProvider, host: string | undefined): boolean {
	if (host === undefined) return false;
	const hosts = (provider.hosts ?? []).map((entry) => entry.toLowerCase());
	if (hosts.length > 0) return hosts.includes(host);
	const own = hostOf(provider.baseUrl);
	return own !== undefined && own === host;
}

/**
 * Expand `${...}` placeholders; a placeholder without a session id becomes an
 * empty string. Callers drop the header when the expanded value ends up empty —
 * sending `x-opencode-session: ""` is worse than sending nothing.
 */
function expand(value: string, sessionId: string | undefined): string {
	return value.replace(PLACEHOLDER, () => sessionId ?? "");
}

function isBarePlaceholder(value: string): boolean {
	return isSessionPlaceholder(value.trim().replace(/^\$\{|\}$/g, ""));
}

/**
 * The value of the session header for one request.
 *
 * "Auto wins, manual is the fallback": an empty or template value gets the real
 * conversation id; without a conversation the manual value is then used as-is
 * (a template there has nothing to expand); without both the caller's
 * `lastResort` is used. A static manual value is the user's explicit choice.
 */
export function sessionHeaderValue(configured: string | undefined, options: { sessionId?: string; lastResort?: string }): string | undefined {
	const manual = configured?.trim() ?? "";
	if (manual === "" || isBarePlaceholder(manual)) return options.sessionId ?? options.lastResort;
	return expand(manual, options.sessionId);
}

export interface HeadersContext {
	/** Conversation id (stream/session); absent for a one-shot CLI invocation. */
	sessionId?: string;
	/** Last resort when neither the conversation nor a manual value exists (provider id). */
	fallback?: string;
}

/**
 * The headers a provider contributes to a request going to `host`.
 * Both sides of every name are compared case-insensitively by `applyHeaders`.
 */
export function providerHeaders(provider: RequestHeadersProvider, host: string | undefined, context: HeadersContext = {}): Record<string, string> {
	if (!headersApplyTo(provider, host)) return {};
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(provider.headers ?? {})) {
		const expanded = expand(value, context.sessionId);
		if (expanded === "") continue;
		out[name] = expanded;
	}
	if (sessionHeaderConfigured(provider)) {
		const session = sessionHeaderValue(provider.headers?.[SESSION_HEADER], { sessionId: context.sessionId, lastResort: context.fallback ?? provider.id });
		if (session !== undefined && session !== "") out[SESSION_HEADER] = session;
	}
	return out;
}

/**
 * Copy `source` onto `target` for keys `target` does not already have
 * (case-insensitive). Existing headers always win: what the caller (or the auth
 * layer) set is more specific than a provider default.
 */
export function applyHeaders(target: Record<string, string>, source: Record<string, string>): void {
	const taken = new Set(Object.keys(target).map(normalizeHeaderName));
	for (const [name, value] of Object.entries(source)) {
		const key = normalizeHeaderName(name);
		if (taken.has(key)) continue;
		target[key] = value;
		taken.add(key);
	}
}
