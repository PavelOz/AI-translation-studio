/**
 * Project + document DNA merge for runtime "effective" payloads.
 * Document layer wins on key conflicts; plain objects are deep-merged field-by-field.
 */

import type { DocumentDnaPayload, ValidationHints } from '../ai/types';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep-merge maps: override wins per key; nested plain objects recurse. */
function deepMergeRecords(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    const existing = out[k];
    if (isPlainObject(v) && isPlainObject(existing)) {
      out[k] = deepMergeRecords(existing, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Merge one DNA section. Document null/undefined => inherit project only.
 * Non-object document value => document replaces project for that section.
 */
function mergeSection(projectVal: unknown, documentVal: unknown): unknown {
  if (documentVal === undefined || documentVal === null) {
    return projectVal === undefined ? undefined : projectVal;
  }
  if (!isPlainObject(documentVal)) {
    return documentVal;
  }
  if (!isPlainObject(projectVal)) {
    return documentVal;
  }
  return deepMergeRecords(projectVal, documentVal);
}

function ruleKey(r: { term?: string; rule?: string }): string {
  return `${r.term ?? ''}\0${r.rule ?? ''}`;
}

function warningKey(w: { term?: string; message?: string }): string {
  return `${w.term ?? ''}\0${w.message ?? ''}`;
}

/** Combine validation hints: rules/warnings deduped; notes union. */
function mergeValidationHints(
  projectHints: ValidationHints | null | undefined,
  documentHints: ValidationHints | null | undefined,
): ValidationHints | undefined {
  if (!projectHints && !documentHints) return undefined;
  if (!projectHints) return documentHints ?? undefined;
  if (!documentHints) return projectHints ?? undefined;

  const p = projectHints;
  const d = documentHints;
  const rulesSeen = new Set<string>();
  const rules = [...(p.rules ?? []), ...(d.rules ?? [])].filter((r) => {
    const k = ruleKey(r);
    if (rulesSeen.has(k)) return false;
    rulesSeen.add(k);
    return true;
  });
  const warningsSeen = new Set<string>();
  const warnings = [...(p.warnings ?? []), ...(d.warnings ?? [])].filter((w) => {
    const k = warningKey(w);
    if (warningsSeen.has(k)) return false;
    warningsSeen.add(k);
    return true;
  });
  const notesSet = new Set([...(p.notes ?? []), ...(d.notes ?? [])]);
  const notes = notesSet.size > 0 ? Array.from(notesSet) : undefined;
  const out: NonNullable<ValidationHints> = {};
  if (rules.length) out.rules = rules;
  if (warnings.length) out.warnings = warnings;
  if (notes) out.notes = notes;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Merge project-level DNA defaults with document-level DNA (document overrides).
 */
export function mergeDna(
  projectLayer: DocumentDnaPayload | null | undefined,
  documentLayer: DocumentDnaPayload | null | undefined,
): DocumentDnaPayload | null {
  if (!projectLayer && !documentLayer) return null;
  if (!projectLayer) return documentLayer ? { ...documentLayer } : null;
  if (!documentLayer) return { ...projectLayer };

  const merged: DocumentDnaPayload = {};

  const ts = mergeSection(projectLayer.technicalSchema, documentLayer.technicalSchema);
  if (ts !== undefined) merged.technicalSchema = ts as Record<string, unknown> | null;

  const nc = mergeSection(projectLayer.namingConventions, documentLayer.namingConventions);
  if (nc !== undefined) merged.namingConventions = nc as Record<string, unknown> | null;

  const ab = mergeSection(projectLayer.abbreviationLogic, documentLayer.abbreviationLogic);
  if (ab !== undefined) merged.abbreviationLogic = ab as Record<string, unknown> | null;

  const eg = mergeSection(projectLayer.entityGroups, documentLayer.entityGroups);
  if (eg !== undefined) merged.entityGroups = eg as Record<string, unknown> | null;

  const vh = mergeValidationHints(projectLayer.validationHints, documentLayer.validationHints);
  if (vh !== undefined) merged.validationHints = vh;

  return Object.keys(merged).length > 0 ? merged : null;
}

/** Map Prisma JSON row (document or project DNA) to payload shape. */
export function prismaDnaRowToPayload(row: {
  technicalSchema?: unknown;
  namingConventions?: unknown;
  abbreviationLogic?: unknown;
  entityGroups?: unknown;
} | null | undefined): DocumentDnaPayload | null {
  if (!row) return null;
  return {
    technicalSchema: row.technicalSchema as Record<string, unknown> | null | undefined,
    namingConventions: row.namingConventions as Record<string, unknown> | null | undefined,
    abbreviationLogic: row.abbreviationLogic as Record<string, unknown> | null | undefined,
    entityGroups: row.entityGroups as Record<string, unknown> | null | undefined,
  };
}
