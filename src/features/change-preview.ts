/**
 * Change previews: what a `write_file` / `edit_file` call is about to do.
 *
 * Kept apart from the tools so both backends can share it — the local tools read
 * the previous content from disk, while the ACP session reads it through the
 * editor's `fs/read_text_file`. Same summary, same diff, either way.
 */
import type { ToolChangePreview } from "./permissions.js";

/** Minimal line diff: unchanged runs collapse, changed lines get +/- markers. */
export function diffText(label: string, before: string, after: string, contextLines = 3): string {
	const beforeLines = before.split("\n");
	const afterLines = after.split("\n");

	let common = 0;
	while (common < beforeLines.length && common < afterLines.length && beforeLines[common] === afterLines[common]) common += 1;
	const start = Math.max(0, common - contextLines);

	let tail = 0;
	while (
		tail < beforeLines.length - start &&
		tail < afterLines.length - start &&
		beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
	) {
		tail += 1;
	}

	const removed = beforeLines.slice(start, beforeLines.length - tail);
	const added = afterLines.slice(start, afterLines.length - tail);
	const lines = [`--- ${label}`, `+++ ${label}`, `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`];
	lines.push(...removed.slice(0, 200).map((line) => `-${line}`));
	lines.push(...added.slice(0, 200).map((line) => `+${line}`));
	if (removed.length > 200 || added.length > 200) lines.push("… (preview truncated)");

	return lines.join("\n");
}

export function writePreview(options: { path: string; shown: string; before?: string; after: string }): ToolChangePreview {
	const { path, shown, before, after } = options;
	const kind = before === undefined ? "create" : "overwrite";

	return {
		summary: `${kind} ${shown} (${after.split("\n").length} lines)`,
		...(before === undefined ? {} : { text: diffText(shown, before, after) }),
		file: { path, ...(before === undefined ? {} : { oldText: before }), newText: after },
	};
}

/** Where a snippet occurs, in terms a model can act on. */
export interface Occurrence {
	/** Character offset of the match. */
	index: number;
	/** 1-based line the match starts on. */
	line: number;
	/** The matching line, trimmed and clipped, for error messages. */
	snippet: string;
}

/** Finds up to `limit` occurrences of `needle` in `haystack`. */
export function findOccurrences(haystack: string, needle: string, limit = 20): Occurrence[] {
	if (needle === "") return [];
	const occurrences: Occurrence[] = [];

	let from = 0;
	while (occurrences.length < limit) {
		const index = haystack.indexOf(needle, from);
		if (index === -1) break;
		const line = haystack.slice(0, index).split("\n").length;
		const snippet = (haystack.split("\n")[line - 1] ?? "").trim().slice(0, 120);
		occurrences.push({ index, line, snippet });
		from = index + Math.max(needle.length, 1);
	}

	return occurrences;
}

/**
 * Preview of an edit: `line` picks one occurrence when the snippet is ambiguous,
 * `replaceAll` mirrors the tool's `replace_all`.
 */
export function editPreview(options: {
	path: string;
	shown: string;
	before: string;
	find: string;
	replace: string;
	line?: number;
	replaceAll?: boolean;
}): ToolChangePreview {
	const { path, shown, before, find, replace, line, replaceAll } = options;
	const occurrences = findOccurrences(before, find);
	const target = line === undefined ? occurrences : occurrences.filter((occurrence) => occurrence.line === line);
	const selected = replaceAll ? target : target.slice(0, 1);

	const after = selected.reduce((text, occurrence) => {
		const start = occurrence.index;
		return `${text.slice(0, start)}${replace}${text.slice(start + find.length)}`;
	}, before);

	const count = selected.length;
	return {
		summary: `edit ${shown} (${count} of ${occurrences.length} occurrence${occurrences.length === 1 ? "" : "s"})`,
		...(count === 0 ? {} : { text: diffText(shown, before, after) }),
		file: { path, oldText: before, newText: after },
	};
}
