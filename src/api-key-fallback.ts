/**
 * API-key fallback: route requests through pi's normal Anthropic provider
 * instead of the Claude CLI subprocess, when subscription limits run out.
 *
 * Switched by an environment variable, read on every request, so no reinstall
 * is needed. Unset it (or set it to 0) to return to the subscription path.
 */

import {
  type TranscriptContext,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { envFlag } from "./env-flag.js";

export const API_KEY_FALLBACK_ENV = "PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK";

export function isApiKeyFallbackEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return envFlag(API_KEY_FALLBACK_ENV, env);
}

/** Stream a request through pi's Anthropic provider using ANTHROPIC_API_KEY. */
export function streamViaAnthropic(
  model: Model<any>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) {
  // Models missing from the pi-ai catalog (e.g. the fable alias) are rebuilt
  // from the subscription model.
  const anthropicModel =
    anthropicProvider()
      .getModels()
      .find((m) => m.id === model.id) ??
    ({
      ...model,
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    } as Model<"anthropic-messages">);

  return streamSimple(anthropicModel, context, {
    ...options,
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
}
