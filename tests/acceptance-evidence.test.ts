import { describe, expect, it } from "vitest";
import {
  aggregateEvidence,
  assertApproved,
  assertLocalExecution,
  buildRunRecord,
  evaluateScenario,
  renderAcceptanceNotes,
  resolveRequestedModels,
} from "../scripts/acceptance/evidence";

const approval = {
  ref: "issue-79#approval-1",
  approvedBy: "maintainer",
  scope: {
    hosts: ["linux"],
    models: ["claude-haiku-5-5"],
    scenarios: ["tool-turns-50"],
  },
  limits: { maxRequests: 60, maxTokens: 200_000, maxSeconds: 1800 },
  stopConditions: ["first failed scenario", "any 429 response"],
};

const versions = {
  node: "22.19.0",
  pi: "1.4.0",
  piCodingAgent: "1.4.0",
  claudeCli: "3.0.0",
  extension: "1.4.0",
};
const config = { sessionMode: "replay", apiFallback: false };

const baseRun = {
  runId: "run-1",
  campaignId: "c1",
  startedAt: "2026-11-04T10:00:00Z",
  host: { platform: "linux", arch: "x64" },
  versions,
  model: { requested: "claude-haiku-5-5", resolvedId: "claude-haiku-5-5" },
  scenario: { id: "tool-turns-50", fixtureId: "turns-v1" },
  config,
  approvalRef: approval.ref,
  outcome: "passed" as const,
  durationMs: 1234,
  usage: { requests: 51, inputTokens: 1000, outputTokens: 500 },
  cancellation: { checked: true, outcome: "clean" },
  cleanup: { strayProcesses: 0, leftoverTempEntries: [] as string[] },
};

describe("approval gate", () => {
  it("refuses live execution without an approval", () => {
    expect(() =>
      assertApproved(undefined, {
        host: "linux",
        model: "claude-haiku-5-5",
        scenario: "tool-turns-50",
      }),
    ).toThrow(/approval/i);
  });

  it("refuses approvals missing a reference, limits or stop conditions", () => {
    const request = {
      host: "linux",
      model: "claude-haiku-5-5",
      scenario: "tool-turns-50",
    };
    expect(() => assertApproved({ ...approval, ref: "" }, request)).toThrow();
    expect(() =>
      assertApproved({ ...approval, limits: undefined } as any, request),
    ).toThrow();
    expect(() =>
      assertApproved({ ...approval, stopConditions: [] }, request),
    ).toThrow();
  });

  it("refuses runs outside the approved scope", () => {
    for (const request of [
      { host: "darwin", model: "claude-haiku-5-5", scenario: "tool-turns-50" },
      { host: "linux", model: "claude-opus-5-5", scenario: "tool-turns-50" },
      { host: "linux", model: "claude-haiku-5-5", scenario: "fresh-container" },
    ]) {
      expect(() => assertApproved(approval, request)).toThrow(/scope/i);
    }
  });

  it("returns the approved scope and limits to record before execution", () => {
    const recorded = assertApproved(approval, {
      host: "linux",
      model: "claude-haiku-5-5",
      scenario: "tool-turns-50",
    });
    expect(recorded).toMatchObject({
      ref: approval.ref,
      scope: approval.scope,
      limits: approval.limits,
      stopConditions: approval.stopConditions,
    });
  });

  it("never executes live requests in CI", () => {
    expect(() => assertLocalExecution({ CI: "true" })).toThrow(/CI/);
    expect(() => assertLocalExecution({ GITHUB_ACTIONS: "true" })).toThrow();
    expect(() => assertLocalExecution({})).not.toThrow();
  });
});

describe("model availability", () => {
  it("records unavailable models as untested instead of substituting", () => {
    const result = resolveRequestedModels(
      ["claude-opus-5-5", "claude-fable-5-1", "claude-haiku-5-5"],
      ["claude-haiku-5-5", "claude-sonnet-5-5"],
    );
    expect(result).toEqual([
      { requested: "claude-opus-5-5", status: "untested", resolvedId: null },
      { requested: "claude-fable-5-1", status: "untested", resolvedId: null },
      {
        requested: "claude-haiku-5-5",
        status: "available",
        resolvedId: "claude-haiku-5-5",
      },
    ]);
  });
});

describe("synthetic scenarios have deterministic assertions", () => {
  it("50-tool-turn: passes only with 50 tool turns, one upstream each, no CLI-side tools", () => {
    const good = {
      toolTurns: 50,
      allToolTurnsOneUpstream: true,
      rejectedExtraRequests: 0,
      claudeCodeToolExecutions: 0,
      finalText: "finished",
    };
    expect(evaluateScenario("tool-turns-50", good).outcome).toBe("passed");
    for (const bad of [
      { ...good, toolTurns: 49 },
      { ...good, allToolTurnsOneUpstream: false },
      { ...good, rejectedExtraRequests: 1 },
      { ...good, claudeCodeToolExecutions: 1 },
      { ...good, finalText: "" },
    ]) {
      expect(evaluateScenario("tool-turns-50", bad).outcome).toBe("failed");
    }
  });

  it("compaction: requires every seeded fact in the post-compaction answer", () => {
    const facts = ["ALPHA-7Q2", "BETA-9X1"];
    const ok = evaluateScenario("compaction-continuation", {
      seededFacts: facts,
      finalText: "Codes: ALPHA-7Q2 and BETA-9X1",
      compacted: true,
    });
    expect(ok.outcome).toBe("passed");
    const missing = evaluateScenario("compaction-continuation", {
      seededFacts: facts,
      finalText: "Codes: ALPHA-7Q2",
      compacted: true,
    });
    expect(missing.outcome).toBe("failed");
    expect(JSON.stringify(missing.reasons)).toContain("BETA-9X1");
    const notCompacted = evaluateScenario("compaction-continuation", {
      seededFacts: facts,
      finalText: "ALPHA-7Q2 BETA-9X1",
      compacted: false,
    });
    expect(notCompacted.outcome).toBe("failed");
  });

  it("fresh-container replay: the code exists only in carried history", () => {
    const base = {
      codeFromFirstContainer: "ALPHA-ABC123",
      finalText: "alpha is ALPHA-ABC123",
      allOneUpstream: true,
      rejectedExtraRequests: 0,
    };
    expect(evaluateScenario("fresh-container-replay", base).outcome).toBe(
      "passed",
    );
    expect(
      evaluateScenario("fresh-container-replay", {
        ...base,
        finalText: "I don't know",
      }).outcome,
    ).toBe("failed");
  });

  it("rejects unknown scenario ids", () => {
    expect(() => evaluateScenario("nope", {})).toThrow(/scenario/i);
  });
});

describe("run records", () => {
  it("keeps the required fields and drops credentials and transcripts", () => {
    const record = buildRunRecord({
      ...baseRun,
      transcript: [{ role: "user", content: "private text" }],
      messages: ["private"],
      token: "sk-ant-secret",
      credentials: { accessToken: "secret" },
      env: { ANTHROPIC_API_KEY: "sk-ant-secret" },
    } as any);
    expect(record).toMatchObject({
      host: baseRun.host,
      versions,
      model: baseRun.model,
      scenario: baseRun.scenario,
      config,
      outcome: "passed",
      durationMs: 1234,
      usage: baseRun.usage,
      approvalRef: approval.ref,
      cancellation: baseRun.cancellation,
      cleanup: baseRun.cleanup,
    });
    const text = JSON.stringify(record);
    expect(text).not.toContain("private");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("sk-ant");
  });

  it("refuses records without an approval reference or exact identifiers", () => {
    expect(() =>
      buildRunRecord({ ...baseRun, approvalRef: "" } as any),
    ).toThrow();
    expect(() =>
      buildRunRecord({
        ...baseRun,
        versions: { ...versions, claudeCli: "" },
      } as any),
    ).toThrow();
    expect(() =>
      buildRunRecord({
        ...baseRun,
        model: { requested: "x", resolvedId: "" },
      } as any),
    ).toThrow();
  });
});

describe("aggregation", () => {
  const target = {
    campaignId: "c2",
    versions,
    config,
    fixtures: { "tool-turns-50": "turns-v1" },
  };
  const matrix = {
    hosts: ["linux", "darwin"],
    models: ["claude-haiku-5-5", "claude-opus-5-5"],
    scenarios: ["tool-turns-50"],
  };
  const cell = (report: any, host: string, model: string) =>
    report.cells.find(
      (c: any) =>
        c.host === host && c.model === model && c.scenario === "tool-turns-50",
    );

  it("classifies fresh, reused, historical and untested per matrix cell", () => {
    const fresh = buildRunRecord({
      ...baseRun,
      runId: "r-fresh",
      campaignId: "c2",
    });
    const reused = buildRunRecord({
      ...baseRun,
      runId: "r-reused",
      campaignId: "c1",
      host: { platform: "darwin", arch: "arm64" },
    });
    const historical = buildRunRecord({
      ...baseRun,
      runId: "r-old",
      campaignId: "c0",
      model: { requested: "claude-opus-5-5", resolvedId: "claude-opus-5-5" },
      versions: { ...versions, pi: "0.9.0" },
    });
    const report = aggregateEvidence(
      [fresh, reused, historical],
      target,
      matrix,
    );

    expect(cell(report, "linux", "claude-haiku-5-5")).toMatchObject({
      status: "fresh",
      outcome: "passed",
      runId: "r-fresh",
    });
    expect(cell(report, "darwin", "claude-haiku-5-5")).toMatchObject({
      status: "reused",
      runId: "r-reused",
    });
    const old = cell(report, "linux", "claude-opus-5-5");
    expect(old.status).toBe("historical");
    expect(JSON.stringify(old.differences)).toContain("pi");
    expect(cell(report, "darwin", "claude-opus-5-5").status).toBe("untested");
  });

  it("does not treat a different config or fixture as comparable", () => {
    const otherConfig = buildRunRecord({
      ...baseRun,
      campaignId: "c2",
      config: { sessionMode: "resume", apiFallback: false },
    });
    const otherFixture = buildRunRecord({
      ...baseRun,
      campaignId: "c2",
      host: { platform: "darwin", arch: "arm64" },
      scenario: { id: "tool-turns-50", fixtureId: "turns-v0" },
    });
    const report = aggregateEvidence(
      [otherConfig, otherFixture],
      target,
      matrix,
    );
    expect(cell(report, "linux", "claude-haiku-5-5").status).toBe("historical");
    expect(cell(report, "darwin", "claude-haiku-5-5").status).toBe(
      "historical",
    );
  });

  it("keeps failed outcomes visible and never lets an unrelated pass cover a cell", () => {
    const failed = buildRunRecord({
      ...baseRun,
      campaignId: "c2",
      outcome: "failed",
    });
    const unrelatedPass = buildRunRecord({
      ...baseRun,
      runId: "r-other",
      campaignId: "c2",
      model: { requested: "claude-opus-5-5", resolvedId: "claude-opus-5-5" },
      scenario: { id: "compaction-continuation", fixtureId: "c-v1" },
    });
    const report = aggregateEvidence([failed, unrelatedPass], target, matrix);
    expect(cell(report, "linux", "claude-haiku-5-5")).toMatchObject({
      status: "fresh",
      outcome: "failed",
    });
    expect(cell(report, "linux", "claude-opus-5-5").status).toBe("untested");
    expect(report.cells).toHaveLength(4);
  });
});

describe("acceptance notes", () => {
  it("separates fresh, reused, historical and untested evidence", () => {
    const target = {
      campaignId: "c2",
      versions,
      config,
      fixtures: { "tool-turns-50": "turns-v1" },
    };
    const report = aggregateEvidence(
      [buildRunRecord({ ...baseRun, campaignId: "c2" })],
      target,
      {
        hosts: ["linux", "darwin"],
        models: ["claude-haiku-5-5"],
        scenarios: ["tool-turns-50"],
      },
    );
    const notes = renderAcceptanceNotes(report);
    for (const heading of ["Fresh", "Reused", "Historical", "Untested"]) {
      expect(notes).toMatch(new RegExp(`^#+ ${heading}`, "m"));
    }
    const fresh = notes.split(/^#+ Reused/m)[0];
    expect(fresh).toContain("claude-haiku-5-5");
    expect(fresh).toContain("linux");
    const untested = notes.split(/^#+ Untested/m)[1];
    expect(untested).toContain("darwin");
    expect(untested).not.toContain("linux");
  });
});
