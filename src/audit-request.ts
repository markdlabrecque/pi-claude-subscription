import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import { createAuditSink } from "./audit.js";
import { getSessionMode } from "./session-mode.js";
import { getObservedCliVersion } from "./process-manager.js";

export const extensionRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const unknownUsage = () => ({
  input: null as number | null,
  output: null as number | null,
  cacheRead: null as number | null,
  cacheWrite: null as number | null,
  cacheWrite1h: null as number | null,
});
export type AuditUsage = ReturnType<typeof unknownUsage>;

/** Track reported wire fields, never the SDK's pre-response zero defaults. */
export function observeAuditUsage(usage: AuditUsage, event: unknown): void {
  if (!event || typeof event !== "object") return;
  const message = event as {
    type?: string;
    message?: { usage?: Record<string, unknown> };
    usage?: Record<string, unknown>;
  };
  if (message.type !== "message_start" && message.type !== "message_delta")
    return;
  const observed =
    message.type === "message_start" ? message.message?.usage : message.usage;
  if (!observed || typeof observed !== "object") return;
  if (message.type === "message_start") Object.assign(usage, unknownUsage());
  for (const [key, field] of [
    ["input", "input_tokens"],
    ["output", "output_tokens"],
    ["cacheRead", "cache_read_input_tokens"],
    ["cacheWrite", "cache_creation_input_tokens"],
  ] as const) {
    const value = observed[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      usage[key] = value;
  }
  const breakdown = observed.cache_creation as
    | { ephemeral_1h_input_tokens?: unknown }
    | undefined;
  const longWrite = breakdown?.ephemeral_1h_input_tokens;
  if (
    typeof longWrite === "number" &&
    Number.isFinite(longWrite) &&
    longWrite >= 0
  )
    usage.cacheWrite1h = longWrite;
}

function packageVersion(path: string): string | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")).version;
    return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

/** No CLI/account probes. Unavailable version observations stay null. */
export function auditVersions() {
  return {
    extension: packageVersion(join(extensionRoot, "package.json")),
    pi: packageVersion(
      join(
        extensionRoot,
        "node_modules/@earendil-works/pi-coding-agent/package.json",
      ),
    ),
    cli: getObservedCliVersion(),
  };
}

export function startAuditRequest(
  model: Model<any>,
  env: Record<string, string | undefined>,
  route: "cli" | "api",
) {
  const enabled = ["1", "true"].includes(
    env.PI_CLAUDE_SUBSCRIPTION_AUDIT ?? "",
  );
  const sink = createAuditSink({ extensionRoot, env });
  const common = enabled
    ? {
        requestId: randomUUID(),
        route,
        model: model.id,
        sessionMode: getSessionMode(env),
        versions: auditVersions(),
      }
    : {};
  const start = enabled
    ? sink.append({ event: "request_start", ...common })
    : Promise.resolve();
  let finished = false;
  return {
    enabled,
    async finish(record: Record<string, unknown>) {
      if (!enabled || finished) return;
      finished = true;
      await start;
      await sink.append({ event: "request_terminal", ...common, ...record });
    },
  };
}

export const unknownCleanup = () => ({
  attempted: false,
  process: "unknown",
  relay: "unknown",
  sandbox: "unknown",
  mcp: "unknown",
});

/** API-equivalent estimates for observed buckets only, not subscription billing. */
export function estimateAuditCost(model: Model<any>, usage: AuditUsage) {
  const price = (count: number | null, rate: number) =>
    count === null ? null : (count * rate) / 1e6;
  const cost = {
    input: price(usage.input, model.cost.input),
    output: price(usage.output, model.cost.output),
    cacheRead: price(usage.cacheRead, model.cost.cacheRead),
    cacheWrite: price(usage.cacheWrite, model.cost.cacheWrite),
    total: null as number | null,
  };
  if (usage.cacheWrite !== null && usage.cacheWrite1h !== null) {
    cost.cacheWrite =
      ((usage.cacheWrite - usage.cacheWrite1h) * model.cost.cacheWrite +
        usage.cacheWrite1h * 2 * model.cost.input) /
      1e6;
  }
  const values = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite];
  if (values.every((value) => value !== null))
    cost.total = values.reduce<number>((sum, value) => sum + value!, 0);
  return cost;
}
