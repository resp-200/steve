#!/usr/bin/env node
// Verifies the image rules every front end shares (model/image.ts).
//
// The point of this module is that a picture either reaches the model or the
// user is told why not — never that it vanishes. A silently dropped image looks
// exactly like a model without vision, which is the bug this guards against.
//
//   A. format: only what the providers decode (PNG/JPEG/GIF/WebP) gets through
//   B. size: 10 MB cap, base64 measured without decoding, message says the size
//   C. batches: one bad picture refuses the whole batch (half a question is worse)
//   D. capability: a text-only model is recognised as such
//   E. a provider refusing pictures becomes advice, not a raw 400
//
//   npm run build && node scripts/image-test.mjs
import process from "node:process";
import { MAX_IMAGE_BYTES, base64Bytes, checkImage, checkImages, explainVisionFailure, formatBytes, imageMimeTypeForPath, modelSupportsImages } from "../dist/model/image.js";

const checks = [];
const check = (name, passed, detail = "") => {
	checks.push({ name, passed });
	process.stderr.write(`  ${passed ? "✓" : "✗"} ${name}${passed || !detail ? "" : ` — ${detail}`}\n`);
};

/** `bytes` of base64, without allocating the bytes themselves. */
const b64 = (bytes) => Buffer.alloc(bytes, 7).toString("base64");

/* ---------- A. format ---------- */

{
	const png = checkImage({ mimeType: "image/png", data: b64(120) });
	check("a PNG passes", png.ok === true, JSON.stringify(png));

	const upper = checkImage({ mimeType: "IMAGE/JPEG", data: b64(120) });
	check("the mime type is lowercased", upper.ok === true && upper.image.mimeType === "image/jpeg", JSON.stringify(upper));

	const withParams = checkImage({ mimeType: "image/png; charset=binary", data: b64(120) });
	check("a mime type with parameters is still accepted", withParams.ok === true && withParams.image.mimeType === "image/png", JSON.stringify(withParams));

	const heic = checkImage({ mimeType: "image/heic", data: b64(120) });
	check("HEIC is refused (providers do not decode it)", heic.ok === false && heic.reason.includes("image/heic"), heic.ok ? "accepted" : heic.reason);

	const svg = checkImage({ mimeType: "image/svg+xml", data: b64(120) });
	check("SVG is refused", svg.ok === false, svg.ok ? "accepted" : svg.reason);

	const empty = checkImage({ mimeType: "image/png", data: "" });
	check("an empty payload is refused", empty.ok === false, empty.ok ? "accepted" : empty.reason);

	const noType = checkImage({ mimeType: "", data: b64(120) });
	check("a missing mime type is refused", noType.ok === false, noType.ok ? "accepted" : noType.reason);
}

/* ---------- B. size ---------- */

{
	check("the cap is 10 MB", MAX_IMAGE_BYTES === 10 * 1024 * 1024, String(MAX_IMAGE_BYTES));

	const exact = checkImage({ mimeType: "image/png", data: b64(MAX_IMAGE_BYTES) });
	check("exactly 10 MB passes (the cap is inclusive)", exact.ok === true, JSON.stringify(exact.ok ? "ok" : exact.reason));

	const over = checkImage({ mimeType: "image/png", data: b64(MAX_IMAGE_BYTES + 1) });
	check("one byte over the cap is refused", over.ok === false, over.ok ? "accepted" : over.reason);
	check("the refusal names the size", over.ok === false && over.reason.includes("10.0 MB"), over.ok ? "" : over.reason);

	const big = checkImage({ mimeType: "image/png", data: b64(3 * 1024 * 1024) });
	check("a 3 MB picture passes", big.ok === true, JSON.stringify(big.ok ? "ok" : big.reason));
}

/* ---------- C. batches ---------- */

{
	const two = checkImages([{ mimeType: "image/png", data: b64(100) }, { mimeType: "image/jpeg", data: b64(200) }]);
	check("a good batch keeps both pictures in order", two.ok === true && two.images.length === 2 && two.images[1].mimeType === "image/jpeg", JSON.stringify(two.ok ? two.images.length : two.reason));

	const mixed = checkImages([{ mimeType: "image/png", data: b64(100) }, { mimeType: "image/heic", data: b64(100) }]);
	check("one bad picture refuses the batch", mixed.ok === false, mixed.ok ? "accepted" : mixed.reason);
	check("the refusal points at the bad one", mixed.ok === false && mixed.reason.includes("第 2 张"), mixed.ok ? "" : mixed.reason);

	const none = checkImages([]);
	check("an empty batch is not an error", none.ok === true && none.images.length === 0, JSON.stringify(none));
}

/* ---------- D. capability and helpers ---------- */

{
	check("text-only is recognised", modelSupportsImages(["text"]) === false);
	check("vision is recognised", modelSupportsImages(["text", "image"]) === true);
	check("an absent input list means no vision", modelSupportsImages(undefined) === false);

	check("extensions map to provider mime types", imageMimeTypeForPath("/tmp/a.PNG") === "image/png" && imageMimeTypeForPath("b.jpeg") === "image/jpeg");
	check("a non-image path has no mime type", imageMimeTypeForPath("/tmp/a.txt") === undefined);
	check("HEIC on disk is not offered", imageMimeTypeForPath("/tmp/a.heic") === undefined);

	check("base64 size is measured without decoding", base64Bytes(b64(1024)) === 1024, String(base64Bytes(b64(1024))));
	check("base64 padding is accounted for", base64Bytes(Buffer.alloc(1, 0).toString("base64")) === 1, String(base64Bytes("AA==")));
	check("bytes are rendered the way a person reads them", formatBytes(900) === "900 B" && formatBytes(1536) === "1.5 KB" && formatBytes(12 * 1024 * 1024) === "12.0 MB");
}

/* ---------- E. a provider's refusal becomes advice ---------- */

{
	const openai = explainVisionFailure("400 image_url is not supported for this model");
	check("an OpenAI-shaped refusal is explained", openai !== undefined && openai.includes("「支持图片」"), String(openai));
	check("the gateway's own words are kept", openai.includes("image_url is not supported"), String(openai));
	check(
		"an Anthropic-shaped refusal is explained",
		explainVisionFailure("messages.0.content.0.image: Input tag 'image' found using 'type' does not match any of the expected tags") !== undefined,
	);
	check("a multimodal wording is explained", explainVisionFailure("this model does not support multimodal input") !== undefined);
	check("an unrelated failure is passed through untouched", explainVisionFailure("429 rate limited") === undefined);
	check("no error means no advice", explainVisionFailure(undefined) === undefined && explainVisionFailure("") === undefined);
}

const failed = checks.filter((entry) => !entry.passed);
const total = checks.length;
process.stderr.write(`${total === 0 ? "no" : total - failed.length}/${total} checks passed\n`);
if (failed.length > 0) process.exitCode = 1;
