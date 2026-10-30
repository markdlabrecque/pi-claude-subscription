import { describe, it, expect, vi, beforeEach } from "vitest";

// Real-shaped calculateCost: prices each bucket from model.cost (USD per million tokens).
vi.mock("@earendil-works/pi-ai", () => ({
  calculateCost: vi.fn((model: any, usage: any) => {
    usage.cost = {
      input: (model.cost.input / 1e6) * usage.input,
      output: (model.cost.output / 1e6) * usage.output,
      cacheRead: (model.cost.cacheRead / 1e6) * usage.cacheRead,
      cacheWrite: (model.cost.cacheWrite / 1e6) * usage.cacheWrite,
      total: 0,
    };
    usage.cost.total =
      usage.cost.input +
      usage.cost.output +
      usage.cost.cacheRead +
      usage.cost.cacheWrite;
    return usage.cost;
  }),
}));

import { createEventBridge } from "../src/event-bridge";

const model = {
  id: "claude-sonnet-4-5-20250929",
  name: "Claude Sonnet 4.5",
  api: "pi-claude-subscription",
  provider: "anthropic",
  // 5m write = 3.75/M, 1h write = 2 x input = 6/M
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200000,
  maxTokens: 8192,
};

function setup() {
  const stream = { push: vi.fn(), end: vi.fn() };
  return createEventBridge(stream as any, model as any);
}

describe("cache-write cost uses reported cache tier", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prices 1-hour tokens at 2x input and 5-minute tokens at the cacheWrite rate", () => {
    const bridge = setup();
    bridge.handleEvent({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 100,
          output_tokens: 0,
          cache_creation_input_tokens: 3000,
          cache_creation: {
            ephemeral_5m_input_tokens: 1000,
            ephemeral_1h_input_tokens: 2000,
          },
        },
      },
    });
    const { usage } = bridge.getOutput();
    expect(usage.cacheWrite).toBe(3000);
    expect(usage.totalTokens).toBe(3100);
    expect(usage.cost.cacheWrite).toBeCloseTo(0.00375 + 0.012, 10);
    expect(usage.cost.total).toBeCloseTo(0.0003 + 0.00375 + 0.012, 10);
  });

  it("falls back to the model cacheWrite rate when there is no breakdown", () => {
    const bridge = setup();
    bridge.handleEvent({
      type: "message_start",
      message: {
        usage: { input_tokens: 100, cache_creation_input_tokens: 2000 },
      },
    });
    const { usage } = bridge.getOutput();
    expect(usage.cost.cacheWrite).toBeCloseTo(0.0075, 10);
  });

  it("keeps 1-hour pricing when a later delta omits cache fields", () => {
    const bridge = setup();
    bridge.handleEvent({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 2000,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 2000,
          },
        },
      },
    });
    bridge.handleEvent({ type: "message_delta", usage: { output_tokens: 40 } });
    const { usage } = bridge.getOutput();
    expect(usage.cacheWrite).toBe(2000);
    expect(usage.totalTokens).toBe(2140);
    expect(usage.cost.cacheWrite).toBeCloseTo(0.012, 10);
  });

  it("applies corrected cache counters from a delta without double counting", () => {
    const bridge = setup();
    bridge.handleEvent({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 1000,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 1000,
          },
        },
      },
    });
    bridge.handleEvent({
      type: "message_delta",
      usage: {
        output_tokens: 40,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 3000,
        cache_creation: {
          ephemeral_5m_input_tokens: 1000,
          ephemeral_1h_input_tokens: 2000,
        },
      },
    });
    const { usage } = bridge.getOutput();
    expect(usage.cacheWrite).toBe(3000);
    expect(usage.cacheRead).toBe(500);
    expect(usage.totalTokens).toBe(100 + 40 + 500 + 3000);
    expect(usage.cost.cacheWrite).toBeCloseTo(0.00375 + 0.012, 10);
    expect(usage.cost.total).toBeCloseTo(
      0.0003 + 0.0006 + 0.00015 + 0.00375 + 0.012,
      10,
    );
  });
});
