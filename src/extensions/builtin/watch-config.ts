/**
 * Built-in plugin: watch triggers declared in `<cwd>/.steve/watch.json` (§5.5).
 *
 * The file is *data*, not code: every entry is validated here and by the engine,
 * and a bad entry is logged and skipped so one typo cannot keep the whole watch
 * set from loading — the same rule `mcp.json` follows. The plugin only declares
 * registrations; `createTriggerEngine` owns their lifecycle.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	TRIGGER_EVENT_TYPES,
	validateTrigger,
	type DedupeWindow,
	type PredicateExpr,
	type TriggerEventType,
	type TriggerRegistration,
	type TriggerSpec,
} from "../../features/trigger.js";
import type { ExtensionContext, PluginFactory } from "../api.js";

/** Relative to the session cwd. */
export const WATCH_CONFIG_PATH = ".steve/watch.json";

const SAFE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function text(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
	return value;
}

function optionalText(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	return text(value, field);
}

function dedupeOf(value: unknown, name: string): DedupeWindow | undefined {
	if (value === undefined) return undefined;
	if (!isObject(value)) throw new Error(`${name}.dedupe must be an object`);
	const key = value.key === undefined ? name : text(value.key, `${name}.dedupe.key`);
	const windowMs = value.windowMs;
	if (typeof windowMs !== "number" || !Number.isFinite(windowMs) || windowMs <= 0) {
		throw new Error(`${name}.dedupe.windowMs must be a positive number`);
	}
	return { key, windowMs };
}

function predicateOf(entry: Record<string, unknown>, name: string): PredicateExpr | undefined {
	if (entry.when === undefined) return undefined;
	if (!isObject(entry.when)) throw new Error(`${name}.when must be a JSON object`);
	return entry.when as PredicateExpr;
}

/** Turns one `.steve/watch.json` entry into a registration, or throws with a readable reason. */
export function buildRegistration(name: string, entry: unknown): TriggerRegistration {
	if (!SAFE_NAME.test(name)) throw new Error(`trigger name "${name}" must match ${SAFE_NAME.source}`);
	if (!isObject(entry)) throw new Error(`${name} must be an object`);

	const kind = entry.kind;
	if (kind !== "predicate" && kind !== "fs" && kind !== "cron" && kind !== "webhook") {
		throw new Error(`${name}.kind must be predicate, fs, cron or webhook`);
	}

	const prompt = text(entry.prompt, `${name}.prompt`);
	const targetStream = entry.targetStream;
	if (typeof targetStream !== "string" && typeof targetStream !== "function") {
		throw new Error(`${name}.targetStream must be a stream id or a function`);
	}
	const mode = entry.mode === undefined ? "background" : entry.mode;
	if (mode !== "foreground" && mode !== "background") throw new Error(`${name}.mode must be foreground or background`);
	const dedupe = dedupeOf(entry.dedupe, name);

	let spec: TriggerSpec;
	switch (kind) {
		case "predicate": {
			const on = entry.on;
			if (!Array.isArray(on) || on.length === 0) throw new Error(`${name}.on must be a non-empty array of event types`);
			for (const type of on) {
				if (typeof type !== "string" || !(TRIGGER_EVENT_TYPES as readonly string[]).includes(type)) {
					throw new Error(`${name}.on contains an unknown event type: ${String(type)}`);
				}
			}
			const when = predicateOf(entry, name);
			spec = { kind: "predicate", on: on as readonly TriggerEventType[], ...(when !== undefined ? { when } : {}), emit: { type: "user.message", text: prompt } };
			break;
		}
		case "fs": {
			const paths = entry.paths;
			if (!Array.isArray(paths) || paths.length === 0) throw new Error(`${name}.paths must be a non-empty array`);
			for (const path of paths) text(path, `${name}.paths[]`);
			const rawEvents = entry.events === undefined ? ["change"] : entry.events;
			if (!Array.isArray(rawEvents) || rawEvents.length === 0) throw new Error(`${name}.events must be a non-empty array`);
			for (const event of rawEvents) {
				if (event !== "rename" && event !== "change") throw new Error(`${name}.events must contain "rename" or "change"`);
			}
			const debounceMs = entry.debounceMs === undefined ? 2000 : entry.debounceMs;
			if (typeof debounceMs !== "number" || !Number.isFinite(debounceMs) || debounceMs <= 0) {
				throw new Error(`${name}.debounceMs must be a positive number`);
			}
			spec = {
				kind: "fs",
				paths: paths as string[],
				events: rawEvents as ("rename" | "change")[],
				debounceMs,
				emit: { type: "user.message", text: prompt },
			};
			break;
		}
		case "cron": {
			const cron = text(entry.cron, `${name}.cron`);
			const timezone = optionalText(entry.timezone, `${name}.timezone`);
			spec = { kind: "cron", cron, ...(timezone !== undefined ? { timezone } : {}), emit: { type: "user.message", text: prompt } };
			break;
		}
		default: {
			const path = text(entry.path, `${name}.path`);
			if (!path.startsWith("/")) throw new Error(`${name}.path must start with "/"`);
			const secret = optionalText(entry.secret, `${name}.secret`);
			const method = optionalText(entry.method, `${name}.method`);
			if (method !== undefined && method !== "POST") throw new Error(`${name}.method must be POST`);
			spec = { kind: "webhook", path, ...(secret !== undefined ? { secret } : {}), ...(method !== undefined ? { method: "POST" } : {}), emit: { type: "user.message", text: prompt } };
		}
	}

	return {
		name,
		spec,
		...(dedupe !== undefined ? { dedupe } : {}),
		targetStream: targetStream as string | ((detail: unknown) => string | undefined),
		mode,
	};
}

/** Reads the file, returning `undefined` when it does not exist. */
function readConfig(cwd: string, log: (message: string) => void): Record<string, unknown> | undefined {
	let raw: string;
	try {
		raw = readFileSync(join(cwd, WATCH_CONFIG_PATH), "utf8");
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === "ENOENT") return undefined;
		log(`could not read ${WATCH_CONFIG_PATH}: ${describe(error)}`);
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		log(`ignoring ${WATCH_CONFIG_PATH}: not valid JSON (${describe(error)})`);
		return undefined;
	}
	if (!isObject(parsed) || !isObject(parsed.triggers)) {
		log(`ignoring ${WATCH_CONFIG_PATH}: needs a "triggers" object`);
		return undefined;
	}
	return parsed.triggers;
}

export const watchConfig: PluginFactory = (api) => {
	const ctx: ExtensionContext = api.ctx;
	const triggers = readConfig(ctx.cwd, ctx.log);
	if (triggers === undefined) return;

	for (const [name, entry] of Object.entries(triggers)) {
		let registration: TriggerRegistration;
		try {
			registration = buildRegistration(name, entry);
			validateTrigger(registration, { cwd: ctx.cwd, roots: ctx.workspace.roots });
		} catch (error) {
			ctx.log(`skipping trigger "${name}": ${describe(error)}`);
			continue;
		}
		api.registerTrigger(registration);
	}
};
