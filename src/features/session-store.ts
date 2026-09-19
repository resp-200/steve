/**
 * Session persistence: transcripts on disk, so an editor can resume a session
 * after a restart (`session/load`).
 *
 * Files are plain JSON under `<dir>/<id>.json`. Writes go to a temp file and are
 * renamed into place, so a crash never leaves a half-written transcript behind.
 * Every failure is logged and swallowed — losing history must never break a
 * running session.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../types.js";

export interface StoredSession {
	id: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	/** Opaque transcript snapshot (see `AgentRuntime.snapshot`). */
	messages: unknown[];
	/** Cumulative usage, so a resumed session keeps counting where it left off. */
	usage?: unknown;
}

export interface SessionSummary {
	id: string;
	cwd: string;
	updatedAt: string;
}

export interface SessionStore {
	/** Directory the transcripts live in. */
	readonly dir: string;
	save(session: StoredSession): Promise<void>;
	load(id: string): Promise<StoredSession | undefined>;
	list(): Promise<SessionSummary[]>;
	remove(id: string): Promise<void>;
}

/** Session ids are UUIDs we generate; anything else is refused outright. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function createSessionStore(options: { dir: string; logger?: Logger }): SessionStore {
	const logger = options.logger ?? ((): void => {});
	const fileFor = (id: string): string => join(options.dir, `${id}.json`);

	/** Session ids are UUIDs we generate; anything else is refused outright. */
	const validId = (id: string): boolean => SAFE_ID.test(id);

	const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

	async function save(session: StoredSession): Promise<void> {
		if (!validId(session.id)) {
			logger(`[sessions] refusing to save ${JSON.stringify(session.id)}: not a session id`);
			return;
		}

		try {
			await mkdir(options.dir, { recursive: true });
			const target = fileFor(session.id);
			const temporary = `${target}.${process.pid}.tmp`;
			await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, "utf8");
			await rename(temporary, target);
		} catch (error) {
			logger(`[sessions] could not save ${session.id}: ${describe(error)}`);
		}
	}

	async function load(id: string): Promise<StoredSession | undefined> {
		if (!validId(id)) {
			logger(`[sessions] refusing to load ${JSON.stringify(id)}: not a session id`);
			return undefined;
		}

		try {
			const parsed = JSON.parse(await readFile(fileFor(id), "utf8")) as StoredSession;
			if (typeof parsed?.id !== "string" || !Array.isArray(parsed.messages)) throw new Error("malformed transcript");
			return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
				logger(`[sessions] could not load ${id}: ${describe(error)}`);
			}
			return undefined;
		}
	}

	async function list(): Promise<SessionSummary[]> {
		let entries: string[];
		try {
			entries = await readdir(options.dir);
		} catch {
			return [];
		}

		const summaries: SessionSummary[] = [];
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			const session = await load(entry.slice(0, -".json".length));
			if (session) summaries.push({ id: session.id, cwd: session.cwd, updatedAt: session.updatedAt });
		}

		return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async function remove(id: string): Promise<void> {
		if (!validId(id)) {
			logger(`[sessions] refusing to remove ${JSON.stringify(id)}: not a session id`);
			return;
		}

		try {
			await rm(fileFor(id), { force: true });
		} catch (error) {
			logger(`[sessions] could not remove ${id}: ${describe(error)}`);
		}
	}

	return { dir: options.dir, save, load, list, remove };
}
