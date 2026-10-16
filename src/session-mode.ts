/**
 * Session mode: how a follow-up turn gets its history to the Claude CLI.
 *
 * - `replay` (default): rebuild the full Pi history into one call, with no CLI
 *   session state. Works in throwaway containers.
 * - `resume`: reuse the CLI's own session with `--resume`.
 *
 * Read from the environment on every request, so switching is a config change.
 */

export type SessionMode = "replay" | "resume";

export const SESSION_MODE_ENV = "PI_CLAUDE_SUBSCRIPTION_SESSION_MODE";

export function getSessionMode(
  env: Record<string, string | undefined> = process.env,
): SessionMode {
  return env[SESSION_MODE_ENV]?.toLowerCase() === "resume"
    ? "resume"
    : "replay";
}
