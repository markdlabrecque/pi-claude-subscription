import { expect, it } from "vitest";
import {
  CACHE_PREFIX_LIMITS,
  createCachePrefixBudget,
} from "../scripts/acceptance/cache-prefix-budget";

const usage = { input: 10, cacheRead: 10_000, cacheWrite: 22, output: 1 };

it("enforces output on the actual request before measuring serialized bytes", () => {
  const budget = createCachePrefixBudget();
  const payload = { messages: [], max_tokens: 8192 };
  expect(budget.prepare(payload)).toEqual({
    request: 1,
    requestBytes: Buffer.byteLength(
      JSON.stringify({ messages: [], max_tokens: 128 }),
    ),
  });
  expect(payload.max_tokens).toBe(128);
});

it("accepts exactly 80,000 bytes and refuses one byte more before forwarding", () => {
  const padding =
    CACHE_PREFIX_LIMITS.requestBytes -
    Buffer.byteLength(JSON.stringify({ text: "", max_tokens: 128 }));
  expect(
    createCachePrefixBudget().prepare({ text: "x".repeat(padding) })
      .requestBytes,
  ).toBe(80_000);
  const budget = createCachePrefixBudget();
  expect(() => budget.prepare({ text: "x".repeat(padding + 1) })).toThrow(
    "exceeds byte limit",
  );
  expect(() => budget.prepare({})).toThrow("run already stopped");
});

it("counts UTF-8 bytes rather than characters", () => {
  expect(() =>
    createCachePrefixBudget().prepare({ text: "é".repeat(40_000) }),
  ).toThrow("exceeds byte limit");
});

it("allows three reservations and blocks an extra request without retry", () => {
  const budget = createCachePrefixBudget();
  for (let i = 1; i <= 3; i++) expect(budget.prepare({}).request).toBe(i);
  expect(() => budget.prepare({})).toThrow("request limit exceeded");
  expect(() => budget.prepare({})).toThrow("run already stopped");
});

it("counts ordinary input, cache reads and cache writes together", () => {
  const budget = createCachePrefixBudget();
  expect(budget.recordUsage(usage)).toEqual({
    totalInput: 10_032,
    cumulativeInput: 10_032,
  });
  expect(budget.recordUsage(usage).cumulativeInput).toBe(20_064);
});

it("stops after an input-threshold breach and forbids another request", () => {
  const budget = createCachePrefixBudget();
  budget.prepare({});
  expect(() => budget.recordUsage({ ...usage, cacheRead: 20_000 })).toThrow(
    "reported input exceeds stop threshold",
  );
  expect(() => budget.prepare({})).toThrow("run already stopped");
});

it("accepts the inclusive input and output boundaries", () => {
  const budget = createCachePrefixBudget();
  for (let i = 1; i <= 3; i++) {
    budget.prepare({});
    expect(
      budget.recordUsage({
        input: 0,
        cacheRead: 20_000,
        cacheWrite: 0,
        output: 128,
      }).cumulativeInput,
    ).toBe(i * 20_000);
  }
});

it.each([NaN, Infinity, -1, 0.5])("rejects invalid usage %s", (input) => {
  const budget = createCachePrefixBudget();
  expect(() => budget.recordUsage({ ...usage, input })).toThrow(
    "invalid token usage",
  );
  expect(() => budget.prepare({})).toThrow("run already stopped");
});

it("stops if reported output violates the forwarded cap", () => {
  const budget = createCachePrefixBudget();
  expect(() => budget.recordUsage({ ...usage, output: 129 })).toThrow(
    "reported output exceeds cap",
  );
  expect(() => budget.prepare({})).toThrow("run already stopped");
});

it("blocks forwarding and usage acceptance at the overall deadline", () => {
  let now = 0;
  const budget = createCachePrefixBudget(() => now);
  now = CACHE_PREFIX_LIMITS.runMs - 1;
  budget.prepare({});
  now++;
  expect(() => budget.prepare({})).toThrow("overall deadline exceeded");
  const other = createCachePrefixBudget(() => now);
  now += CACHE_PREFIX_LIMITS.runMs;
  expect(() => other.recordUsage(usage)).toThrow("overall deadline exceeded");
});

it("refuses thinking rather than silently increasing the output budget", () => {
  expect(() =>
    createCachePrefixBudget().prepare({ thinking: { type: "adaptive" } }),
  ).toThrow("thinking is outside");
  expect(() =>
    createCachePrefixBudget().prepare({ thinking: { type: "disabled" } }),
  ).not.toThrow();
});

it("refuses further requests after cancellation", () => {
  const budget = createCachePrefixBudget();
  budget.stop();
  expect(() => budget.prepare({})).toThrow("run already stopped");
});
