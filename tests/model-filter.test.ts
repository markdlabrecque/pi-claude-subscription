import { describe, it, expect } from "vitest";
import { filterLatestPerFamily } from "../src/model-filter";

const id = (id: string) => ({ id });

describe("filterLatestPerFamily", () => {
  it("keeps only the latest version of each family", () => {
    const input = [
      id("claude-opus-4-5"),
      id("claude-opus-4-5-20251101"),
      id("claude-opus-4-6"),
      id("claude-opus-4-7"),
      id("claude-opus-4-8"),
      id("claude-opus-5"),
      id("claude-opus-5-5"),
      id("claude-sonnet-4-5"),
      id("claude-sonnet-4-5-20250929"),
      id("claude-sonnet-4-6"),
      id("claude-sonnet-5"),
      id("claude-sonnet-5-5"),
      id("claude-haiku-4-5"),
      id("claude-haiku-4-5-20251001"),
      id("claude-haiku-5-5"),
      id("claude-fable-5"),
      id("claude-fable-5-1"),
    ];

    expect(filterLatestPerFamily(input).map((m) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5-1",
    ]);
  });

  it("prefers the undated alias over a dated variant of the same version", () => {
    const input = [id("claude-sonnet-4-5-20250929"), id("claude-sonnet-4-5")];
    expect(filterLatestPerFamily(input)).toEqual([id("claude-sonnet-4-5")]);
  });

  it("prefers the newest date stamp among dated variants", () => {
    const input = [
      id("claude-opus-4-5-20251101"),
      id("claude-opus-4-5-20250601"),
    ];
    expect(filterLatestPerFamily(input)).toEqual([
      id("claude-opus-4-5-20251101"),
    ]);
  });

  it("keeps models whose id matches no known family", () => {
    const input = [id("claude-mythos-1"), id("claude-opus-4-5")];
    expect(filterLatestPerFamily(input).map((m) => m.id)).toEqual([
      "claude-mythos-1",
      "claude-opus-4-5",
    ]);
  });
});
