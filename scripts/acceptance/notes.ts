/**
 * Rebuild the acceptance notes offline from saved run records (#79). Sends
 * no request, spawns no CLI and reads no credentials. Run from the repo root:
 *
 *   npx vite-node scripts/acceptance/notes.ts
 *     [--records docs/acceptance/records] [--target docs/acceptance/target.json]
 *     [--out docs/acceptance/notes.md | -]
 *
 * The matrix is both local hosts × the four requested models × the three
 * scenarios. The target file names the campaign whose runs count as fresh
 * and the versions and configuration evidence must match to be comparable.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type EvidenceTarget,
  REQUESTED_HOSTS,
  REQUESTED_MODELS,
  SCENARIO_FIXTURES,
  SCENARIO_IDS,
  aggregateEvidence,
  buildRunRecord,
  renderAcceptanceNotes,
} from "./evidence.js";

const USAGE =
  "usage: notes.ts [--records <dir>] [--target <file>] [--out <file>|-]";

const flags: Record<string, string> = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const key = argv[i]?.replace(/^--/, "");
  if (
    !argv[i]?.startsWith("--") ||
    !["records", "target", "out"].includes(key) ||
    argv[i + 1] === undefined
  ) {
    console.error(USAGE);
    process.exit(2);
  }
  flags[key] = argv[i + 1];
}

const recordsDir = flags.records ?? "docs/acceptance/records";
const targetFile = flags.target ?? "docs/acceptance/target.json";
const out = flags.out ?? "docs/acceptance/notes.md";

const declared = JSON.parse(readFileSync(targetFile, "utf-8")) as Omit<
  EvidenceTarget,
  "fixtures"
>;
const target: EvidenceTarget = {
  campaignId: declared.campaignId ?? null,
  versions: declared.versions,
  config: declared.config,
  fixtures: SCENARIO_FIXTURES,
};

// Each record goes back through the allow-list, so a hand-edited file cannot
// smuggle extra fields into the notes.
const records = existsSync(recordsDir)
  ? readdirSync(recordsDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) =>
        buildRunRecord(
          JSON.parse(readFileSync(join(recordsDir, name), "utf-8")),
        ),
      )
  : [];

const notes = renderAcceptanceNotes(
  aggregateEvidence(records, target, {
    hosts: [...REQUESTED_HOSTS],
    models: [...REQUESTED_MODELS],
    scenarios: [...SCENARIO_IDS],
  }),
);

if (out === "-") process.stdout.write(notes);
else {
  writeFileSync(out, notes);
  console.log(`${out}: ${records.length} run records`);
}
