/**
 * Debug flag for logging. Default logs never contain tokens, prompts or tool
 * arguments. Setting PI_CLAUDE_SUBSCRIPTION_DEBUG=1 (or true) adds fuller
 * detail. Read on every call, so nothing needs reinstalling.
 */

import { envFlag } from "./env-flag.js";

export const DEBUG_ENV = "PI_CLAUDE_SUBSCRIPTION_DEBUG";

export function isDebugEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return envFlag(DEBUG_ENV, env);
}
