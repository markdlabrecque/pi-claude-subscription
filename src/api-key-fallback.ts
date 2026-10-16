/**
 * API-key fallback: route requests through pi's normal Anthropic provider
 * instead of the Claude CLI subprocess, when subscription limits run out.
 *
 * Switched by an environment variable, read on every request, so no reinstall
 * is needed. Unset it (or set it to 0) to return to the subscription path.
 */

import {
  getEnvApiKey,
  getModels,
  streamSimpleAnthropic,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
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
  context: Context,
  options?: SimpleStreamOptions,
) {
  // Models missing from the pi-ai catalog (e.g. the fable alias) are rebuilt
  // from the subscription model.
  const anthropicModel =
    getModels("anthropic").find((m) => m.id === model.id) ??
    ({
      ...model,
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    } as Model<"anthropic-messages">);

  return streamSimpleAnthropic(anthropicModel, context, {
    ...options,
    apiKey: getEnvApiKey("anthropic"),
  });
}
