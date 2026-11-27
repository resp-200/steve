/**
 * Content-addressed storage for the payloads that must not sit in a stream log.
 *
 * A picture is megabytes of base64; a log line is meant to stay readable and to
 * rotate at 8 MiB. So the bytes go to `~/.steve/blobs/<sha256>` and the event
 * keeps only a reference. Deduplication falls out of the hash: sending the same
 * screenshot twice costs one file.
 *
 * The reference is written into the event field the payload used to occupy, so
 * a reader that knows about blobs resolves it and one that does not sees an
 * object it cannot use — never a truncated message.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The prefix that marks a reference instead of an inline payload. */
export const BLOB_PREFIX = "blob:";

/** What a stored payload looks like once it is out of the log. */
export interface BlobRef {
	/** `blob:<sha256>`. */
	ref: string;
	mimeType: string;
}

export interface BlobStore {
	/** Stores a base64 payload and returns the reference to write into the log. */
	put(data: string, mimeType: string): BlobRef;
	/** Resolves a reference back to base64, or `undefined` when the blob is gone. */
	get(reference: string): { data: string; mimeType: string } | undefined;
	/** Absolute path a reference resolves to (no IO). */
	pathOf(reference: string): string;
}

/** `blob:<sha>` → the sha, or `undefined` for anything else. */
export function blobHash(reference: unknown): string | undefined {
	if (typeof reference !== "string" || !reference.startsWith(BLOB_PREFIX)) return undefined;
	const hash = reference.slice(BLOB_PREFIX.length);
	return /^[0-9a-f]{64}$/.test(hash) ? hash : undefined;
}

/**
 * The metadata sidecar keeps the MIME type: the model needs to know whether it
 * was handed a PNG or a JPEG, and sniffing on every read would be a second
 * source of truth.
 */
export function createBlobStore(dir: string): BlobStore {
	const ensure = (): void => {
		mkdirSync(dir, { recursive: true });
	};
	const pathOf = (reference: string): string => {
		const hash = blobHash(reference);
		return hash === undefined ? join(dir, "invalid") : join(dir, hash);
	};
	return {
		pathOf,
		put(data, mimeType) {
			const bytes = Buffer.from(data, "base64");
			const hash = createHash("sha256").update(bytes).digest("hex");
			const ref = `${BLOB_PREFIX}${hash}`;
			try {
				ensure();
				const file = join(dir, hash);
				if (!existsSync(file)) writeFileSync(file, bytes);
				const meta = join(dir, `${hash}.json`);
				if (!existsSync(meta)) writeFileSync(meta, `${JSON.stringify({ mimeType, bytes: bytes.length })}\n`, "utf8");
			} catch (error) {
				// Falling back to the inline payload would blow the event budget; losing
				// the picture while keeping the message is the lesser failure, and the
				// caller sees it as a blob that reads back as missing.
				return { ref, mimeType };
			}
			return { ref, mimeType };
		},
		get(reference) {
			const hash = blobHash(reference);
			if (hash === undefined) return undefined;
			try {
				const bytes = readFileSync(join(dir, hash));
				let mimeType = "image/png";
				try {
					const meta = JSON.parse(readFileSync(join(dir, `${hash}.json`), "utf8")) as { mimeType?: unknown };
					if (typeof meta.mimeType === "string" && meta.mimeType !== "") mimeType = meta.mimeType;
				} catch {
					// No sidecar: the bytes still decode, the type falls back to PNG.
				}
				return { data: bytes.toString("base64"), mimeType };
			} catch {
				return undefined;
			}
		},
	};
}
