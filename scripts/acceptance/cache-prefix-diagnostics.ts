export type CacheDiagnostic = {
  environmentNormalized: boolean;
  upstreamCount: number;
  rejectedCount: number;
  completed: boolean;
  cancelled: boolean;
  timedOut: boolean;
};

/** Allowlist only non-secret fields. Never echo unrecognized debug output. */
export function readCacheDiagnostic(
  line: unknown,
): CacheDiagnostic | undefined {
  const prefix = "[pi-claude-subscription] request diagnostics ";
  if (typeof line !== "string" || !line.startsWith(prefix)) return;
  try {
    const record = JSON.parse(line.slice(prefix.length));
    if (
      typeof record.environmentNormalized !== "boolean" ||
      !Number.isSafeInteger(record.upstreamCount) ||
      record.upstreamCount < 0 ||
      !Number.isSafeInteger(record.rejectedCount) ||
      record.rejectedCount < 0 ||
      typeof record.cancelled !== "boolean" ||
      typeof record.timedOut !== "boolean"
    )
      return;
    return {
      environmentNormalized: record.environmentNormalized,
      upstreamCount: record.upstreamCount,
      rejectedCount: record.rejectedCount,
      completed:
        record.terminalReason === "completed" ||
        record.terminalReason === "tool-use",
      cancelled: record.cancelled,
      timedOut: record.timedOut,
    };
  } catch {
    return;
  }
}
