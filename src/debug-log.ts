/**
 * Debug flag for logging. Default logs never contain tokens, prompts or tool
 * arguments. Setting PI_CLAUDE_SUBSCRIPTION_DEBUG=1 (or true) adds fuller
 * detail. Read on every call, so nothing needs reinstalling.
 */

export const DEBUG_ENV = "PI_CLAUDE_SUBSCRIPTION_DEBUG";

export function isDebugEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[DEBUG_ENV]?.toLowerCase();
  return value === "1" || value === "true";
}
