/** True when the variable is set to "1" or "true" (any case). */
export function envFlag(
  name: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[name]?.toLowerCase();
  return value === "1" || value === "true";
}

/**
 * One request's environment: the process environment with the caller's
 * provider-scoped values on top. A fresh frozen copy, so neither input changes
 * and no request sees another's values. Empty scoped values fall through to
 * the process value, as in pi-ai's own provider env lookup.
 */
export function resolveEnv(
  scoped?: Record<string, string>,
): Readonly<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(scoped ?? {})) {
    if (value) env[key] = value;
  }
  return Object.freeze(env);
}
