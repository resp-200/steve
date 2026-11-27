/**
 * The tool contract the functional layer hands to the layers above.
 *
 * Protocol layers may declare tools, but they do so through this module, so
 * they never import a pi package directly.
 */
export { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
/**
 * The pi stream contract, for layers that run a one-off request (compaction).
 * Named here so a feature never imports pi itself: only the model adapter builds
 * a real one, and only the kernel hands one out.
 */
export type StreamFn = (model: any, context: any, options?: any) => Promise<AsyncIterable<{ type: string; partial?: unknown }>> | AsyncIterable<{ type: string; partial?: unknown }>;
export type StreamModel = { id: string; api: string; baseUrl: string };
export type StreamContext = { systemPrompt?: string; messages: readonly any[]; tools?: readonly any[] };
export type {
	AgentMessage,
	AgentTool,
	AfterToolCallContext,
	AfterToolCallResult,
	BeforeToolCallContext,
	BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";

/**
 * Web search settings, as the console sees them. The capability implements this;
 * the admin entry only renders it. Declared here so the entry never imports the
 * capability — the same rule that keeps a protocol layer from reaching into a
 * feature's internals.
 */
export interface SearchProviderState {
	id: string;
	label: string;
	/** Still works with nothing configured. */
	keyless: boolean;
	envKey?: string;
	hasKey: boolean;
	/** Where to get a key. Keyless providers have none. */
	signup?: string;
	/** What this source answers well — the same words the model is told. */
	blurb: string;
	/** Keyless, or its key is present. */
	usable: boolean;
}

/** The console's whole view of web search. Keys themselves never appear here. */
export interface SearchConfigView {
	providers: SearchProviderState[];
	keyless: string[];
	/** What `web_search` would use right now, or null when it is not registered. */
	active: string | null;
	requested: string | null;
	/** A named provider missing its key disables search instead of falling back. */
	pinned: boolean;
}

/** Result of one real query, for the console's "test" button. */
export interface SearchProbe {
	ok: boolean;
	provider: string;
	elapsedMs: number;
	count?: number;
	sample?: { title: string; url: string }[];
	error?: string;
}

/** What the capability exposes to the admin entry. */
export interface SearchSettingsApi {
	/** Environment variable that holds each provider's key. */
	readonly keyEnv: Record<string, string>;
	view(): SearchConfigView;
	save(input: { keys?: Record<string, string>; provider?: string }): Promise<string[]>;
	clear(id: string): Promise<string>;
	probe(id: string, options?: { query?: string; key?: string }): Promise<SearchProbe>;
}
