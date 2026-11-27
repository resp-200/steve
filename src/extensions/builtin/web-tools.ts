/**
 * Built-in plugin (Tier 1): network lookups — `web_search` and `web_fetch`.
 *
 * Like the local tools, this is a *capability*, so it lives in a plugin and the
 * front ends never learn the tool names. What it needs from the outside is one
 * thing: a search provider, configured in `~/.steve/.env`:
 *
 *   WEB_SEARCH_PROVIDER=tavily        (or exa / brave; unset = first with a key)
 *   TAVILY_API_KEY=tvly-...
 *
 * `web_search` is registered only when a provider has a key — `/tools` must never
 * list a tool that cannot work. `web_fetch` needs no key and is always
 * registered.
 *
 * Both tools are read-only and declare `permission: "auto"`. A lookup changes
 * nothing on the machine, and making the user approve every one of them teaches
 * the model to stop looking things up — which is the whole point of adding them.
 * The gates that still matter are inside the capability: `web_fetch` refuses
 * non-public addresses (steve often runs inside an intranet, where
 * `169.254.169.254` hands out cloud credentials), follows redirects only within
 * one origin, and caps what it reads.
 *
 * It is a Tier 1 plugin: shipped with the product, loaded by default, and its
 * failure is reported loudly rather than silently skipped.
 */
import { createWebTools, resolveSearchProvider } from "../../features/web-tools.js";
import type { ExtensionAPI, PluginTool } from "../api.js";

export function webTools(pi: ExtensionAPI): void {
	const provider = resolveSearchProvider(process.env, (message) => pi.ctx.log(message));
	if (!provider) {
		pi.ctx.log(
			"web_search not registered: set TAVILY_API_KEY, EXA_API_KEY or BRAVE_API_KEY in ~/.steve/.env, " +
				"or unset WEB_SEARCH_PROVIDER to use the keyless DuckDuckGo fallback. web_fetch stays available.",
		);
	}

	for (const tool of createWebTools(provider ? { provider } : {})) {
		// The tool already carries its annotations (permission / metadata / describe);
		// hand them straight through like the other built-in plugins do.
		pi.registerTool(tool as unknown as PluginTool);
	}
	pi.ctx.log(`web tools: ${provider ? `${provider.id} search + fetch` : "fetch only"}`);
}
