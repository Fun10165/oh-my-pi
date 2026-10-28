import { beforeAll, describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai/types";
import {
	CacheInvalidationMarkerComponent,
	detectCacheInvalidation,
} from "@oh-my-pi/pi-tui/chat/cache-invalidation-marker";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

function usage(parts: {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
	output?: number;
	reasoningTokens?: number;
}): Usage {
	const input = parts.input ?? 0;
	const output = parts.output ?? 0;
	const cacheRead = parts.cacheRead ?? 0;
	const cacheWrite = parts.cacheWrite ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		...(parts.reasoningTokens === undefined ? {} : { reasoningTokens: parts.reasoningTokens }),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("detectCacheInvalidation", () => {
	it("does not flag the first turn (no prior cache footprint)", () => {
		expect(detectCacheInvalidation(undefined, usage({ cacheWrite: 50_000, input: 2 }))).toBeUndefined();
	});

	it("flags an explicit-cache collapse after a warm turn", () => {
		const prev = usage({ cacheRead: 49_837, cacheWrite: 980, output: 79 });
		const current = usage({ cacheRead: 0, cacheWrite: 50_900, input: 99, output: 99 });
		expect(detectCacheInvalidation(prev, current, { api: "anthropic-messages" })).toEqual({
			lostTokens: 50_817,
			full: true,
		});
	});

	it("flags a partial explicit-cache loss when cacheRead shrinks but is not zero", () => {
		const prev = usage({ cacheRead: 49_837, cacheWrite: 980, output: 79 });
		const current = usage({ cacheRead: 30_000, input: 20_000, output: 99 });
		expect(detectCacheInvalidation(prev, current, { api: "anthropic-messages" })).toEqual({
			lostTokens: 20_817,
			full: false,
		});
	});

	it("flags an explicit-cache loss for tokens written in the previous turn", () => {
		const prev = usage({ cacheRead: 49_837, cacheWrite: 980, output: 79 });
		const current = usage({ cacheRead: 49_837, cacheWrite: 50_900, input: 99 });
		expect(detectCacheInvalidation(prev, current, { api: "anthropic-messages" })).toEqual({
			lostTokens: 980,
			full: false,
		});
	});

	it("flags a full implicit-cache miss without requiring cacheWrite", () => {
		// DeepSeek/OpenAI implicit caches report cacheWrite 0. A zero cacheRead
		// after a warm prefix is still a real miss: this request paid full input
		// price and re-prefilled the context.
		const prev = usage({ cacheRead: 40_789, input: 1_069, output: 353 });
		const current = usage({ cacheRead: 0, cacheWrite: 0, input: 43_102, output: 58 });
		expect(detectCacheInvalidation(prev, current, { api: "openai-completions" })).toEqual({
			lostTokens: 41_858,
			full: true,
		});
	});

	it("flags an implicit-cache partial loss against the previous prompt size", () => {
		// A healthy append-only turn should read the previous request's full prompt
		// (40,789 cached + 1,069 uncached). Reading only 20k loses 21,858.
		const prev = usage({ cacheRead: 40_789, input: 1_069, output: 353 });
		const current = usage({ cacheRead: 20_000, input: 20_000, output: 58 });
		expect(detectCacheInvalidation(prev, current, { api: "openai-responses" })).toEqual({
			lostTokens: 21_858,
			full: false,
		});
	});

	it("does not require the best-effort output-end cache unit", () => {
		// DeepSeek writes input-end and output-end cache units, but the output-end
		// unit is best-effort and may not be flushed for an immediate tool-call
		// follow-up. The previous prompt was 15,872 + 142 = 16,014; 16,000 is a
		// healthy 64-token-aligned match of the input-end unit.
		const prev = usage({ cacheRead: 15_872, input: 142, output: 517, reasoningTokens: 144 });
		const current = usage({ cacheRead: 16_000, input: 2_238, output: 167 });
		expect(detectCacheInvalidation(prev, current, { api: "openai-completions" })).toBeUndefined();
	});

	it("flags an implicit-cache loss after block rounding", () => {
		const prev = usage({ cacheRead: 15_872, input: 142, output: 517, reasoningTokens: 144 });
		const current = usage({ cacheRead: 15_000, input: 3_000, output: 167 });
		expect(detectCacheInvalidation(prev, current, { api: "openai-completions" })).toEqual({
			lostTokens: 1_014,
			full: false,
		});
	});

	it("does not flag a cold turn whose predecessor only wrote the cache (never read it)", () => {
		// The session's opening request writes the prefix (cacheRead 0); a long
		// first tool call then outlives the provider's cache TTL, so the follow-up
		// re-writes cold. The cache was never proven live, so this is expected
		// warming/expiry rather than a user-visible miss.
		const prev = usage({ cacheRead: 0, cacheWrite: 50_900, input: 99 });
		const current = usage({ cacheRead: 0, cacheWrite: 51_113, input: 16 });
		expect(detectCacheInvalidation(prev, current)).toBeUndefined();
	});

	it("does not flag a turn that reused the full expected prefix", () => {
		const prev = usage({ cacheRead: 50_900, cacheWrite: 980 });
		const current = usage({ cacheRead: 51_880, cacheWrite: 3_459, input: 2 });
		expect(detectCacheInvalidation(prev, current, { api: "anthropic-messages" })).toBeUndefined();
	});

	it("ignores losses below the cache-block tolerance", () => {
		const prev = usage({ cacheRead: 40_000, cacheWrite: 0, output: 200 });
		const current = usage({ cacheRead: 39_000, input: 2_000 });
		expect(detectCacheInvalidation(prev, current, { api: "openai-completions", granularity: 1_024 })).toBeUndefined();
	});

	it("ignores collapses when the prior footprint was below the cacheable floor", () => {
		const prev = usage({ input: 500 });
		expect(detectCacheInvalidation(prev, usage({ input: 600 }))).toBeUndefined();
	});

	it("ignores a cold turn that reprocessed only a trivial prompt", () => {
		const prev = usage({ cacheRead: 40_000, cacheWrite: 1_000 });
		expect(detectCacheInvalidation(prev, usage({ cacheRead: 0, input: 12 }))).toBeUndefined();
	});
});

describe("CacheInvalidationMarkerComponent", () => {
	beforeAll(async () => {
		// render() reads the global theme singleton (icons, rule glyph, colors).
		await initTheme();
	});

	it("renders a slim, left-aligned, partial-width divider padded by blank lines", () => {
		const lines = new CacheInvalidationMarkerComponent({ lostTokens: 50_999, full: true }).render(80);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe("");
		expect(lines[2]).toBe("");
		// The divider spans only a short rule + label — well under the full width.
		const dividerWidth = Bun.stringWidth(lines[1]);
		expect(dividerWidth).toBeGreaterThan(0);
		expect(dividerWidth).toBeLessThan(80);
	});

	it("labels a non-zero cacheRead loss as a partial miss", () => {
		const lines = new CacheInvalidationMarkerComponent({ lostTokens: 18_200, full: false }).render(120);
		expect(Bun.stripANSI(lines[1]!)).toContain("cache partial miss");
	});
});
