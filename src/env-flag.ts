/** True when the variable is set to "1" or "true" (any case). */
export function envFlag(
  name: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[name]?.toLowerCase();
  return value === "1" || value === "true";
}
