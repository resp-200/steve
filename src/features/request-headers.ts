/**
 * Provider request headers from the console's point of view.
 *
 * The standard itself lives in `model/request-headers.ts` (the model layer may
 * not import this layer), together with the rule that *nothing is sent unless
 * the provider configured the header*. This module is the adapter that turns the
 * persisted `ProviderEntry` into that contract and keeps the file's
 * `requestSessionHeader` opt-out working.
 */
import type { ProviderEntry } from "./admin-config.js";
import { providerHeaders, sessionHeaderConfigured } from "../model/request-headers.js";

export {
	SESSION_HEADER,
	SESSION_HOSTS,
	SESSION_PLACEHOLDERS,
	applyHeaders,
	coerceRequestHeaders,
	headersApplyTo,
	hostOf,
	isSessionPlaceholder,
	normalizeHeaderName,
	normalizeRequestHeaders,
	sessionHeaderHost,
	sessionHeaderValue,
} from "../model/request-headers.js";

/**
 * Should `provider` be sent a session header?
 *
 * Computation lives in the model layer; this only honours the console's explicit
 * `requestSessionHeader: true|false` override, which has no room in the neutral
 * contract. `true` forces the header on (a proxy in front of OpenCode), `false`
 * turns it off even when a value is configured.
 */
export function sessionHeaderProvider(provider: ProviderEntry): boolean {
	if (provider.requestSessionHeader === false) return false;
	if (provider.requestSessionHeader === true) return true;
	return sessionHeaderConfigured(provider);
}

/** The headers a provider contributes to a request, honouring the console override. */
export function providerEntryHeaders(provider: ProviderEntry): Record<string, string> {
	const own = providerHeaders(provider, hostOfProvider(provider), {});
	if (sessionHeaderProvider(provider)) return own;
	const withoutSession = { ...own };
	delete withoutSession["x-opencode-session"];
	return withoutSession;
}

function hostOfProvider(provider: ProviderEntry): string | undefined {
	try {
		return new URL(provider.baseUrl).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}
