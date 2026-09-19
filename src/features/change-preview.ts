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

export function editPreview(options: { path: string; shown: string; before: string; find: string; replace: string }): ToolChangePreview {
	const { path, shown, before, find, replace } = options;
	const occurrences = find === "" ? 0 : before.split(find).length - 1;
	const after = occurrences === 0 ? before : before.replace(find, replace);

	return {
		summary: `edit ${shown} (${occurrences} occurrence${occurrences === 1 ? "" : "s"})`,
		...(occurrences === 0 ? {} : { text: diffText(shown, before, after) }),
		file: { path, oldText: before, newText: after },
	};
}
