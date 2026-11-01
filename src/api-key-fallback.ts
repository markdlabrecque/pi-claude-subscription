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
import { envFlag, resolveEnv } from "./env-flag.js";
import {
  startAuditRequest,
  unknownUsage,
  unknownCleanup,
  observeAuditUsage,
  estimateAuditCost,
} from "./audit-request.js";

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
  const env = resolveEnv(options?.env);
  const audit = startAuditRequest(model, env, "api");
  const usage = unknownUsage();
  let hook: string | undefined;
  let http: { status: number; retryAfter?: string } | undefined;
  const details = () => ({ ...(hook && { hook }), ...(http && { http }) });
  try {
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

    const stream = streamSimple(anthropicModel, context, {
      ...options,
      apiKey: env.ANTHROPIC_API_KEY,
      ...(audit.enabled && {
        onPayload:
          options?.onPayload &&
          (async (payload, selectedModel) => {
            try {
              return await options.onPayload!(payload, selectedModel);
            } catch (error) {
              hook = "onPayload";
              throw error;
            }
          }),
        onResponse: async (response, selectedModel) => {
          if (response.status >= 400) {
            const retryAfter = response.headers["retry-after"];
            http = {
              status: response.status,
              ...(typeof retryAfter === "string" &&
                /^\d{1,9}$/.test(retryAfter) && { retryAfter }),
            };
          }
          try {
            await options?.onResponse?.(response, selectedModel);
          } catch (error) {
            hook = "onResponse";
            throw error;
          }
        },
        onProviderStreamEvent: async (event, selectedModel) => {
          observeAuditUsage(usage, event);
          try {
            await options?.onProviderStreamEvent?.(event, selectedModel);
          } catch (error) {
            hook = "onProviderStreamEvent";
            throw error;
          }
        },
      }),
    });
    if (audit.enabled)
      void stream.result().then(
        (message) =>
          audit.finish({
            outcome:
              message.stopReason === "aborted"
                ? "cancelled"
                : message.stopReason === "error"
                  ? "error"
                  : "success",
            reason:
              message.stopReason === "aborted"
                ? "cancelled"
                : message.stopReason === "error"
                  ? hook
                    ? "hook_error"
                    : http
                      ? "http_error"
                      : "error"
                  : message.stopReason,
            ...details(),
            usage,
            estimatedCost: estimateAuditCost(anthropicModel, usage),
            cleanup: unknownCleanup(),
          }),
        () =>
          audit.finish({
            outcome: "error",
            reason: hook ? "hook_error" : http ? "http_error" : "error",
            ...details(),
            usage,
            estimatedCost: estimateAuditCost(anthropicModel, usage),
            cleanup: unknownCleanup(),
          }),
      );
    return stream;
  } catch (error) {
    void audit.finish({
      outcome: "error",
      reason: hook ? "hook_error" : http ? "http_error" : "error",
      ...details(),
      usage: unknownUsage(),
      estimatedCost: { total: null },
      cleanup: unknownCleanup(),
    });
    throw error;
  }
}
