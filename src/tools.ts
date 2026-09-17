import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/* ------------------------------------------------------------------ */
/* calculate                                                           */
/* ------------------------------------------------------------------ */

const CalculateParams = Type.Object({
	expression: Type.String({
		description: "Arithmetic expression to evaluate, e.g. '(12 + 8) * 3 / 2 ^ 2'.",
	}),
});

type CalculateParams = Static<typeof CalculateParams>;

/** Recursive-descent evaluator: no `eval`, no prototype access, numbers only. */
function evaluateExpression(input: string): number {
	let pos = 0;
	const source = input.replace(/\s+/g, "");

	const peek = (): string => source[pos] ?? "";
	const eat = (char: string): boolean => {
		if (peek() === char) {
			pos += 1;
			return true;
		}
		return false;
	};

	const parseNumber = (): number => {
		const start = pos;
		while (/[0-9.]/.test(peek())) pos += 1;
		if (start === pos) throw new Error(`Expected a number at position ${pos} in "${input}"`);
		const value = Number(source.slice(start, pos));
		if (!Number.isFinite(value)) throw new Error(`Invalid number "${source.slice(start, pos)}"`);
		return value;
	};

	const parsePrimary = (): number => {
		if (eat("(")) {
			const value = parseSum();
			if (!eat(")")) throw new Error("Missing closing parenthesis");
			return value;
		}
		if (eat("-")) return -parsePrimary();
		if (eat("+")) return parsePrimary();
		return parseNumber();
	};

	const parsePower = (): number => {
		const base = parsePrimary();
		return eat("^") ? base ** parsePower() : base;
	};

	const parseProduct = (): number => {
		let value = parsePower();
		for (;;) {
			if (eat("*")) value *= parsePower();
			else if (eat("/")) value /= parsePower();
			else if (eat("%")) value %= parsePower();
			else return value;
		}
	};

	function parseSum(): number {
		let value = parseProduct();
		for (;;) {
			if (eat("+")) value += parseProduct();
			else if (eat("-")) value -= parseProduct();
			else return value;
		}
	}

	const result = parseSum();
	if (pos !== source.length) throw new Error(`Unexpected character "${peek()}" at position ${pos}`);
	return result;
}

export const calculateTool: AgentTool<typeof CalculateParams> = {
	name: "calculate",
	label: "Calculator",
	description: "Evaluate an arithmetic expression (+ - * / % ^ and parentheses). Use it instead of doing math in your head.",
	parameters: CalculateParams,
	execute: async (_toolCallId, params) => {
		// Throwing is the documented failure path: pi turns the error into an `isError`
		// tool result that goes back to the model, so it can fix its arguments and retry.
		const value = evaluateExpression(params.expression);
		return {
			content: [{ type: "text", text: `${params.expression} = ${value}` }],
			details: { expression: params.expression, value },
		};
	},
};

/* ------------------------------------------------------------------ */
/* get_current_time                                                    */
/* ------------------------------------------------------------------ */

const TimeParams = Type.Object({
	timeZone: Type.Optional(
		Type.String({ description: "IANA time zone such as 'Asia/Shanghai' or 'UTC'. Defaults to the machine's local zone." }),
	),
});

type TimeParams = Static<typeof TimeParams>;

export const getCurrentTimeTool: AgentTool<typeof TimeParams> = {
	name: "get_current_time",
	label: "Current time",
	description: "Return the current date and time, optionally for a specific IANA time zone.",
	parameters: TimeParams,
	execute: async (_toolCallId, params) => {
		const timeZone = params.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
		let formatted: string;
		try {
			formatted = new Intl.DateTimeFormat("en-CA", {
				dateStyle: "full",
				timeStyle: "long",
				timeZone,
			}).format(new Date());
		} catch {
			return {
				content: [{ type: "text", text: `Unknown time zone "${timeZone}".` }],
				details: { timeZone, ok: false },
			};
		}
		return {
			content: [{ type: "text", text: `${formatted} (${timeZone})` }],
			details: { timeZone, iso: new Date().toISOString(), ok: true },
		};
	},
};

/* ------------------------------------------------------------------ */
/* get_weather (deterministic mock, no network)                        */
/* ------------------------------------------------------------------ */

const WeatherParams = Type.Object({
	city: Type.String({ description: "City name, e.g. 'Shanghai'." }),
	unit: Type.Optional(Type.Union([Type.Literal("celsius"), Type.Literal("fahrenheit")])),
});

type WeatherParams = Static<typeof WeatherParams>;

const CONDITIONS = ["sunny", "partly cloudy", "overcast", "light rain", "thunderstorms", "snowy"] as const;

function hash(text: string): number {
	let value = 2166136261;
	for (const char of text) {
		value ^= char.codePointAt(0) ?? 0;
		value = Math.imul(value, 16777619);
	}
	return Math.abs(value);
}

export const getWeatherTool: AgentTool<typeof WeatherParams> = {
	name: "get_weather",
	label: "Weather",
	description: "Get the current weather for a city. This demo tool returns deterministic mock data and never hits the network.",
	parameters: WeatherParams,
	execute: async (_toolCallId, params) => {
		const seed = hash(params.city.toLowerCase());
		const celsius = Math.round(((seed % 350) / 10 - 5) * 10) / 10;
		const condition = CONDITIONS[seed % CONDITIONS.length] ?? "sunny";
		const temperature = params.unit === "fahrenheit" ? Math.round((celsius * 9) / 5 + 32) : celsius;
		const symbol = params.unit === "fahrenheit" ? "°F" : "°C";
		const text = `${params.city}: ${condition}, ${temperature}${symbol} (humidity ${seed % 60 + 30}%)`;
		return { content: [{ type: "text", text }], details: { ...params, celsius, condition, mock: true } };
	},
};

export const tools: AgentTool<any>[] = [calculateTool, getCurrentTimeTool, getWeatherTool];
