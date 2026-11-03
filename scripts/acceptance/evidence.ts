/**
 * Offline evidence rules for live acceptance runs (#79).
 *
 * Everything here is pure: it never spawns the CLI, reads credentials or
 * sends a request. `run.ts` uses it to gate and record live runs, `notes.ts`
 * uses it to rebuild the acceptance notes from saved run records, and CI runs
 * only its unit tests.
 */

export const SCENARIO_IDS = [
  "tool-turns-50",
  "compaction-continuation",
  "fresh-container-replay",
] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

/** Fixture identity per scenario. Bump one when its prompts or tools change. */
export const SCENARIO_FIXTURES: Record<ScenarioId, string> = {
  "tool-turns-50": "turns-v1",
  "compaction-continuation": "compaction-v1",
  "fresh-container-replay": "replay-v1",
};

export const TOOL_TURN_TARGET = 50;

/** The matrix #79 asks for: both local hosts and the four requested models. */
export const REQUESTED_HOSTS = ["darwin", "linux"] as const;
export const REQUESTED_MODELS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-1",
] as const;

// Approval -------------------------------------------------------------------

export interface RunRequest {
  host: string;
  model: string;
  scenario: string;
}

export interface ApprovalScope {
  hosts: string[];
  models: string[];
  scenarios: string[];
}

export interface ApprovalLimits {
  maxRequests: number;
  maxTokens: number;
  maxSeconds: number;
}

export interface Approval {
  ref: string;
  approvedBy?: string;
  scope: ApprovalScope;
  limits: ApprovalLimits;
  stopConditions: string[];
}

const LIMIT_KEYS = ["maxRequests", "maxTokens", "maxSeconds"] as const;

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isTextList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(isText);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Refuse a live run unless an explicit approval covers it. Returns the
 * approved scope, limits and stop conditions, to be recorded before the
 * first request.
 */
export function assertApproved(
  approval: Approval | null | undefined,
  request: RunRequest,
): Approval {
  if (!approval || typeof approval !== "object") {
    throw new Error(
      "Live acceptance runs need an explicit approval; none was given",
    );
  }
  const { ref, approvedBy, scope, limits, stopConditions } = approval;
  if (!isText(ref)) throw new Error("Approval has no reference");
  if (
    !scope ||
    !isTextList(scope.hosts) ||
    !isTextList(scope.models) ||
    !isTextList(scope.scenarios)
  ) {
    throw new Error(
      `Approval ${ref} must list the approved hosts, models and scenarios`,
    );
  }
  if (
    !limits ||
    !LIMIT_KEYS.every((key) => isCount(limits[key]) && limits[key] > 0)
  ) {
    throw new Error(
      `Approval ${ref} must set positive ${LIMIT_KEYS.join(", ")} limits`,
    );
  }
  if (!isTextList(stopConditions)) {
    throw new Error(`Approval ${ref} must list at least one stop condition`);
  }

  const outside = [
    ["host", request.host, scope.hosts],
    ["model", request.model, scope.models],
    ["scenario", request.scenario, scope.scenarios],
  ]
    .filter(
      ([, value, allowed]) => !(allowed as string[]).includes(value as string),
    )
    .map(([name, value]) => `${name} ${value}`);
  if (outside.length) {
    throw new Error(
      `Run is outside the approved scope of ${ref}: ${outside.join(", ")}`,
    );
  }

  return {
    ref,
    ...(isText(approvedBy) ? { approvedBy } : {}),
    scope: {
      hosts: [...scope.hosts],
      models: [...scope.models],
      scenarios: [...scope.scenarios],
    },
    limits: {
      maxRequests: limits.maxRequests,
      maxTokens: limits.maxTokens,
      maxSeconds: limits.maxSeconds,
    },
    stopConditions: [...stopConditions],
  };
}

const CI_ENV_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "TF_BUILD",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
];

/** Live requests run only on a maintainer's machine, never in CI. */
export function assertLocalExecution(
  env: Record<string, string | undefined>,
): void {
  const found = CI_ENV_KEYS.find((key) => isText(env[key]));
  if (found) {
    throw new Error(
      `Live acceptance runs never execute in CI (${found} is set)`,
    );
  }
}

// Models ---------------------------------------------------------------------

export interface ModelResolution {
  requested: string;
  status: "available" | "untested";
  resolvedId: string | null;
}

/**
 * Match requested model ids exactly against the available ids. A missing
 * model is untested; no other model is substituted for it.
 */
export function resolveRequestedModels(
  requested: readonly string[],
  available: readonly string[],
): ModelResolution[] {
  return requested.map((id) =>
    available.includes(id)
      ? { requested: id, status: "available", resolvedId: id }
      : { requested: id, status: "untested", resolvedId: null },
  );
}

// Scenarios ------------------------------------------------------------------

export interface ScenarioEvaluation {
  scenario: ScenarioId;
  outcome: "passed" | "failed";
  reasons: string[];
}

export interface ToolTurnsObservation {
  toolTurns: number;
  allToolTurnsOneUpstream: boolean;
  rejectedExtraRequests: number;
  claudeCodeToolExecutions: number;
  finalText: string;
  /** Upstream requests for the final text turn, when measured. */
  finalTurnUpstream?: number;
}

export interface CompactionObservation {
  seededFacts: string[];
  finalText: string;
  compacted: boolean;
  allOneUpstream?: boolean;
  rejectedExtraRequests?: number;
}

export interface ReplayObservation {
  codeFromFirstContainer: string;
  finalText: string;
  allOneUpstream: boolean;
  rejectedExtraRequests: number;
  /** False when the second container held CLI state before its first request. */
  freshCliState?: boolean;
}

/** Expected outcomes, stated before any usage is spent. */
export const SCENARIO_EXPECTATIONS: Record<ScenarioId, string> = {
  "tool-turns-50": `Exactly ${TOOL_TURN_TARGET} tool-using turns, each with one upstream request; no relay rejections; no Claude Code tool executions; a final text turn that says "finished".`,
  "compaction-continuation":
    "Facts issued only in tool results are summarized by Pi's compaction, the original messages are dropped, and the next answer repeats every fact.",
  "fresh-container-replay":
    "A second, fresh container answers with the code issued only in the first container's history, one upstream request per turn and no relay rejections.",
};

const text = (value: unknown) => (typeof value === "string" ? value : "");

function checkToolTurns(o: Partial<ToolTurnsObservation>): string[] {
  const reasons: string[] = [];
  if (o.toolTurns !== TOOL_TURN_TARGET) {
    reasons.push(
      `expected ${TOOL_TURN_TARGET} tool turns, saw ${o.toolTurns ?? "none"}`,
    );
  }
  if (o.allToolTurnsOneUpstream !== true) {
    reasons.push("a tool turn did not make exactly one upstream request");
  }
  if (o.rejectedExtraRequests !== 0) {
    reasons.push(
      `relay rejected ${o.rejectedExtraRequests ?? "an unknown number of"} extra requests`,
    );
  }
  if (o.claudeCodeToolExecutions !== 0) {
    reasons.push(
      `Claude Code executed ${o.claudeCodeToolExecutions ?? "an unknown number of"} tools`,
    );
  }
  if (o.finalTurnUpstream !== undefined && o.finalTurnUpstream !== 1) {
    reasons.push(
      `final turn made ${o.finalTurnUpstream} upstream requests, expected 1`,
    );
  }
  if (!/finished/i.test(text(o.finalText))) {
    reasons.push('final text turn did not say "finished"');
  }
  return reasons;
}

function checkCompaction(o: Partial<CompactionObservation>): string[] {
  const reasons: string[] = [];
  if (o.compacted !== true) reasons.push("history was not compacted");
  const facts = Array.isArray(o.seededFacts) ? o.seededFacts : [];
  if (!facts.length) reasons.push("no facts were seeded before compaction");
  for (const fact of facts) {
    if (!text(o.finalText).includes(fact)) {
      reasons.push(`post-compaction answer is missing ${fact}`);
    }
  }
  if (o.allOneUpstream === false) {
    reasons.push("a turn did not make exactly one upstream request");
  }
  if (o.rejectedExtraRequests !== undefined && o.rejectedExtraRequests !== 0) {
    reasons.push(`relay rejected ${o.rejectedExtraRequests} extra requests`);
  }
  return reasons;
}

function checkReplay(o: Partial<ReplayObservation>): string[] {
  const reasons: string[] = [];
  const code = text(o.codeFromFirstContainer);
  if (!code) {
    reasons.push("the first container issued no code");
  } else if (!text(o.finalText).includes(code)) {
    reasons.push(`final answer is missing ${code}`);
  }
  if (o.allOneUpstream !== true) {
    reasons.push("a turn did not make exactly one upstream request");
  }
  if (o.rejectedExtraRequests !== 0) {
    reasons.push(
      `relay rejected ${o.rejectedExtraRequests ?? "an unknown number of"} extra requests`,
    );
  }
  if (o.freshCliState === false) {
    reasons.push(
      "the second container held CLI state before its first request",
    );
  }
  return reasons;
}

const CHECKS: Record<ScenarioId, (observed: any) => string[]> = {
  "tool-turns-50": checkToolTurns,
  "compaction-continuation": checkCompaction,
  "fresh-container-replay": checkReplay,
};

export function isScenarioId(id: string): id is ScenarioId {
  return (SCENARIO_IDS as readonly string[]).includes(id);
}

/** Deterministic pass/fail for one scenario's observations. */
export function evaluateScenario(
  id: string,
  observed: object,
): ScenarioEvaluation {
  if (!isScenarioId(id)) throw new Error(`Unknown acceptance scenario "${id}"`);
  const reasons = CHECKS[id](observed ?? {});
  return {
    scenario: id,
    outcome: reasons.length ? "failed" : "passed",
    reasons,
  };
}

// Run records ----------------------------------------------------------------

export const VERSION_KEYS = [
  "node",
  "pi",
  "piCodingAgent",
  "claudeCli",
  "extension",
] as const;
export type Versions = Record<(typeof VERSION_KEYS)[number], string>;

export type ConfigValue = string | number | boolean | null;

export interface RunRecord {
  schemaVersion: 1;
  runId: string;
  campaignId: string;
  startedAt: string;
  host: {
    platform: string;
    arch?: string;
    release?: string;
    container?: boolean;
  };
  versions: Versions;
  model: { requested: string; resolvedId: string };
  scenario: { id: ScenarioId; fixtureId: string };
  config: Record<string, ConfigValue>;
  approvalRef: string;
  /** Approved scope, limits and stop conditions, as recorded before the run. */
  approval?: Approval;
  outcome: "passed" | "failed";
  reasons?: string[];
  stoppedBy?: string;
  durationMs: number;
  usage: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  cancellation: { checked: boolean; outcome: string; trigger?: string };
  cleanup: {
    strayProcesses: number;
    leftoverTempEntries: string[];
    hostCredentialsUnchanged?: boolean;
  };
}

export type RunRecordInput = Omit<
  RunRecord,
  "schemaVersion" | "scenario" | "approval"
> & {
  scenario: { id: string; fixtureId: string };
  approval?: Approval;
};

function required(value: unknown, field: string): string {
  if (!isText(value)) throw new Error(`Run record needs ${field}`);
  return value;
}

function count(value: unknown, field: string): number {
  if (!isCount(value)) throw new Error(`Run record needs a count for ${field}`);
  return value;
}

/**
 * Build a run record from an allow-list of fields. Anything else, such as
 * transcripts, messages, tokens, credentials or environment, is dropped.
 */
export function buildRunRecord(input: RunRecordInput): RunRecord {
  const host = input.host ?? ({} as RunRecordInput["host"]);
  const versions = {} as Versions;
  for (const key of VERSION_KEYS) {
    versions[key] = required(input.versions?.[key], `versions.${key}`);
  }
  const scenarioId = required(input.scenario?.id, "scenario.id");
  if (!isScenarioId(scenarioId)) {
    throw new Error(`Unknown acceptance scenario "${scenarioId}"`);
  }
  if (input.outcome !== "passed" && input.outcome !== "failed") {
    throw new Error("Run record outcome must be passed or failed");
  }

  const config: Record<string, ConfigValue> = {};
  for (const [key, value] of Object.entries(input.config ?? {})) {
    if (
      value === null ||
      ["string", "number", "boolean"].includes(typeof value)
    ) {
      config[key] = value;
    }
  }

  const usage: RunRecord["usage"] = {
    requests: count(input.usage?.requests, "usage.requests"),
    inputTokens: count(input.usage?.inputTokens, "usage.inputTokens"),
    outputTokens: count(input.usage?.outputTokens, "usage.outputTokens"),
  };
  if (input.usage?.cacheReadTokens !== undefined) {
    usage.cacheReadTokens = count(
      input.usage.cacheReadTokens,
      "usage.cacheReadTokens",
    );
  }
  if (input.usage?.cacheWriteTokens !== undefined) {
    usage.cacheWriteTokens = count(
      input.usage.cacheWriteTokens,
      "usage.cacheWriteTokens",
    );
  }

  const cancellation = input.cancellation;
  if (!cancellation || typeof cancellation.checked !== "boolean") {
    throw new Error("Run record needs cancellation.checked");
  }
  const cleanup = input.cleanup;
  if (!cleanup || !Array.isArray(cleanup.leftoverTempEntries)) {
    throw new Error("Run record needs cleanup.leftoverTempEntries");
  }

  const approvalRef = required(input.approvalRef, "approvalRef");
  if (input.approval && input.approval.ref !== approvalRef) {
    throw new Error("Run record approval does not match approvalRef");
  }

  return {
    schemaVersion: 1,
    runId: required(input.runId, "runId"),
    campaignId: required(input.campaignId, "campaignId"),
    startedAt: required(input.startedAt, "startedAt"),
    host: {
      platform: required(host.platform, "host.platform"),
      ...(isText(host.arch) ? { arch: host.arch } : {}),
      ...(isText(host.release) ? { release: host.release } : {}),
      ...(typeof host.container === "boolean"
        ? { container: host.container }
        : {}),
    },
    versions,
    model: {
      requested: required(input.model?.requested, "model.requested"),
      resolvedId: required(input.model?.resolvedId, "model.resolvedId"),
    },
    scenario: {
      id: scenarioId,
      fixtureId: required(input.scenario.fixtureId, "scenario.fixtureId"),
    },
    config,
    approvalRef,
    ...(input.approval
      ? {
          approval: {
            ref: input.approval.ref,
            ...(isText(input.approval.approvedBy)
              ? { approvedBy: input.approval.approvedBy }
              : {}),
            scope: {
              hosts: [...input.approval.scope.hosts],
              models: [...input.approval.scope.models],
              scenarios: [...input.approval.scope.scenarios],
            },
            limits: {
              maxRequests: input.approval.limits.maxRequests,
              maxTokens: input.approval.limits.maxTokens,
              maxSeconds: input.approval.limits.maxSeconds,
            },
            stopConditions: [...input.approval.stopConditions],
          },
        }
      : {}),
    outcome: input.outcome,
    ...(Array.isArray(input.reasons)
      ? { reasons: input.reasons.filter(isText) }
      : {}),
    ...(isText(input.stoppedBy) ? { stoppedBy: input.stoppedBy } : {}),
    durationMs: count(input.durationMs, "durationMs"),
    usage,
    cancellation: {
      checked: cancellation.checked,
      outcome: required(cancellation.outcome, "cancellation.outcome"),
      ...(isText(cancellation.trigger)
        ? { trigger: cancellation.trigger }
        : {}),
    },
    cleanup: {
      strayProcesses: count(cleanup.strayProcesses, "cleanup.strayProcesses"),
      leftoverTempEntries: cleanup.leftoverTempEntries.filter(isText),
      ...(typeof cleanup.hostCredentialsUnchanged === "boolean"
        ? { hostCredentialsUnchanged: cleanup.hostCredentialsUnchanged }
        : {}),
    },
  };
}

// Aggregation ----------------------------------------------------------------

export interface EvidenceTarget {
  /** Campaign whose matching runs count as fresh; null when none is approved. */
  campaignId: string | null;
  /** Compared key by key. Keys left out here are recorded but not compared. */
  versions: Partial<Versions>;
  config: Record<string, ConfigValue>;
  fixtures: Partial<Record<string, string>>;
}

export interface EvidenceMatrix {
  hosts: string[];
  models: string[];
  scenarios: string[];
}

export type EvidenceStatus = "fresh" | "reused" | "historical" | "untested";

export interface Difference {
  key: string;
  expected: ConfigValue | undefined;
  actual: ConfigValue | undefined;
}

export interface EvidenceCell {
  host: string;
  model: string;
  scenario: string;
  status: EvidenceStatus;
  outcome: "passed" | "failed" | "untested";
  runId?: string;
  campaignId?: string;
  startedAt?: string;
  runIds?: string[];
  versions?: Versions;
  differences?: Difference[];
}

export interface EvidenceReport {
  target: EvidenceTarget;
  matrix: EvidenceMatrix;
  cells: EvidenceCell[];
}

function differencesFrom(
  record: RunRecord,
  target: EvidenceTarget,
  scenario: string,
): Difference[] {
  const out: Difference[] = [];
  for (const [key, expected] of Object.entries(target.versions)) {
    const actual = record.versions[key as keyof Versions];
    if (actual !== expected) {
      out.push({ key: `versions.${key}`, expected, actual });
    }
  }
  const configKeys = new Set([
    ...Object.keys(target.config),
    ...Object.keys(record.config),
  ]);
  for (const key of configKeys) {
    if (target.config[key] !== record.config[key]) {
      out.push({
        key: `config.${key}`,
        expected: target.config[key],
        actual: record.config[key],
      });
    }
  }
  if (target.fixtures[scenario] !== record.scenario.fixtureId) {
    out.push({
      key: "scenario.fixtureId",
      expected: target.fixtures[scenario],
      actual: record.scenario.fixtureId,
    });
  }
  return out;
}

const newestFirst = (a: RunRecord, b: RunRecord) =>
  b.startedAt.localeCompare(a.startedAt);

/**
 * One cell per host × model × scenario. Only a run of that exact host,
 * model and scenario can fill a cell. Comparable runs (same versions,
 * config and fixture) are fresh in the target campaign and reused from
 * others; anything else is historical with its differences; no run means
 * untested. Within the chosen class a failed run outweighs a passed one.
 */
export function aggregateEvidence(
  records: readonly RunRecord[],
  target: EvidenceTarget,
  matrix: EvidenceMatrix,
): EvidenceReport {
  const cells: EvidenceCell[] = [];
  for (const host of matrix.hosts) {
    for (const model of matrix.models) {
      for (const scenario of matrix.scenarios) {
        const runs = records
          .filter(
            (r) =>
              r.host.platform === host &&
              r.model.resolvedId === model &&
              r.scenario.id === scenario,
          )
          .map((record) => ({
            record,
            differences: differencesFrom(record, target, scenario),
          }));
        const fresh = runs.filter(
          (r) =>
            !r.differences.length && r.record.campaignId === target.campaignId,
        );
        const reused = runs.filter(
          (r) =>
            !r.differences.length && r.record.campaignId !== target.campaignId,
        );
        const [status, chosen] = (
          [
            ["fresh", fresh],
            ["reused", reused],
            ["historical", runs],
          ] as const
        ).find(([, list]) => list.length) ?? ["untested", []];

        if (!chosen.length) {
          cells.push({
            host,
            model,
            scenario,
            status: "untested",
            outcome: "untested",
          });
          continue;
        }
        const ordered = chosen.map((r) => r.record).sort(newestFirst);
        const pick =
          status === "historical"
            ? ordered[0]
            : (ordered.find((r) => r.outcome === "failed") ?? ordered[0]);
        const cell: EvidenceCell = {
          host,
          model,
          scenario,
          status,
          outcome: pick.outcome,
          runId: pick.runId,
          campaignId: pick.campaignId,
          startedAt: pick.startedAt,
          runIds: ordered.map((r) => r.runId),
          versions: pick.versions,
        };
        if (status === "historical") {
          cell.differences = chosen.find((r) => r.record === pick)!.differences;
        }
        cells.push(cell);
      }
    }
  }
  return { target, matrix, cells };
}

// Notes ----------------------------------------------------------------------

const SECTIONS: { status: EvidenceStatus; heading: string; about: string }[] = [
  {
    status: "fresh",
    heading: "Fresh",
    about:
      "Runs from the target campaign that match the target versions, configuration and fixture.",
  },
  {
    status: "reused",
    heading: "Reused",
    about:
      "Runs from an earlier campaign that still match the target versions, configuration and fixture.",
  },
  {
    status: "historical",
    heading: "Historical",
    about:
      "Runs whose versions, configuration or fixture differ from the target. They do not count as acceptance.",
  },
  {
    status: "untested",
    heading: "Untested",
    about: "No run record exists for these cells.",
  },
];

const show = (value: ConfigValue | undefined) =>
  value === undefined ? "unset" : String(value);

function row(cell: EvidenceCell): string {
  const base = [cell.host, `\`${cell.model}\``, cell.scenario];
  if (cell.status === "untested") return `| ${base.join(" | ")} |`;
  const extra = [
    cell.outcome,
    `\`${cell.runId}\``,
    `\`${cell.campaignId}\``,
    cell.startedAt ?? "",
  ];
  if (cell.status === "historical") {
    extra.push(
      (cell.differences ?? [])
        .map((d) => `${d.key}: ${show(d.actual)} (target ${show(d.expected)})`)
        .join("; "),
    );
  }
  return `| ${[...base, ...extra].join(" | ")} |`;
}

/** Markdown notes with fresh, reused, historical and untested evidence apart. */
export function renderAcceptanceNotes(report: EvidenceReport): string {
  const { target } = report;
  const pairs = (obj: Record<string, unknown>) =>
    Object.entries(obj)
      .map(([key, value]) => `${key} \`${String(value)}\``)
      .join(", ") || "none";
  const lines = [
    "# Acceptance evidence",
    "",
    "Generated from structured run records by `scripts/acceptance/notes.ts`. Do not edit by hand.",
    "",
    `- Target campaign: ${target.campaignId ? `\`${target.campaignId}\`` : "none approved"}`,
    `- Target versions: ${pairs(target.versions)}`,
    `- Target configuration: ${pairs(target.config)}`,
    `- Target fixtures: ${pairs(target.fixtures)}`,
    "",
  ];
  for (const section of SECTIONS) {
    const cells = report.cells.filter((c) => c.status === section.status);
    lines.push(`## ${section.heading}`, "", section.about, "");
    if (!cells.length) {
      lines.push("None.", "");
      continue;
    }
    if (section.status === "untested") {
      lines.push("| Host | Model | Scenario |", "| --- | --- | --- |");
    } else if (section.status === "historical") {
      lines.push(
        "| Host | Model | Scenario | Outcome | Run | Campaign | Started | Differences |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
      );
    } else {
      lines.push(
        "| Host | Model | Scenario | Outcome | Run | Campaign | Started |",
        "| --- | --- | --- | --- | --- | --- | --- |",
      );
    }
    lines.push(...cells.map(row), "");
  }
  return lines.join("\n");
}
