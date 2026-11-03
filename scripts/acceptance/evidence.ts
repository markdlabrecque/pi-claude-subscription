/**
 * Offline evidence helpers for live acceptance runs (approval gate, run
 * records, scenario assertions, aggregation, notes). Stub: the contract is
 * defined by tests/acceptance-evidence.test.ts; implementation pending (#79).
 */

const notImplemented = (name: string): never => {
  throw new Error(`${name}: not implemented`);
};

export function assertApproved(..._args: any[]): any {
  return notImplemented("assertApproved");
}
export function assertLocalExecution(..._args: any[]): any {
  return notImplemented("assertLocalExecution");
}
export function resolveRequestedModels(..._args: any[]): any {
  return notImplemented("resolveRequestedModels");
}
export function evaluateScenario(..._args: any[]): any {
  return notImplemented("evaluateScenario");
}
export function buildRunRecord(..._args: any[]): any {
  return notImplemented("buildRunRecord");
}
export function aggregateEvidence(..._args: any[]): any {
  return notImplemented("aggregateEvidence");
}
export function renderAcceptanceNotes(..._args: any[]): any {
  return notImplemented("renderAcceptanceNotes");
}
