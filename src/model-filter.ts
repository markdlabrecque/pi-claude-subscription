/**
 * Catalog filtering: keep only the latest version of each Claude model family.
 *
 * The pi-ai anthropic catalog accumulates every released model (dated and
 * alias variants). pi-claude-subscription only surfaces the current version
 * of each family (e.g. the newest opus, sonnet, haiku, and fable).
 */

const FAMILIES = ["opus", "sonnet", "haiku", "fable"] as const;

/** Family a model id belongs to, or null if the id matches no known family. */
function modelFamily(id: string): string | null {
  const lower = id.toLowerCase();
  return FAMILIES.find((family) => lower.includes(family)) ?? null;
}

/** Numeric version components of a model id, with family and date stripped. */
function versionParts(id: string, family: string): number[] {
  const base = id
    .toLowerCase()
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "");
  return base
    .split("-")
    .filter((part) => part !== family)
    .map(Number)
    .filter((n) => Number.isInteger(n));
}

/** Trailing -YYYYMMDD date stamp, or 0 for undated (alias) ids. */
function dateStamp(id: string): number {
  const match = /-(\d{8})$/.exec(id);
  return match ? Number(match[1]) : 0;
}

/** Element-wise version compare; missing components count as 0, so [5] < [5,1]. */
function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * When two ids share a version, prefer the undated alias (the id the CLI
 * resolves to the newest release), then the most recent date stamp.
 */
function sameVersionPreferred(
  incoming: { id: string },
  current: { id: string },
): boolean {
  const dIn = dateStamp(incoming.id);
  const dCur = dateStamp(current.id);
  if (dCur === 0 && dIn > 0) return false; // current is the alias
  if (dCur > 0 && dIn === 0) return true; // incoming is the alias
  if (dIn > 0 && dCur > 0) return dIn > dCur; // newer date wins
  return false; // both undated: keep whichever came first
}

/**
 * Reduce a model list to the latest version of each family. Models whose id
 * matches no known family are kept as-is (unknown shapes are not filtered).
 */
export function filterLatestPerFamily<T extends { id: string }>(
  models: T[],
): T[] {
  const latest = new Map<string, T>();
  for (const model of models) {
    const family = modelFamily(model.id);
    if (!family) continue;
    const current = latest.get(family);
    if (current) {
      const cmp = compareVersions(
        versionParts(model.id, family),
        versionParts(current.id, family),
      );
      const replace =
        cmp > 0 || (cmp === 0 && sameVersionPreferred(model, current));
      if (!replace) continue;
    }
    latest.set(family, model);
  }
  const keep = new Set(latest.values().map((m) => m.id));
  return models.filter((m) => keep.has(m.id) || !modelFamily(m.id));
}
