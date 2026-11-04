import assert from "node:assert/strict";

export const CACHE_PREFIX_LIMITS = Object.freeze({
  requests: 3,
  requestBytes: 80_000,
  inputStopThreshold: 20_000,
  cumulativeInputStopThreshold: 60_000,
  outputTokens: 128,
  requestMs: 60_000,
  runMs: 180_000,
});

/** Enforced before forwarding; reported input is a stop threshold, not a cap. */
export function createCachePrefixBudget(now: () => number = Date.now) {
  const started = now();
  let requests = 0;
  let cumulativeInput = 0;
  let stopped = false;
  const check = () => {
    assert(!stopped, "run already stopped");
    assert(
      now() - started < CACHE_PREFIX_LIMITS.runMs,
      "overall deadline exceeded",
    );
  };
  return {
    prepare(payload: Record<string, unknown>) {
      try {
        check();
        assert(
          requests < CACHE_PREFIX_LIMITS.requests,
          "request limit exceeded",
        );
        assert(
          !payload.thinking ||
            (payload.thinking as { type?: string }).type === "disabled",
          "thinking is outside the approved output budget",
        );
        // The CLI chooses its own output limit, so enforce it on the actual
        // Messages body rather than trusting an unsupported provider option.
        payload.max_tokens = CACHE_PREFIX_LIMITS.outputTokens;
        const requestBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
        assert(
          requestBytes <= CACHE_PREFIX_LIMITS.requestBytes,
          "request body exceeds byte limit",
        );
        requests++;
        return { request: requests, requestBytes };
      } catch (error) {
        stopped = true;
        throw error;
      }
    },
    recordUsage(usage: {
      input: number;
      cacheRead: number;
      cacheWrite: number;
      output: number;
    }) {
      try {
        check();
        const values = [
          usage.input,
          usage.cacheRead,
          usage.cacheWrite,
          usage.output,
        ];
        assert(
          values.every((n) => Number.isSafeInteger(n) && n >= 0),
          "invalid token usage",
        );
        const totalInput = usage.input + usage.cacheRead + usage.cacheWrite;
        cumulativeInput += totalInput;
        assert(
          totalInput <= CACHE_PREFIX_LIMITS.inputStopThreshold,
          "reported input exceeds stop threshold",
        );
        assert(
          cumulativeInput <= CACHE_PREFIX_LIMITS.cumulativeInputStopThreshold,
          "cumulative input exceeds stop threshold",
        );
        assert(
          usage.output <= CACHE_PREFIX_LIMITS.outputTokens,
          "reported output exceeds cap",
        );
        return { totalInput, cumulativeInput };
      } catch (error) {
        stopped = true;
        throw error;
      }
    },
    stop() {
      stopped = true;
    },
  };
}
