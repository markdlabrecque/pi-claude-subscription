import { expect, it } from "vitest";
import { readCacheDiagnostic } from "../scripts/acceptance/cache-prefix-diagnostics";

const prefix = "[pi-claude-subscription] request diagnostics ";
const record = {
  environmentNormalized: true,
  upstreamCount: 1,
  rejectedCount: 0,
  terminalReason: "completed",
  cancelled: false,
  timedOut: false,
  requestId: "private-id",
  unexpectedPrivateField: "private transcript",
};

it("extracts only safe diagnostic fields", () => {
  const output = readCacheDiagnostic(prefix + JSON.stringify(record));
  expect(output).toEqual({
    environmentNormalized: true,
    upstreamCount: 1,
    rejectedCount: 0,
    completed: true,
    cancelled: false,
    timedOut: false,
  });
  expect(JSON.stringify(output)).not.toContain("private");
});

it.each([
  undefined,
  "raw secret CLI line",
  "[pi-claude-subscription] relay debug: private/path",
  prefix + "malformed",
  prefix + "null",
  prefix + "{}",
])("does not echo non-diagnostic or malformed output %j", (line) => {
  expect(readCacheDiagnostic(line)).toBeUndefined();
});

it("retains failed normalization and terminal outcomes without raw reason strings", () => {
  expect(
    readCacheDiagnostic(
      prefix +
        JSON.stringify({
          ...record,
          environmentNormalized: false,
          terminalReason: "private error",
          rejectedCount: 1,
          cancelled: true,
        }),
    ),
  ).toEqual({
    environmentNormalized: false,
    upstreamCount: 1,
    rejectedCount: 1,
    completed: false,
    cancelled: true,
    timedOut: false,
  });
});

it("rejects an unexpected non-numeric request count", () => {
  expect(
    readCacheDiagnostic(
      prefix + JSON.stringify({ ...record, upstreamCount: "secret" }),
    ),
  ).toBeUndefined();
});
