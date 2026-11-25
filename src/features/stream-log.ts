/**
 * Append-only event log for a conversation stream (`docs/personal-agent.md` §5.1).
 *
 * The log is the source of truth: every event is one JSON line, appended and
 * fsynced, so a crash can never leave a half-written transcript that hides
 * earlier events. Files rotate at `rotateBytes` (8 MiB) without resetting `seq`;
 * each file starts with a `{ firstSeq }` header so a reader can locate a `seq`
 * without trusting file names. A torn last line is skipped — the prefix before
 * it is still complete.
 *
 * Layout:
 * ```
 * <dir>/<streamId>/meta.json    { streamId, cwd, title?, createdAt }
 * <dir>/<streamId>/0001.jsonl   { firstSeq } header, then one event per line
 * <dir>/<streamId>/0002.jsonl
 * <dir>/<streamId>/cursor.json  { lastSeq, updatedAt }  (best effort)
 * ```
 */
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync as fsReadSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { steveHomeDir } from "../model/config.js";
import type { Logger } from "../types.js";
import type { PromptImage, StreamEvent, StreamEventBody } from "./events.js";

/** 8 MiB per file: large enough to be cheap, small enough to read on demand. */
export const DEFAULT_ROTATE_BYTES = 8 * 1024 * 1024;
/** One event above this is truncated before writing (§5.3 体积策略). */
export const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;

const SAFE_STREAM_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_FILE = /^\d{4,}\.jsonl$/;

/** Stream ids are ours (session ids, or ids we hand to `--resume`). */
export function isStreamId(id: unknown): id is string {
	return typeof id === "string" && SAFE_STREAM_ID.test(id);
}

export interface StreamLogOptions {
	/** Default: `~/.steve/streams`. */
	dir?: string;
	logger?: Logger;
	/** Soft cap per file; rotation never resets `seq`. Default 8 MiB. */
	rotateBytes?: number;
	/** Events larger than this are truncated and flagged `truncated`. Default 64 KiB. */
	maxEventBytes?: number;
}

/**
 * Append input: the event body plus optional envelope hints. `ts` lets the
 * session-store compatibility layer keep a message's original timestamp; when
 * omitted the log assigns "now". `seq` and `streamId` are always assigned here.
 */
export type StreamEventInput = StreamEventBody & { ts?: number; causeId?: number };

export interface AppendedEvents {
	first: number;
	last: number;
	/** The events as written, envelope included (lets callers update their cache). */
	events: StreamEvent[];
}

export interface StreamSummary {
	streamId: string;
	cwd: string;
	title?: string;
	createdAt: number;
	updatedAt: number;
	lastSeq: number;
}

export interface StreamLog {
	readonly dir: string;
	append(streamId: string, events: readonly StreamEventInput[]): Promise<AppendedEvents>;
	read(streamId: string, fromSeq?: number, limit?: number): Promise<StreamEvent[]>;
	/** Replays history from `fromSeq`, then keeps delivering new events. */
	subscribe(streamId: string, fromSeq: number, listener: (event: StreamEvent) => void): () => void;
	listStreams(): Promise<StreamSummary[]>;
	remove(streamId: string): Promise<void>;
	close(): void;
}

interface StreamMeta {
	streamId: string;
	cwd: string;
	title?: string;
	createdAt: number;
}

interface StreamState {
	meta: StreamMeta;
	lastSeq: number;
	fileNo: number;
	fileSize: number;
}

interface Cursor {
	lastSeq: number;
	updatedAt: number;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Cut a string so it fits `budget` UTF-8 bytes (never splits multi-byte chars). */
function clip(text: string, budget: number): string {
	if (budget <= 0) return "";
	if (Buffer.byteLength(text) <= budget) return text;
	let end = Math.min(text.length, budget);
	while (end > 0 && Buffer.byteLength(text.slice(0, end)) > budget) end -= 1;
	return text.slice(0, end);
}

function isEventRecord(value: unknown): value is StreamEvent {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.seq === "number" && typeof record.streamId === "string" && typeof record.type === "string";
}

function isHeaderRecord(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.firstSeq === "number" && record.type === undefined;
}

export function createStreamLog(options: StreamLogOptions = {}): StreamLog {
	const dir = resolve(options.dir ?? join(steveHomeDir(), "streams"));
	const logger = options.logger ?? ((): void => {});
	const rotateBytes = options.rotateBytes ?? DEFAULT_ROTATE_BYTES;
	const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
	const states = new Map<string, StreamState>();
	const listeners = new Map<string, Set<(event: StreamEvent) => void>>();

	const streamDir = (streamId: string): string => join(dir, streamId);
	const fileFor = (streamId: string, fileNo: number): string => join(dir, streamId, `${String(fileNo).padStart(4, "0")}.jsonl`);

	const listEventFiles = (streamId: string): string[] => {
		try {
			return readdirSync(streamDir(streamId))
				.filter((name) => EVENT_FILE.test(name))
				.sort();
		} catch {
			return [];
		}
	};

	const readJson = <T>(path: string): T | undefined => {
		try {
			return JSON.parse(readFileSync(path, "utf8")) as T;
		} catch {
			return undefined;
		}
	};

	const readMeta = (streamId: string): StreamMeta | undefined => {
		const meta = readJson<StreamMeta>(join(dir, streamId, "meta.json"));
		if (!meta || typeof meta.streamId !== "string" || typeof meta.cwd !== "string") return undefined;
		return meta;
	};

	const readCursor = (streamId: string): Cursor | undefined => {
		const cursor = readJson<Cursor>(join(dir, streamId, "cursor.json"));
		if (!cursor || typeof cursor.lastSeq !== "number") return undefined;
		return cursor;
	};

	/** Walks files backwards for the last parseable event (`cursor.json` may be stale). */
	const scanLast = (streamId: string, files: readonly string[]): { lastSeq: number; updatedAt?: number } => {
		for (let fileIndex = files.length - 1; fileIndex >= 0; fileIndex -= 1) {
			const name = files[fileIndex];
			if (name === undefined) continue;
			let text = "";
			try {
				text = readFileSync(join(streamDir(streamId), name), "utf8");
			} catch {
				continue;
			}
			const lines = text.split("\n");
			for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
				const line = lines[lineIndex]?.trim() ?? "";
				if (line === "") continue;
				try {
					const parsed = JSON.parse(line) as unknown;
					if (isEventRecord(parsed)) return { lastSeq: parsed.seq, updatedAt: parsed.ts };
				} catch {
					// A torn last line: keep looking for the event before it.
				}
			}
		}
		return { lastSeq: 0 };
	};

	/** A crash can leave a torn last line without its newline; the next append must not glue onto it. */
	const endsWithNewline = (path: string, size: number): boolean => {
		if (size === 0) return true;
		let fd: number | undefined;
		try {
			fd = openSync(path, "r");
			const byte = Buffer.allocUnsafe(1);
			return fsReadSync(fd, byte, 0, 1, size - 1) === 1 && byte[0] === 0x0a;
		} catch {
			return true;
		} finally {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {
					// Nothing to release that matters here.
				}
			}
		}
	};

	const loadState = (streamId: string): StreamState => {
		const cached = states.get(streamId);
		if (cached) return cached;

		const meta = readMeta(streamId) ?? { streamId, cwd: process.cwd(), createdAt: Date.now() };
		const files = listEventFiles(streamId);
		const lastFile = files[files.length - 1];
		const fileNo = lastFile === undefined ? 0 : Number(lastFile.split(".")[0]);
		let fileSize = 0;
		if (lastFile !== undefined) {
			try {
				fileSize = statSync(join(streamDir(streamId), lastFile)).size;
			} catch {
				fileSize = 0;
			}
		}
		const cursor = readCursor(streamId);
		const lastSeq = cursor?.lastSeq ?? scanLast(streamId, files).lastSeq;
		const state: StreamState = { meta, lastSeq, fileNo, fileSize };
		states.set(streamId, state);
		return state;
	};

	const ensureStreamDir = (streamId: string, state: StreamState, created?: StreamEventInput): void => {
		const path = streamDir(streamId);
		if (!existsSync(path)) mkdirSync(path, { recursive: true });
		if (existsSync(join(path, "meta.json"))) return;
		const meta: StreamMeta = {
			streamId,
			cwd: created !== undefined && created.type === "stream.created" ? created.cwd : state.meta.cwd,
			...(created !== undefined && created.type === "stream.created" && created.title !== undefined ? { title: created.title } : {}),
			createdAt: state.meta.createdAt,
		};
		try {
			writeFileSync(join(path, "meta.json"), `${JSON.stringify(meta)}\n`, "utf8");
		} catch (error) {
			logger(`[stream-log] could not write meta for ${streamId}: ${describe(error)}`);
		}
	};

	const writeCursor = (streamId: string, lastSeq: number, updatedAt: number): void => {
		try {
			writeFileSync(join(streamDir(streamId), "cursor.json"), `${JSON.stringify({ lastSeq, updatedAt })}\n`, "utf8");
		} catch (error) {
			logger(`[stream-log] could not write cursor for ${streamId}: ${describe(error)}`);
		}
	};

	/** Truncates an over-limit event while keeping what `foldTranscript` can still use. */
	const boundEvent = (event: StreamEvent, maxBytes: number, streamId: string): StreamEvent => {
		const serialized = JSON.stringify(event);
		if (Buffer.byteLength(serialized) <= maxBytes) return event;

		logger(`[stream-log] event ${event.type} #${event.seq} in ${streamId} exceeds ${maxBytes} bytes; truncating`);
		const head = { seq: event.seq, streamId: event.streamId, ts: event.ts, truncated: true as const };
		const overhead = Buffer.byteLength(JSON.stringify({ ...head, type: event.type })) + 64;

		if (event.type === "user.message") {
			// Keep the text (context matters); images are dropped — S2 stores them as blobs.
			return { ...head, type: "user.message", text: clip(event.text, maxBytes - overhead) };
		}
		if (event.type === "tool_end") {
			// Keep identity/error flag; drop details and images.
			return {
				...head,
				type: "tool_end",
				id: event.id,
				name: event.name,
				isError: event.isError,
				text: clip(event.text, maxBytes - overhead),
			};
		}
		// Any other kind: keep its type recognisable and the payload as a clipped preview.
		// The cast is local to this fallback: `type` is a union here, so the compiler
		// cannot match it against the discriminated body it came from.
		return { ...head, type: event.type, preview: clip(serialized, maxBytes - overhead) } as StreamEvent;
	};

	const deliver = (streamId: string, events: readonly StreamEvent[]): void => {
		const set = listeners.get(streamId);
		if (set === undefined) return;
		for (const event of events) {
			for (const listener of [...set]) {
				try {
					listener(event);
				} catch (error) {
					logger(`[stream-log] listener for ${streamId} failed: ${describe(error)}`);
				}
			}
		}
	};

	const appendSync = (streamId: string, inputs: readonly StreamEventInput[]): AppendedEvents => {
		if (!isStreamId(streamId)) throw new Error(`invalid stream id: ${JSON.stringify(streamId)}`);
		if (inputs.length === 0) return { first: 0, last: 0, events: [] };

		const state = loadState(streamId);
		const created = inputs.find(
			(input): input is Extract<StreamEventInput, { type: "stream.created" }> => input.type === "stream.created",
		);
		ensureStreamDir(streamId, state, created);

		const now = Date.now();
		let seq = state.lastSeq;
		const events: StreamEvent[] = [];
		for (const input of inputs) {
			const draft = { ...input } as Record<string, unknown>;
			const hint = typeof draft.ts === "number" ? draft.ts : undefined;
			const causeId = typeof draft.causeId === "number" ? draft.causeId : undefined;
			delete draft.ts;
			delete draft.causeId;
			delete draft.seq;
			delete draft.streamId;

			seq += 1;
			const event = {
				seq,
				streamId,
				ts: hint ?? now,
				...(causeId !== undefined ? { causeId } : {}),
				...draft,
			} as unknown as StreamEvent;
			events.push(boundEvent(event, maxEventBytes, streamId));
		}

		const lines = events.map((event) => `${JSON.stringify(event)}\n`).join("");
		let fileNo = state.fileNo === 0 ? 1 : state.fileNo;
		let fileSize = state.fileSize;
		if (fileSize > 0 && fileSize + Buffer.byteLength(lines) > rotateBytes) {
			fileNo += 1;
			fileSize = 0;
		}
		const firstSeq = events[0]?.seq ?? state.lastSeq + 1;
		const header = fileSize === 0 ? `${JSON.stringify({ firstSeq })}\n` : "";
		// After a torn write the file may lack its final newline: separate the
		// corrupt line from the new one instead of concatenating onto it.
		const separator = fileSize > 0 && fileNo === state.fileNo && !endsWithNewline(fileFor(streamId, fileNo), fileSize) ? "\n" : "";
		const payload = separator + header + lines;

		mkdirSync(streamDir(streamId), { recursive: true });
		const target = fileFor(streamId, fileNo);
		let fd: number | undefined;
		try {
			fd = openSync(target, "a");
			writeSync(fd, payload);
			fsyncSync(fd);
		} finally {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {
					// Already closed: the write above is what matters.
				}
			}
		}

		state.fileNo = fileNo;
		state.fileSize = fileSize + Buffer.byteLength(payload);
		state.lastSeq = seq;
		writeCursor(streamId, state.lastSeq, now);
		deliver(streamId, events);
		return { first: events[0]?.seq ?? 0, last: seq, events };
	};

	const readSync = (streamId: string, fromSeq: number, limit: number): StreamEvent[] => {
		if (!isStreamId(streamId)) return [];
		const out: StreamEvent[] = [];
		for (const name of listEventFiles(streamId)) {
			let text: string;
			try {
				text = readFileSync(join(streamDir(streamId), name), "utf8");
			} catch (error) {
				logger(`[stream-log] could not read ${streamId}/${name}: ${describe(error)}`);
				continue;
			}
			const complete = text.endsWith("\n");
			const lines = text.split("\n");
			if (complete) lines.pop();
			for (let index = 0; index < lines.length; index += 1) {
				const line = lines[index] ?? "";
				// A torn tail has no trailing newline: skip it, the prefix is still valid.
				if (!complete && index === lines.length - 1) break;
				if (line.trim() === "") continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					logger(`[stream-log] skipping corrupt line in ${streamId}/${name}`);
					continue;
				}
				if (isHeaderRecord(parsed) || !isEventRecord(parsed)) continue;
				if (parsed.seq < fromSeq) continue;
				out.push(parsed);
				if (out.length >= limit) return out;
			}
		}
		return out;
	};

	async function append(streamId: string, events: readonly StreamEventInput[]): Promise<AppendedEvents> {
		return appendSync(streamId, events);
	}

	async function read(streamId: string, fromSeq = 1, limit = Number.POSITIVE_INFINITY): Promise<StreamEvent[]> {
		return readSync(streamId, fromSeq, limit);
	}

	function subscribe(streamId: string, fromSeq: number, listener: (event: StreamEvent) => void): () => void {
		if (!isStreamId(streamId)) throw new Error(`invalid stream id: ${JSON.stringify(streamId)}`);
		const set = listeners.get(streamId) ?? new Set<(event: StreamEvent) => void>();
		listeners.set(streamId, set);
		set.add(listener);
		// Catch up synchronously: in a single tick no append can slip in between.
		for (const event of readSync(streamId, fromSeq, Number.POSITIVE_INFINITY)) {
			try {
				listener(event);
			} catch (error) {
				logger(`[stream-log] listener for ${streamId} failed: ${describe(error)}`);
			}
		}
		return () => {
			listeners.get(streamId)?.delete(listener);
		};
	}

	async function listStreams(): Promise<StreamSummary[]> {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return [];
		}

		const summaries: StreamSummary[] = [];
		for (const entry of entries) {
			if (!isStreamId(entry)) continue;
			const meta = readMeta(entry);
			const files = listEventFiles(entry);
			if (meta === undefined && files.length === 0) continue;
			const cursor = readCursor(entry);
			const scanned = scanLast(entry, files);
			const lastSeq = cursor?.lastSeq ?? scanned.lastSeq;
			const updatedAt = cursor?.updatedAt ?? scanned.updatedAt ?? meta?.createdAt ?? Date.now();
			summaries.push({
				streamId: entry,
				cwd: meta?.cwd ?? process.cwd(),
				...(meta?.title !== undefined ? { title: meta.title } : {}),
				createdAt: meta?.createdAt ?? updatedAt,
				updatedAt,
				lastSeq,
			});
		}
		return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async function remove(streamId: string): Promise<void> {
		if (!isStreamId(streamId)) throw new Error(`invalid stream id: ${JSON.stringify(streamId)}`);
		states.delete(streamId);
		listeners.delete(streamId);
		rmSync(streamDir(streamId), { recursive: true, force: true });
	}

	function close(): void {
		states.clear();
		listeners.clear();
	}

	return {
		dir,
		append,
		read,
		subscribe,
		listStreams,
		remove,
		close,
	};
}
