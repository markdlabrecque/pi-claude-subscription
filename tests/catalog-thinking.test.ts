import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import extension from "../index";
import { filterLatestPerFamily } from "../src/model-filter";
import { mapThinkingEffort } from "../src/thinking-config";
import { installFakeClaude, startFakeUpstream } from "./harness";

afterEach(() => vi.unstubAllEnvs());

it("preserves catalog capabilities and exercises every advertised CLI thinking level", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-catalog-test-"));
  const upstream = await startFakeUpstream();
  const claude = installFakeClaude(upstream.url);
  vi.stubEnv("PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK", "0");
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(root, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(root, "catalog.json"),
      refreshOnCreate: false,
    });
    extension({
      registerProvider: (
        id: string,
        config: Parameters<ModelRuntime["registerProvider"]>[1],
      ) => runtime.registerProvider(id, config),
      on: vi.fn(),
      getAllTools: () => [],
    } as unknown as ExtensionAPI);
    const catalog = filterLatestPerFamily([...anthropicProvider().getModels()]);
    const models = runtime.getModels("pi-claude-subscription");
    expect(models.map((m) => m.id)).toEqual([
      "claude-fable-5-1",
      "claude-haiku-5-5",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ]);
    expect(models.filter((m) => m.id.includes("fable"))).toHaveLength(1);
    let request = 0;
    for (const model of models) {
      const original = catalog.find((m) => m.id === model.id)!;
      expect(model).toMatchObject({
        id: original.id,
        name: original.name,
        input: original.input,
        reasoning: original.reasoning,
        cost: original.cost,
        inputLimits: original.inputLimits,
        contextWindow: original.contextWindow,
        maxTokens: original.maxTokens,
      });
      expect(model.input).toEqual(["text", "image"]);
      const levels = getSupportedThinkingLevels(model);
      expect(levels).toEqual(
        model.id.includes("fable")
          ? ["minimal", "low", "medium", "high", "xhigh", "max"]
          : model.id.includes("haiku")
            ? ["off", "low", "medium", "high", "xhigh", "max"]
            : ["low", "medium", "high", "xhigh", "max"],
      );
      for (const requested of [undefined, ...levels]) {
        const effective =
          requested === undefined
            ? undefined
            : clampThinkingLevel(model, requested);
        expect(effective).toBe(requested);
        const reasoning = effective === "off" ? undefined : effective;
        const stream = runtime.streamSimple(
          model,
          {
            messages: [{ role: "user", content: "Check effort", timestamp: 1 }],
          },
          { reasoning },
        );
        for await (const _ of stream);
        expect((await stream.result()).stopReason).toBe("stop");
        const args = (
          upstream.requests[request++].body as { fake_args: string[] }
        ).fake_args;
        expect(args[args.indexOf("--model") + 1]).toBe(model.id);
        const expected =
          reasoning === undefined
            ? undefined
            : reasoning === "max"
              ? "max"
              : model.id.includes("opus")
                ? (
                    {
                      minimal: "low",
                      low: "low",
                      medium: "high",
                      high: "max",
                      xhigh: "max",
                    } as const
                  )[reasoning]
                : (
                    {
                      minimal: "low",
                      low: "low",
                      medium: "medium",
                      high: "high",
                      xhigh: "high",
                    } as const
                  )[reasoning];
        if (expected === undefined) expect(args).not.toContain("--effort");
        else expect(args[args.indexOf("--effort") + 1]).toBe(expected);
      }
      for (const requested of [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ] satisfies ModelThinkingLevel[]) {
        expect(levels).toContain(clampThinkingLevel(model, requested));
      }
    }
    expect(upstream.requests).toHaveLength(request);
    const noReasoning = { ...models[0], reasoning: false };
    expect(getSupportedThinkingLevels(noReasoning)).toEqual(["off"]);
    expect(clampThinkingLevel(noReasoning, "max")).toBe("off");
    expect(mapThinkingEffort("max", "claude-sonnet-5-5")).toBe("max");
    expect(() => mapThinkingEffort("max", "claude-sonnet-4-5")).toThrow(
      "not verified",
    );
    expect(() => mapThinkingEffort("high", "fake-opus-999")).toThrow(
      "not verified",
    );
  } finally {
    claude.restore();
    await upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
