import type { Usage } from "@oh-my-pi/pi-ai";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { MessageDividerComponent } from "../chrome/message-divider";
import { theme } from "../theme";

/**
 * Minimum prefix the previous turn must have READ back from cache before a loss
 * on the current turn counts as a cache event.
 */
const MIN_CACHE_FOOTPRINT = 2048;

/** A loss below this is cache-block alignment noise, not worth a separate marker. */
const MIN_PARTIAL_LOSS = 256;

/** APIs whose cache is explicit and prefix-controlled (`cache_control` breakpoints). */
const EXPLICIT_CACHE_APIS: Readonly<Record<string, true>> = {
	"anthropic-messages": true,
	"bedrock-converse-stream": true,
};

/** A prompt-cache miss detected from a turn's usage. */
export interface CacheInvalidation {
	/** Tokens of a previously warm prefix that this turn did not read back. */
	lostTokens: number;
	/** True when the turn read no cache at all. */
	full: boolean;
}

export interface CacheInvalidationOptions {
	/** API that produced the turn; explicit-cache APIs use a different expected prefix. */
	api?: string;
	/** Cache-block tolerance: losses at or below this are alignment noise. */
	granularity?: number;
}

/**
 * Decide whether `current` turn lost part of the prompt cache `prev` had warmed.
 *
 * A working prefix cache grows monotonically on an append-only conversation.
 * DeepSeek, for example, writes a cache unit at the end of the previous
 * request's input and another at the end of the generated output; a later
 * request can match either unit when it contains that complete prefix. The
 * output-end unit is best-effort (cache construction takes seconds and is not
 * guaranteed), so an immediate tool-call follow-up may only match the input-end
 * unit. The previous prompt, rounded to the provider's cache block, is the
 * reliable floor for a marker that must not report optional output-unit lag as
 * a user-visible miss.
 *
 * A `cacheRead` below that floor is a miss even when it is not zero, and the
 * deficit is the part billed again as ordinary input (plus the prefill/TTFT
 * cost the user actually pays).
 *
 * Explicit-cache APIs (Anthropic/Bedrock `cache_control`) only guarantee the
 * prefix up to their breakpoints. Their expected floor is the previous
 * `cacheRead + cacheWrite`: the read prefix plus the tokens written at those
 * breakpoints. Tokens in previous `input` were not written to an explicit
 * cache, so they are not guaranteed to hit.
 *
 * Implicit prefix caches (OpenAI, DeepSeek, Gemini, Fireworks) have no explicit
 * cacheWrite; their previous prompt is `cacheRead + input`, and that is the
 * conservative baseline. A hit that also reaches the output-end unit is a
 * bonus, not a requirement.
 *
 * Returns `undefined` for the first turn, turns whose predecessor never read a
 * warm prefix, tiny contexts, and losses within the cache-block tolerance.
 */
export function detectCacheInvalidation(
	prev: Usage | undefined,
	current: Usage,
	options: CacheInvalidationOptions = {},
): CacheInvalidation | undefined {
	if (!prev) return undefined;
	// A write-only predecessor (first request, or a re-write after expiry) has not
	// proven the cache is live; a cold turn behind it is expected.
	if (prev.cacheRead < MIN_CACHE_FOOTPRINT) return undefined;
	const currentPrompt = current.input + current.cacheRead + current.cacheWrite;
	if (currentPrompt < MIN_CACHE_FOOTPRINT) return undefined;

	const explicit = (options.api !== undefined && EXPLICIT_CACHE_APIS[options.api] === true) || current.cacheWrite > 0;
	const expected = explicit ? prev.cacheRead + prev.cacheWrite : prev.cacheRead + prev.input;
	const lostTokens = Math.max(0, expected - current.cacheRead);
	const tolerance = Math.max(0, options.granularity ?? 0);
	if (lostTokens <= tolerance || lostTokens < MIN_PARTIAL_LOSS) return undefined;
	return { lostTokens, full: current.cacheRead === 0 };
}

/**
 * Slim left-aligned divider rendered after an assistant turn whose request lost
 * the prompt cache. It trails streamed content because usage arrives at message
 * end, after completed rows may already be in native history.
 *
 * Mirrors the compaction divider's banner styling but spans only a short rule
 * plus label (not the full width) and carries no expandable detail:
 *
 *   ────────── ⊘ cache miss · 50.9k tokens
 */
export class CacheInvalidationMarkerComponent extends MessageDividerComponent {
	constructor(info: CacheInvalidation) {
		super({
			label: () => {
				const icon = theme.icon.cacheMiss;
				const kind = info.full ? "cache miss" : "cache partial miss";
				const head = icon ? `${icon} ${kind}` : kind;
				const tokens = info.lostTokens;
				return tokens > 0 ? `${head} ${theme.sep.dot.trim()} ${formatNumber(tokens)} tokens` : head;
			},
			labelColor: "muted",
			ruleColor: "dim",
			ruleWidth: 10,
			role: "omp.marker.cache-miss",
			native: {
				icon: "database",
				label: () =>
					info.lostTokens > 0
						? `${info.full ? "Cache miss" : "Cache partial miss"} · ${formatNumber(info.lostTokens)} tokens`
						: info.full
							? "Cache miss"
							: "Cache partial miss",
			},
			// Too narrow to frame — preserve the legacy bare label.
			truncateWhenNarrow: false,
		});
	}
}
