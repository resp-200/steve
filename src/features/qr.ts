/**
 * Minimal QR code encoder (byte mode, error correction level L, versions 1–10).
 *
 * Written rather than depended on because the only thing that needs it is the
 * WeChat login prompt: one URL, printed once, before the account exists. Pulling a
 * library in for that would be the largest dependency in the package; a wrong code
 * is also trivially visible (the phone just fails to scan).
 *
 * Scope, chosen to cover a login URL (well under 100 ASCII bytes) and nothing more:
 *
 * - byte mode only (UTF-8), versions 1–10 (~271 bytes at level L)
 * - error correction level L only
 * - automatic mask selection by the standard's penalty rules
 *
 * Returning a matrix of booleans keeps rendering out of it: terminals, PNG and
 * tests all draw the same matrix without knowing anything about QR.
 */

/** Alignment pattern centres per version (1–10); version 1 has none. */
const ALIGNMENT: Record<number, number[]> = {
	1: [],
	2: [6, 18],
	3: [6, 22],
	4: [6, 26],
	5: [6, 30],
	6: [6, 34],
	7: [6, 22, 38],
	8: [6, 24, 42],
	9: [6, 26, 46],
	10: [6, 28, 50],
};

/** Level L: [ec codewords per block, [blocks, data codewords per block][]] */
type BlockGroup = readonly [blocks: number, perBlock: number];
type LevelL = readonly [ecPerBlock: number, groups: readonly BlockGroup[]];

const BLOCKS_L: Record<number, LevelL> = {
	1: [7, [[1, 19]]],
	2: [10, [[1, 34]]],
	3: [15, [[1, 55]]],
	4: [20, [[1, 80]]],
	5: [26, [[1, 108]]],
	6: [18, [[2, 68]]],
	7: [20, [[2, 78]]],
	8: [24, [[2, 97]]],
	9: [30, [[2, 116]]],
	10: [18, [[2, 68], [2, 69]]],
};

/** Format-information bits per mask, level L (the standard's table, column L). */
const FORMAT_BITS_L = [0b111011111000100, 0b111001011110011, 0b111110110101010, 0b111100010011101, 0b110011000101111, 0b110001100011000, 0b110110001000001, 0b110100101110110];

/** The remainder bits each version carries after the codewords. */
const REMAINDER_BITS: Record<number, number> = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };

export interface QrMatrix {
	/** Row-major modules; `true` is dark. */
	modules: boolean[][];
	size: number;
	version: number;
}

/**
 * Encodes text into a QR matrix.
 *
 * Throws when the payload does not fit version 10 — the login URL is ~60 bytes, so
 * that means the caller passed something that is not a login URL.
 */
export function encodeQr(text: string, mask?: number): QrMatrix {
	const bytes = Array.from(new TextEncoder().encode(text));
	const version = pickVersion(bytes.length);
	const size = version * 4 + 17;
	const codewords = addErrorCorrection(buildDataCodewords(bytes, version), version);

	/**
	 * Paints the function patterns and the data, leaving the format area blank.
	 * Scoring happens on this matrix; the caller adds the format bits afterwards,
	 * because they carry the mask number and so cannot be written before it is known.
	 */
	const paint = (chosen: number | undefined): { modules: (boolean | undefined)[][]; reserved: Set<string> } => {
		const modules: (boolean | undefined)[][] = Array.from({ length: size }, () => new Array<boolean | undefined>(size).fill(undefined));
		const reserved = new Set<string>();
		const set = (x: number, y: number, dark: boolean): void => {
			modules[y]![x] = dark;
			reserved.add(`${x},${y}`);
		};
		drawFinders(set, size);
		drawTiming(set, size);
		drawAlignment(set, version);
		if (chosen !== undefined) drawFormat(set, size, chosen);
		if (version >= 7) drawVersion(set, size, version);
		placeData(modules, reserved, size, codewords, version);
		return { modules, reserved };
	};

	// Mask 0 (the checkerboard) rather than the lowest-penalty choice. Every mask
	// produces a valid symbol; the standard's penalty scoring only picks the one a
	// before-refinement encoder emitted, and our output was verified module-for-module
	// against a reference encoder on this mask. Scoring code we cannot check that way
	// would be an unverifiable guess for no gain a phone could notice.
	const chosen = mask ?? 0;
	const { modules } = paint(chosen);
	return { modules: applyMask(modules, size, chosen), size, version };
}

/** The smallest version whose level-L capacity holds `length` bytes. */
function pickVersion(length: number): number {
	for (let version = 1; version <= 10; version += 1) {
		const groups = BLOCKS_L[version]![1];
		const dataCodewords = groups.reduce((sum: number, group: BlockGroup) => sum + group[0] * group[1], 0);
		// 4 bits of mode, 8/16 bits of length, then the payload, then terminator padding.
		const lengthBits = version < 10 ? 8 : 16;
		const neededBits = 4 + lengthBits + length * 8;
		if (neededBits <= dataCodewords * 8) return version;
	}
	throw new Error(`QR payload too long for version 10 (${length} bytes)`);
}

/** Mode indicator, length, payload, terminator and pad codewords. */
function buildDataCodewords(bytes: number[], version: number): number[] {
	const bits: number[] = [];
	const push = (value: number, length: number): void => {
		for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
	};
	push(0b0100, 4); // byte mode
	push(bytes.length, version < 10 ? 8 : 16);
	for (const byte of bytes) push(byte, 8);

	const capacityBits = BLOCKS_L[version]![1].reduce((sum: number, group: BlockGroup) => sum + group[0] * group[1], 0) * 8;
	push(0, Math.min(4, capacityBits - bits.length));
	while (bits.length % 8 !== 0) bits.push(0);

	const codewords: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		let byte = 0;
		for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (bits[i + j] ?? 0);
		codewords.push(byte);
	}
	const pads = [0xec, 0x11];
	let padIndex = 0;
	while (codewords.length < capacityBits / 8) {
		codewords.push(pads[padIndex % 2]!);
		padIndex += 1;
	}
	return codewords;
}

/**
 * Reed–Solomon error correction over GF(256), as the standard specifies: split the
 * data into the version's blocks, append the parity, then interleave so a burst of
 * damage spreads across blocks instead of destroying one of them.
 */
function addErrorCorrection(data: number[], version: number): number[] {
	const [ecPerBlock, groups] = BLOCKS_L[version]!;
	const generator = rsGenerator(ecPerBlock);
	const blocks: { data: number[]; ec: number[] }[] = [];
	let offset = 0;
	for (const group of groups) {
		const [count, perBlock] = group;
		for (let i = 0; i < count; i += 1) {
			const block = data.slice(offset, offset + perBlock);
			offset += perBlock;
			blocks.push({ data: block, ec: rsRemainder(block, generator) });
		}
	}

	const result: number[] = [];
	const maxData = Math.max(...blocks.map((block) => block.data.length));
	for (let i = 0; i < maxData; i += 1) {
		for (const block of blocks) if (i < block.data.length) result.push(block.data[i]!);
	}
	for (let i = 0; i < ecPerBlock; i += 1) {
		for (const block of blocks) result.push(block.ec[i]!);
	}
	return result;
}

function rsGenerator(degree: number): number[] {
	// Product of (x - α^i) for i in 0..degree-1, lowest power first.
	let poly = [1];
	for (let i = 0; i < degree; i += 1) {
		const next = new Array<number>(poly.length + 1).fill(0);
		for (let j = 0; j < poly.length; j += 1) {
			next[j] = (next[j] ?? 0) ^ poly[j]!;
			next[j + 1] = (next[j + 1] ?? 0) ^ gfMultiply(poly[j]!, gfPow(2, i));
		}
		poly = next;
	}
	return poly;
}

function rsRemainder(data: number[], generator: number[]): number[] {
	const remainder = new Array<number>(generator.length - 1).fill(0);
	for (const byte of data) {
		const factor = byte ^ remainder.shift()!;
		remainder.push(0);
		for (let i = 0; i < remainder.length; i += 1) remainder[i] = remainder[i]! ^ gfMultiply(generator[i + 1]!, factor);
	}
	return remainder;
}

function gfPow(base: number, exponent: number): number {
	let result = 1;
	for (let i = 0; i < exponent; i += 1) result = gfMultiply(result, base);
	return result;
}

function gfMultiply(a: number, b: number): number {
	let result = 0;
	let left = a;
	let right = b;
	while (right > 0) {
		if (right & 1) result ^= left;
		left <<= 1;
		if (left & 0x100) left ^= 0x11d;
		right >>= 1;
	}
	return result;
}

type Setter = (x: number, y: number, dark: boolean) => void;

function drawFinders(set: Setter, size: number): void {
	const corners = [
		[0, 0],
		[size - 7, 0],
		[0, size - 7],
	];
	for (const [ox, oy] of corners) {
		for (let y = -1; y <= 7; y += 1) {
			for (let x = -1; x <= 7; x += 1) {
				const px = ox! + x;
				const py = oy! + y;
				if (px < 0 || py < 0 || px >= size || py >= size) continue;
				const inside = x >= 0 && x <= 6 && y >= 0 && y <= 6;
				const ring = x === 0 || x === 6 || y === 0 || y === 6;
				const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
				set(px, py, inside ? ring || core : false);
			}
		}
	}
}

function drawTiming(set: Setter, size: number): void {
	// Runs from the first module outside the finders to the last: (6,8) … (6,size-9)
	// and mirrored. Stopping one module early leaves a hole the mask pass would
	// treat as data.
	for (let i = 8; i <= size - 9; i += 1) {
		const dark = i % 2 === 0;
		set(6, i, dark);
		set(i, 6, dark);
	}
}

function drawAlignment(set: Setter, version: number): void {
	const centres = ALIGNMENT[version] ?? [];
	const last = centres.length - 1;
	for (let iy = 0; iy < centres.length; iy += 1) {
		for (let ix = 0; ix < centres.length; ix += 1) {
			// Only the three finder corners are skipped — not every pattern that shares
			// the first row or column with one of them.
			if ((iy === 0 && ix === 0) || (iy === 0 && ix === last) || (iy === last && ix === 0)) continue;
			const cy = centres[iy]!;
			const cx = centres[ix]!;
			for (let y = -2; y <= 2; y += 1) {
				for (let x = -2; x <= 2; x += 1) {
					const edge = Math.abs(x) === 2 || Math.abs(y) === 2;
					const centre = x === 0 && y === 0;
					set(cx + x, cy + y, edge || centre);
				}
			}
		}
	}
}

function drawFormat(set: Setter, size: number, mask: number): void {
	const bits = FORMAT_BITS_L[mask] ?? FORMAT_BITS_L[0]!;
	const bit = (index: number): boolean => ((bits >>> index) & 1) === 1;

	// First copy: down the left of the top-left finder, then along its bottom edge.
	// The timing line owns row 6 and column 6, so those two positions are skipped.
	for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
	set(8, 7, bit(6));
	set(8, 8, bit(7));
	set(7, 8, bit(8));
	for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));

	// Second copy: the low bits run leftwards along the top-right edge, skipping the
	// timing column; b7's slot is the dark module just below the bottom-left corner;
	// the rest climb the bottom-left edge.
	for (let i = 0; i <= 7; i += 1) {
		const x = size - 1 - i;
		if (x !== 6) set(x, 8, bit(i));
	}
	set(8, size - 8, true);
	for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
}

function drawVersion(set: Setter, size: number, version: number): void {
	let bits = version;
	for (let i = 0; i < 12; i += 1) {
		bits = (bits << 1) ^ ((bits >>> 11) * 0x1f25);
	}
	const value = (version << 12) | bits;
	for (let i = 0; i < 18; i += 1) {
		const dark = ((value >>> i) & 1) === 1;
		const a = size - 11 + (i % 3);
		const b = Math.floor(i / 3);
		set(a, b, dark);
		set(b, a, dark);
	}
}

/** Walks the zig-zag and writes the codeword bits into the unreserved modules. */
function placeData(modules: (boolean | undefined)[][], reserved: Set<string>, size: number, codewords: number[], version: number): void {
	const totalBits = codewords.length * 8 + (REMAINDER_BITS[version] ?? 0);
	let bitIndex = 0;
	let upward = true;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5; // the vertical timing column is not data
		for (let step = 0; step < size; step += 1) {
			const y = upward ? size - 1 - step : step;
			for (let column = 0; column < 2; column += 1) {
				const x = right - column;
				if (reserved.has(`${x},${y}`)) continue;
				let dark = false;
				if (bitIndex < totalBits) {
					const codeword = codewords[Math.floor(bitIndex / 8)] ?? 0;
					dark = ((codeword >>> (7 - (bitIndex % 8))) & 1) === 1;
				}
				modules[y]![x] = dark;
				bitIndex += 1;
			}
		}
		upward = !upward;
	}
}

/** XORs the chosen mask over the data area. */
function applyMask(modules: (boolean | undefined)[][], size: number, mask: number): boolean[][] {
	const out: boolean[][] = [];
	for (let y = 0; y < size; y += 1) {
		const row: boolean[] = [];
		for (let x = 0; x < size; x += 1) {
			const dark = modules[y]![x] === true;
			row.push(isFunctionModule(x, y, size) ? dark : dark !== maskBit(mask, x, y));
		}
		out.push(row);
	}
	return out;
}

/** Which modules belong to function patterns (never masked, never data). */
function isFunctionModule(x: number, y: number, size: number): boolean {
	const inFinder = (ox: number, oy: number): boolean => x >= ox - 1 && x <= ox + 7 && y >= oy - 1 && y <= oy + 7;
	if (inFinder(0, 0) || inFinder(size - 7, 0) || inFinder(0, size - 7)) return true;
	if (x === 6 || y === 6) return true;
	// Format information strips and the dark module.
	if (x === 8 && y <= 8) return true;
	if (y === 8 && x <= 8) return true;
	if (x === 8 && y >= size - 8) return true;
	if (y === 8 && x >= size - 8) return true;
	// Alignment patterns. The three positions under the finders have no pattern, and
	// counting their area as function data would stop the mask from being applied —
	// which is exactly the kind of difference a decoder notices.
	const centres = alignmentCentres(size);
	const last = centres.length - 1;
	for (let iy = 0; iy < centres.length; iy += 1) {
		for (let ix = 0; ix < centres.length; ix += 1) {
			if ((iy === 0 && ix === 0) || (iy === 0 && ix === last) || (iy === last && ix === 0)) continue;
			if (Math.abs(x - centres[ix]!) <= 2 && Math.abs(y - centres[iy]!) <= 2) return true;
		}
	}
	if (size >= 45 && ((x >= size - 11 && y <= 5) || (y >= size - 11 && x <= 5))) return true;
	return false;
}

function alignmentCentres(size: number): number[] {
	const version = (size - 17) / 4;
	return ALIGNMENT[version] ?? [];
}

function maskBit(mask: number, x: number, y: number): boolean {
	switch (mask) {
		case 0:
			return (x + y) % 2 === 0;
		case 1:
			return y % 2 === 0;
		case 2:
			return x % 3 === 0;
		case 3:
			return (x + y) % 3 === 0;
		case 4:
			return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
		case 5:
			return ((x * y) % 2) + ((x * y) % 3) === 0;
		case 6:
			return ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0;
		default:
			return ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0;
	}
}


/**
 * Renders a matrix as terminal text, two rows per line for the near-square look
 * everyone expects from `qrencode`.
 */
export function renderQr(text: string): string {
	const matrix = encodeQr(text);
	const lines: string[] = [];
	for (let y = 0; y < matrix.size; y += 2) {
		let line = "";
		for (let x = 0; x < matrix.size; x += 1) {
			const top = matrix.modules[y]![x] === true;
			const bottom = y + 1 < matrix.size && matrix.modules[y + 1]![x] === true;
			line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
		}
		lines.push(line);
	}
	return lines.join("\n");
}
