/**
 * Trigger engine (§5.5): observes the outside world and turns a match into
 * input on a stream. It never calls the model — it appends `trigger.fired` and
 * a `user.message`, and whoever drives the stream (the worker) does the rest.
 *
 * Four sources share one pipeline: a predicate over new events, a file watcher,
 * a cron clock and webhook requests. Fire-storm guards live in {@link fire}:
 * dedupe window, per-trigger rate limit and causal depth, so a trigger that
 * reacts to its own output stops after a bounded chain.
 */
import { statSync, watch, type FSWatcher } from "node:fs";
import { resolve, sep } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { RunMode, StreamEvent, StreamEventBody } from "./events.js";
import type { Logger } from "../types.js";
import { compileGlob, isInside, isValidTimezone, nextCronTime, parseCron, type CompiledGlob, type CronSpec } from "./trigger-schedule.js";

export type TriggerSource = "predicate" | "fs" | "cron" | "webhook";

/** Event types a predicate may watch. */
export type TriggerEventType = StreamEventBody["type"];

export const TRIGGER_EVENT_TYPES: readonly TriggerEventType[] = [
	"user.message",
	"trigger.fired",
	"approval.pending",
	"approval.granted",
	"run.started",
	"run.cancel_requested",
	"run.settled",
	"run.failed",
	"run.cancelled",
	"run.turn.settled",
	"stream.created",
	"config.changed",
	"watch.armed",
	"watch.dedupe",
	"turn_start",
	"text_delta",
	"thinking_delta",
	"tool_start",
	"tool_update",
	"tool_end",
	"turn_end",
];

/* ── the restricted predicate DSL (§9: never eval) ───────────────────────── */

export type PredicateOp = "eq" | "neq" | "contains" | "matches" | "exists" | "gt" | "lt" | "in";

/** One condition: read `field` on the event, compare with `value`. */
export interface PredicateLeaf {
	field: string;
	op: PredicateOp;
	value?: unknown;
}

/** JSON-only expression tree; `all`/`any`/`not` compose leaves. */
export type PredicateExpr = PredicateLeaf | { all: readonly PredicateExpr[] } | { any: readonly PredicateExpr[] } | { not: PredicateExpr };

/** What a trigger writes when it fires — a message template for the target stream. */
export interface TemplateEvent {
	type: "user.message";
	/** `{{field.path}}` placeholders are filled from the trigger detail. */
	text: string;
}

export interface DedupeWindow {
	key: string;
	windowMs: number;
}

export type TriggerSpec =
	| { kind: "predicate"; on: readonly TriggerEventType[]; when?: PredicateExpr; emit: TemplateEvent }
	| { kind: "fs"; paths: readonly string[]; events: readonly ("rename" | "change")[]; debounceMs: number; emit: TemplateEvent }
	| { kind: "cron"; cron: string; timezone?: string; emit: TemplateEvent }
	| { kind: "webhook"; path: string; method?: "POST"; secret?: string; emit: TemplateEvent };

export interface TriggerRegistration {
	name: string;
	spec: TriggerSpec;
	/** Fire-storm guard: the same key fires at most once per window. */
	dedupe?: DedupeWindow;
	/** Where the input lands; a function resolves per fire and may return undefined. */
	targetStream: string | ((detail: unknown) => string | undefined);
	mode: RunMode;
}

export interface TriggerState {
	name: string;
	spec: TriggerSpec;
	lastFiredAt?: number;
	/** Why the last fire attempt was dropped, when it was. */
	suppressed?: string;
}

/** The slice of `StreamLog` the engine needs (kept structural: no runtime import). */
export interface TriggerLog {
	append(streamId: string, events: readonly (StreamEventBody & { ts?: number; causeId?: number })[]): Promise<{ first: number; last: number; events: StreamEvent[] }>;
	read(streamId: string, fromSeq?: number, limit?: number): Promise<StreamEvent[]>;
	subscribe(streamId: string, fromSeq: number, listener: (event: StreamEvent) => void): () => void;
}

/** Injectable clock/timer seam (tests advance time deterministically). */
export interface TriggerClock {
	now(): number;
	setTimer(callback: () => void, delayMs: number): unknown;
	clearTimer(handle: unknown): void;
}

export interface TriggerEngineOptions {
	log: TriggerLog;
	cwd?: string;
	roots?: readonly string[];
	logger?: Logger;
	/** Last-chance filter: return false to keep a registration dormant. */
	guard?: (registration: TriggerRegistration) => boolean;
	maxFiresPerMinute?: number;
	/** A fire whose source already has this many causes is dropped. */
	maxDepth?: number;
	clock?: TriggerClock;
}

export interface TriggerEngine {
	register(registration: TriggerRegistration): () => void;
	start(): Promise<void>;
	stop(): Promise<void>;
	list(): TriggerState[];
	/** Entry seam: hand one observed stream event to predicate triggers. */
	feed(event: StreamEvent): void;
	/** Entry seam: a webhook request; resolves true when any trigger accepted it. */
	handleWebhook(path: string, rawBody: string, headers: Record<string, string | undefined>): Promise<boolean>;
}

const SAFE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const SAFE_STREAM = /^[A-Za-z0-9_-]{1,128}$/;
const KNOWN_OPS = new Set<PredicateOp>(["eq", "neq", "contains", "matches", "exists", "gt", "lt", "in"]);
const KNOWN_EVENTS = new Set<string>(TRIGGER_EVENT_TYPES);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function fail(message: string): never {
	throw new Error(message);
}

function validatePredicate(expr: PredicateExpr): void {
	if (!isObject(expr)) fail("when must be a JSON object");
	if ("all" in expr) {
		if (!Array.isArray(expr.all) || expr.all.length === 0) fail("when.all must be a non-empty array");
		for (const item of expr.all) validatePredicate(item as PredicateExpr);
		return;
	}
	if ("any" in expr) {
		if (!Array.isArray(expr.any) || expr.any.length === 0) fail("when.any must be a non-empty array");
		for (const item of expr.any) validatePredicate(item as PredicateExpr);
		return;
	}
	if ("not" in expr) {
		validatePredicate(expr.not as PredicateExpr);
		return;
	}
	const leaf = expr as PredicateLeaf;
	if (typeof leaf.field !== "string" || leaf.field === "") fail("when.field must be a non-empty string");
	if (!KNOWN_OPS.has(leaf.op)) fail(`when.op must be one of ${[...KNOWN_OPS].join(", ")}`);
	if (leaf.op !== "exists" && leaf.value === undefined) fail(`when.op ${leaf.op} needs a value`);
}

/** Throw with a readable reason; the plugin loader logs the reason and skips. */
export function validateTrigger(registration: TriggerRegistration, options: { cwd: string; roots: readonly string[] }): void {
	if (typeof registration.name !== "string" || !SAFE_NAME.test(registration.name)) fail(`invalid trigger name ${JSON.stringify(registration.name)}`);
	if (registration.mode !== "foreground" && registration.mode !== "background") fail(`invalid mode ${JSON.stringify(registration.mode)}`);
	const target = registration.targetStream;
	if (typeof target === "string") {
		if (!SAFE_STREAM.test(target)) fail(`invalid targetStream ${JSON.stringify(target)}`);
	} else if (typeof target !== "function") {
		fail("targetStream must be a stream id or a function");
	}
	if (registration.dedupe !== undefined) {
		if (typeof registration.dedupe.key !== "string" || registration.dedupe.key === "") fail("dedupe.key must be a non-empty string");
		if (!Number.isFinite(registration.dedupe.windowMs) || registration.dedupe.windowMs <= 0) fail("dedupe.windowMs must be a positive number");
	}
	const spec = registration.spec;
	if (!isObject(spec)) fail("spec must be an object");
	switch (spec.kind) {
		case "predicate": {
			if (!Array.isArray(spec.on) || spec.on.length === 0) fail("predicate.on must be a non-empty array");
			for (const type of spec.on) {
				if (typeof type !== "string" || !KNOWN_EVENTS.has(type)) fail(`predicate.on has an unknown event type ${JSON.stringify(type)}`);
			}
			if (spec.when !== undefined) validatePredicate(spec.when);
			break;
		}
		case "fs": {
			if (!Array.isArray(spec.paths) || spec.paths.length === 0) fail("fs.paths must be a non-empty array");
			if (!Array.isArray(spec.events) || spec.events.length === 0) fail("fs.events must be a non-empty array");
			for (const event of spec.events) {
				if (event !== "rename" && event !== "change") fail(`fs.events contains ${JSON.stringify(event)}`);
			}
			if (!Number.isFinite(spec.debounceMs) || spec.debounceMs < 0) fail("fs.debounceMs must be >= 0");
			for (const pattern of spec.paths) {
				if (typeof pattern !== "string" || pattern === "") fail("fs.paths must contain strings");
				const compiled = compileGlob(pattern, options.cwd);
				if (!options.roots.some((root) => isInside(root, compiled.root))) fail(`fs path escapes the workspace: ${pattern}`);
			}
			break;
		}
		case "cron": {
			if (typeof spec.cron !== "string") fail("cron must be a string");
			parseCron(spec.cron);
			if (spec.timezone !== undefined && (typeof spec.timezone !== "string" || !isValidTimezone(spec.timezone))) {
				fail(`invalid timezone ${JSON.stringify(spec.timezone)}`);
			}
			break;
		}
		case "webhook": {
			if (typeof spec.path !== "string" || !spec.path.startsWith("/") || /\s/.test(spec.path)) fail(`webhook.path must start with "/": ${JSON.stringify(spec.path)}`);
			if (spec.method !== undefined && spec.method !== "POST") fail("webhook.method only supports POST");
			if (spec.secret !== undefined && (typeof spec.secret !== "string" || spec.secret.length < 8)) fail("webhook.secret must be at least 8 characters");
			break;
		}
		default:
			fail(`unknown trigger kind ${JSON.stringify((spec as { kind?: unknown }).kind)}`);
	}
	if (!isObject(spec.emit) || spec.emit.type !== "user.message" || typeof spec.emit.text !== "string" || spec.emit.text === "") {
		fail("spec.emit must be { type: \"user.message\", text }");
	}
}

/* ── predicates ─────────────────────────────────────────────────────────── */

function readField(value: unknown, path: string): unknown {
	let current = value;
	for (const part of path.split(".")) {
		if (!isObject(current)) return undefined;
		current = current[part];
	}
	return current;
}

function matchesLeaf(leaf: PredicateLeaf, event: StreamEvent): boolean {
	const actual = readField(event, leaf.field);
	switch (leaf.op) {
		case "exists":
			return actual !== undefined && actual !== null;
		case "eq":
			return actual === leaf.value;
		case "neq":
			return actual !== leaf.value;
		case "contains":
			return typeof actual === "string" ? actual.includes(String(leaf.value)) : Array.isArray(actual) ? actual.includes(leaf.value) : false;
		case "matches": {
			if (typeof actual !== "string") return false;
			try {
				return new RegExp(String(leaf.value)).test(actual);
			} catch {
				return false;
			}
		}
		case "gt":
			return typeof actual === "number" && typeof leaf.value === "number" && actual > leaf.value;
		case "lt":
			return typeof actual === "number" && typeof leaf.value === "number" && actual < leaf.value;
		case "in":
			return Array.isArray(leaf.value) && leaf.value.includes(actual);
		default:
			return false;
	}
}

function matchesPredicate(expr: PredicateExpr | undefined, event: StreamEvent): boolean {
	if (expr === undefined) return true;
	if ("all" in expr) return expr.all.every((item) => matchesPredicate(item, event));
	if ("any" in expr) return expr.any.some((item) => matchesPredicate(item, event));
	if ("not" in expr) return !matchesPredicate(expr.not, event);
	return matchesLeaf(expr, event);
}

/** `{{field}}` placeholders, replaced from the detail; unknown ones stay empty. */
export function renderTemplate(template: string, detail: unknown): string {
	return template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
		const value = readField(detail, path.trim());
		if (value === undefined || value === null) return "";
		if (typeof value === "string") return value;
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		return JSON.stringify(value);
	});
}

/** HMAC-SHA256 hex digest of the raw webhook body. */
export function webhookSignature(secret: string, rawBody: string): string {
	return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyWebhookSignature(secret: string, rawBody: string, signature: string | undefined): boolean {
	if (signature === undefined) return false;
	const expected = Buffer.from(webhookSignature(secret, rawBody), "utf8");
	const actual = Buffer.from(signature, "utf8");
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/* ── the engine ─────────────────────────────────────────────────────────── */

interface FsRuntime {
	watchers: FSWatcher[];
	debounces: Map<string, ReturnType<typeof setTimeout>>;
	pollers: ReturnType<typeof setInterval>[];
	polledMtimes: Map<string, number>;
}

interface Runtime {
	registration: TriggerRegistration;
	unsubscribe?: () => void;
	cronSpec?: CronSpec;
	timer?: unknown;
	fs?: FsRuntime;
	lastFiredAt?: number;
	suppressed?: string;
	rates: number[];
}

interface Options {
	log: TriggerLog;
	cwd: string;
	roots: readonly string[];
	logger: Logger;
	guard?: (registration: TriggerRegistration) => boolean;
	maxFiresPerMinute: number;
	maxDepth: number;
	clock: TriggerClock;
}

const DEFAULT_CLOCK: TriggerClock = {
	now: () => Date.now(),
	setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const streamPath = (streamId: string) => streamId;

export function createTriggerEngine(options: TriggerEngineOptions): TriggerEngine {
	const settings: Options = {
		log: options.log,
		cwd: options.cwd ?? process.cwd(),
		roots: options.roots ?? [options.cwd ?? process.cwd()],
		logger: options.logger ?? (() => {}),
		...(options.guard !== undefined ? { guard: options.guard } : {}),
		maxFiresPerMinute: options.maxFiresPerMinute ?? 30,
		maxDepth: options.maxDepth ?? 3,
		clock: options.clock ?? DEFAULT_CLOCK,
	};
	const runtimes = new Map<string, Runtime>();
	const causes = new Map<string, number>();
	const knownStreams = new Set<string>();
	let started = false;

	const causeKey = (streamId: string, seq: number): string => `${streamPath(streamId)}:${seq}`;

	const rememberCauses = (events: readonly StreamEvent[]): void => {
		for (const event of events) {
			if (event.causeId !== undefined) causes.set(causeKey(event.streamId, event.seq), event.causeId);
		}
	};

	const depthOf = (event: StreamEvent): number => {
		let depth = 0;
		const streamId = event.streamId;
		// Start from the event's own cause: listeners run while the just-appended
		// event is still being written, so the map may not know it yet.
		let cause: number | undefined = event.causeId;
		const seen = new Set<number>();
		while (cause !== undefined) {
			if (seen.has(cause)) break;
			seen.add(cause);
			depth += 1;
			cause = causes.get(causeKey(streamId, cause));
		}
		return depth;
	};

	const ensureStream = async (streamId: string): Promise<void> => {
		if (knownStreams.has(streamId)) return;
		const existing = await settings.log.read(streamId, 1, 1);
		if (existing.length > 0) {
			knownStreams.add(streamId);
			return;
		}
		const appended = await settings.log.append(streamId, [{ type: "stream.created", streamId, cwd: settings.cwd, ts: settings.clock.now() }]);
		knownStreams.add(streamId);
		rememberCauses(appended.events);
	};

	const append = async (streamId: string, events: readonly (StreamEventBody & { ts?: number; causeId?: number })[]): Promise<StreamEvent[]> => {
		await ensureStream(streamId);
		const appended = await settings.log.append(streamId, events);
		rememberCauses(appended.events);
		return appended.events;
	};

	const resolveTarget = (registration: TriggerRegistration, detail: unknown): string | undefined => {
		if (typeof registration.targetStream === "function") return registration.targetStream(detail);
		return registration.targetStream;
	};

	const recordSuppression = async (registration: TriggerRegistration, reason: string, streamId: string, detail: unknown): Promise<void> => {
		const runtime = runtimes.get(registration.name);
		if (runtime !== undefined) runtime.suppressed = reason;
		settings.logger(`[trigger ${registration.name}] suppressed: ${reason}`);
		try {
			await append(streamId, [{ type: "watch.dedupe", trigger: registration.name, reason }]);
		} catch (error) {
			settings.logger(`[trigger ${registration.name}] could not record suppression: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const fire = async (registration: TriggerRegistration, source: TriggerSource, detail: unknown, cause?: StreamEvent): Promise<boolean> => {
		const runtime = runtimes.get(registration.name);
		if (runtime === undefined) return false;
		if (settings.guard?.(registration) === false) {
			await recordSuppression(registration, "guard", resolveTarget(registration, detail) ?? registration.name, detail);
			return false;
		}
		const streamId = resolveTarget(registration, detail);
		if (streamId === undefined || !SAFE_STREAM.test(streamId)) {
			settings.logger(`[trigger ${registration.name}] no target stream for ${source} fire`);
			return false;
		}
		if (cause !== undefined && depthOf(cause) >= settings.maxDepth) {
			await recordSuppression(registration, "depth", streamId, detail);
			return false;
		}
		const now = settings.clock.now();
		const dedupeKey = registration.dedupe?.key ?? registration.name;
		const lastFired = runtime.lastFiredAt;
		void dedupeKey;
		if (registration.dedupe !== undefined) {
			const windowStart = (runtime as Runtime & { dedupeAt?: number }).dedupeAt ?? 0;
			if (now - windowStart < registration.dedupe.windowMs) {
				await recordSuppression(registration, "dedupe", streamId, detail);
				return false;
			}
		}
		runtime.rates = runtime.rates.filter((at) => now - at < 60_000);
		if (runtime.rates.length >= settings.maxFiresPerMinute) {
			await recordSuppression(registration, "rate", streamId, detail);
			return false;
		}
		const firedAt = now;
		try {
			// The fired event points back at the event that caused it, so a chain of
			// triggers has a real cause graph for the depth guard to walk.
			const fired = await append(streamId, [
				{ type: "trigger.fired", trigger: registration.name, source, detail, ts: firedAt, ...(cause !== undefined ? { causeId: cause.seq } : {}) },
			]);
			const firedEvent = fired.at(-1);
			runtime.lastFiredAt = firedAt;
			(runtime as Runtime & { dedupeAt?: number }).dedupeAt = firedAt;
			runtime.rates.push(firedAt);
			runtime.suppressed = undefined;
			const text = renderTemplate(registration.spec.emit.text, detail);
			await append(streamId, [{ type: "user.message", text: `[watch:${registration.name}] ${text}`, ts: firedAt, ...(firedEvent !== undefined ? { causeId: firedEvent.seq } : {}) }]);
			return true;
		} catch (error) {
			settings.logger(`[trigger ${registration.name}] fire failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	};

	const startFs = (registration: TriggerRegistration & { spec: Extract<TriggerSpec, { kind: "fs" }> }, runtime: Runtime): void => {
		const state: FsRuntime = { watchers: [], debounces: new Map(), pollers: [], polledMtimes: new Map() };
		runtime.fs = state;
		const compiled: CompiledGlob[] = registration.spec.paths.map((pattern) => compileGlob(pattern, settings.cwd));
		const roots = [...new Set(compiled.map((glob) => glob.root))];
		const fireFor = (path: string, event: "rename" | "change"): void => {
			const existing = state.debounces.get(path);
			if (existing !== undefined) clearTimeout(existing);
			const timer = setTimeout(() => {
				state.debounces.delete(path);
				void fire(registration, "fs", { path, event });
			}, registration.spec.debounceMs);
			timer.unref?.();
			state.debounces.set(path, timer);
		};
		const onEvent = (eventType: string, filename: string | null): void => {
			if (!started || filename === null || filename === undefined || filename === "") return;
			const event = eventType === "rename" ? "rename" : "change";
			if (!registration.spec.events.includes(event)) return;
			const absolute = resolve(roots[0] as string, filename).split(sep).join("/");
			if (!compiled.some((glob) => glob.regex.test(absolute))) return;
			fireFor(absolute, event);
		};
		let watching = false;
		for (const root of roots) {
			try {
				const watcher = watch(root, { recursive: true }, (eventType, filename) => onEvent(String(eventType), filename === null ? null : String(filename)));
				watcher.on("error", (error) => settings.logger(`[trigger ${registration.name}] watcher error: ${error.message}`));
				state.watchers.push(watcher);
				watching = true;
			} catch (error) {
				settings.logger(`[trigger ${registration.name}] recursive watch unavailable on ${root}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (!watching) {
			// Fallback: poll literal paths only — no directory traversal, no new dependency.
			const literals = compiled.filter((glob) => glob.literalPath !== undefined);
			for (const literal of literals) {
				try {
					state.polledMtimes.set(literal.literalPath as string, statSync(literal.literalPath as string).mtimeMs);
				} catch {
					state.polledMtimes.set(literal.literalPath as string, 0);
				}
			}
			if (literals.length > 0) {
				const poller = setInterval(() => {
					if (!started) return;
					for (const literal of literals) {
						const path = literal.literalPath as string;
						try {
							const mtime = statSync(path).mtimeMs;
							if (mtime !== state.polledMtimes.get(path)) {
								state.polledMtimes.set(path, mtime);
								fireFor(path, "change");
							}
						} catch {
							// Missing file: report the first time it disappears.
							if (state.polledMtimes.get(path) !== 0) {
								state.polledMtimes.set(path, 0);
								fireFor(path, "rename");
							}
						}
					}
				}, 2000);
				poller.unref?.();
				state.pollers.push(poller);
			}
		}
	};

	const stopFs = (runtime: Runtime): void => {
		const state = runtime.fs;
		if (state === undefined) return;
		for (const watcher of state.watchers) {
			try {
				watcher.close();
			} catch {
				// Already closed.
			}
		}
		for (const timer of state.debounces.values()) clearTimeout(timer);
		for (const poller of state.pollers) clearInterval(poller);
		state.watchers = [];
		state.debounces.clear();
		state.pollers = [];
		runtime.fs = undefined;
	};

	const scheduleCron = (runtime: Runtime): void => {
		const spec = runtime.registration.spec;
		if (spec.kind !== "cron") return;
		if (runtime.cronSpec === undefined) runtime.cronSpec = parseCron(spec.cron);
		const timezone = spec.timezone;
		const next = nextCronTime(runtime.cronSpec, settings.clock.now(), timezone);
		runtime.timer = settings.clock.setTimer(() => {
			if (!started) return;
			const scheduledAt = next;
			const now = settings.clock.now();
			if (now - scheduledAt > 60_000) {
				// The process slept through the slot: do not replay it, just record why.
				const target = resolveTarget(runtime.registration, { scheduledAt }) ?? runtime.registration.name;
				void recordSuppression(runtime.registration, "missed", SAFE_STREAM.test(target) ? target : runtime.registration.name, { scheduledAt });
			} else {
				void fire(runtime.registration, "cron", { scheduledAt, at: new Date(now).toISOString() });
			}
			if (started) scheduleCron(runtime);
		}, Math.max(0, next - settings.clock.now()));
	};

	const arm = async (runtime: Runtime): Promise<void> => {
		const registration = runtime.registration;
		const spec = registration.spec;
		// Record that this trigger is watching, on the stream it will write to.
		const staticTarget = typeof registration.targetStream === "string" ? registration.targetStream : undefined;
		if (staticTarget !== undefined && SAFE_STREAM.test(staticTarget)) {
			try {
				await append(staticTarget, [{ type: "watch.armed", trigger: registration.name, spec }]);
			} catch (error) {
				settings.logger(`[trigger ${registration.name}] could not record watch.armed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (spec.kind === "predicate" && typeof registration.targetStream === "string") {
			const streamId = registration.targetStream;
			const on = new Set<string>(spec.on);
			runtime.unsubscribe = settings.log.subscribe(streamId, 1, (event) => {
				if (!started || !on.has(event.type)) return;
				if (!matchesPredicate(spec.when, event)) return;
				void fire(registration, "predicate", { event: event.type, seq: event.seq, streamId: event.streamId }, event);
			});
		} else if (spec.kind === "cron") {
			scheduleCron(runtime);
		} else if (spec.kind === "fs") {
			startFs(registration as TriggerRegistration & { spec: Extract<TriggerSpec, { kind: "fs" }> }, runtime);
		}
	};

	const register = (registration: TriggerRegistration): (() => void) => {
		validateTrigger(registration, { cwd: settings.cwd, roots: settings.roots });
		if (runtimes.has(registration.name)) fail(`duplicate trigger name ${JSON.stringify(registration.name)}`);
		const runtime: Runtime = { registration, rates: [] };
		runtimes.set(registration.name, runtime);
		if (started) void arm(runtime);
		return () => {
			const current = runtimes.get(registration.name);
			if (current === undefined) return;
			current.unsubscribe?.();
			if (current.timer !== undefined) settings.clock.clearTimer(current.timer);
			stopFs(current);
			runtimes.delete(registration.name);
		};
	};

	const feed = (event: StreamEvent): void => {
		rememberCauses([event]);
		if (!started) return;
		for (const runtime of runtimes.values()) {
			const spec = runtime.registration.spec;
			if (spec.kind !== "predicate") continue;
			if (!spec.on.includes(event.type)) continue;
			if (!matchesPredicate(spec.when, event)) continue;
			void fire(runtime.registration, "predicate", { event: event.type, seq: event.seq, streamId: event.streamId }, event);
		}
	};

	const handleWebhook = async (path: string, rawBody: string, headers: Record<string, string | undefined>): Promise<boolean> => {
		if (!started) return false;
		let accepted = false;
		for (const runtime of runtimes.values()) {
			const spec = runtime.registration.spec;
			if (spec.kind !== "webhook" || spec.path !== path) continue;
			if (spec.secret !== undefined) {
				const signature = headers["x-signature"] ?? headers["X-Signature"];
				if (!verifyWebhookSignature(spec.secret, rawBody, signature)) {
					settings.logger(`[trigger ${runtime.registration.name}] webhook signature rejected`);
					continue;
				}
			}
			let body: unknown = rawBody;
			try {
				body = rawBody === "" ? {} : JSON.parse(rawBody);
			} catch {
				body = rawBody;
			}
			if (await fire(runtime.registration, "webhook", { path, body, method: "POST" })) accepted = true;
		}
		return accepted;
	};

	const start = async (): Promise<void> => {
		if (started) return;
		started = true;
		for (const runtime of runtimes.values()) await arm(runtime);
	};

	const stop = async (): Promise<void> => {
		started = false;
		for (const runtime of runtimes.values()) {
			runtime.unsubscribe?.();
			runtime.unsubscribe = undefined;
			if (runtime.timer !== undefined) {
				settings.clock.clearTimer(runtime.timer);
				runtime.timer = undefined;
			}
			stopFs(runtime);
		}
	};

	const list = (): TriggerState[] =>
		[...runtimes.values()].map((runtime) => ({
			name: runtime.registration.name,
			spec: runtime.registration.spec,
			...(runtime.lastFiredAt !== undefined ? { lastFiredAt: runtime.lastFiredAt } : {}),
			...(runtime.suppressed !== undefined ? { suppressed: runtime.suppressed } : {}),
		}));

	return { register, start, stop, list, feed, handleWebhook };
}

/** Re-exported so tests and the watch config can validate expressions without a second parser. */
