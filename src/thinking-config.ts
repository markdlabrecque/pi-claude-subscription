/**
 * Thinking effort configuration for mapping pi's ThinkingLevel to Claude CLI --effort flags.
 *
 * Maps pi's reasoning levels (minimal/low/medium/high/xhigh) to the CLI's effort
 * levels (low/medium/high/max). Opus models get an elevated mapping where medium
 * becomes high and high becomes max, leveraging their superior reasoning capability.
 *
 * IMPORTANT: The CLI does NOT support --thinking-budget. Only --effort is supported.
 */

import type {
  ThinkingLevel,
  ThinkingBudgets,
  Model,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

/** CLI effort levels accepted by the --effort flag */
export type CliEffortLevel = "low" | "medium" | "high" | "max";

/**
 * Standard model mapping: pi ThinkingLevel -> CLI effort.
 * Existing non-Opus levels retain their mapping. Explicit max requires catalog support.
 */
const STANDARD_EFFORT_MAP: Record<ThinkingLevel, CliEffortLevel> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high", // preserve the existing non-Opus mapping
  max: "max",
};

/**
 * Opus model mapping: shifted up for elevated reasoning.
 * Opus models get max capability at high/xhigh levels.
 */
const OPUS_EFFORT_MAP: Record<ThinkingLevel, CliEffortLevel> = {
  minimal: "low",
  low: "low",
  medium: "high", // shifted: standard high
  high: "max", // shifted: maximum capability
  xhigh: "max", // Opus gets max
  max: "max",
};

/** Describe Pi levels using CLI efforts, retaining catalog capability exclusions.
 * Direct-API effort values are not automatically CLI effort values.
 */
export function getCliThinkingLevelMap(model: Model<any>): ThinkingLevelMap {
  const map = isOpusModel(model.id) ? OPUS_EFFORT_MAP : STANDARD_EFFORT_MAP;
  const levels = { ...model.thinkingLevelMap };
  for (const level of Object.keys(map) as ThinkingLevel[]) {
    if (levels[level] === null) continue;
    // Extended levels are opt-in in the SDK. Do not invent support.
    if ((level === "xhigh" || level === "max") && levels[level] === undefined)
      continue;
    const effort = map[level];
    levels[level] =
      effort === "max" && model.thinkingLevelMap?.max !== "max" ? null : effort;
  }
  return levels;
}

/**
 * Detect whether a model ID refers to an Opus model.
 * Uses includes('opus') for forward-compatibility with future Opus versions.
 *
 * @param modelId - The model identifier string
 * @returns true if the model is an Opus variant
 */
export function isOpusModel(modelId: string): boolean {
  return modelId.includes("opus");
}

/**
 * Map pi's ThinkingLevel to a CLI effort string.
 *
 * When reasoning is undefined, returns undefined so the --effort flag is omitted
 * entirely, letting the CLI use its default behavior. When thinkingBudgets are
 * provided, a console.warn is logged because the CLI only supports effort levels,
 * not token budgets.
 *
 * @param reasoning - Pi's thinking level (undefined = omit flag)
 * @param modelId - Model ID for Opus detection
 * @param thinkingBudgets - Custom budgets (logged as unsupported, not applied)
 * @returns CLI effort level string, or undefined if flag should be omitted
 */
export function mapThinkingEffort(
  reasoning?: ThinkingLevel,
  modelId?: string,
  thinkingBudgets?: ThinkingBudgets,
): CliEffortLevel | undefined {
  if (reasoning === undefined) {
    return undefined; // omit --effort flag entirely
  }

  if (thinkingBudgets && Object.keys(thinkingBudgets).length > 0) {
    console.warn(
      "[pi-claude-subscription] Custom thinkingBudgets are not supported with CLI subprocess. " +
        "The CLI uses --effort levels instead of token budgets. Budgets will be ignored.",
    );
  }

  const isOpus = modelId ? isOpusModel(modelId) : false;
  const map = isOpus ? OPUS_EFFORT_MAP : STANDARD_EFFORT_MAP;
  const effort = map[reasoning];
  if (effort === "max") {
    // A family substring is not evidence of max support. Dated catalog IDs
    // share the capability of their undated model, not arbitrary future models.
    const id = modelId?.replace(/-\d{8}$/, "");
    const model = anthropicProvider()
      .getModels()
      .find((m) => m.id.replace(/-\d{8}$/, "") === id);
    if (model?.thinkingLevelMap?.max !== "max") {
      throw new Error(
        `CLI max effort is not verified for model ${modelId ?? "(unspecified)"}`,
      );
    }
  }
  return effort;
}
