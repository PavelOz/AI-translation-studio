/**
 * Document DNA payload validation. Used before translation to fail fast on invalid DNA.
 * DNA is validated at translation start (pretranslate and single-segment AI path); invalid DNA
 * blocks batch translation and returns 400 for single-segment. First mention vs subsequent
 * use of abbreviations is enforced via session state (introducedAbbreviations) and filtered
 * context in the orchestrator (filterAbbreviationLogicForExpandedTerms).
 */

import { normalizeDnaKey } from './dnaKeys';

/** Payload shape for validation; accepts both ai/types and analysis.service DNA shapes. */
type DnaPayloadForValidation = {
  technicalSchema?: Record<string, unknown> | null;
  namingConventions?: Record<string, unknown> | null;
  abbreviationLogic?: Record<string, unknown> | null;
  entityGroups?: Record<string, unknown> | null;
} | null;

/** Get the string used as value (longForm + shortForm) for recursion check. */
function getEntryValueString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return '';
  const o = value as Record<string, unknown>;
  const long = typeof o.longForm === 'string' ? o.longForm : '';
  const short = typeof o.shortForm === 'string' ? o.shortForm : '';
  const val = typeof o.value === 'string' ? o.value : '';
  return [long, short, val].filter(Boolean).join(' ');
}

const MAX_KEY_LENGTH = 500;
const MAX_VALUE_LENGTH = 2000;

function isAbbreviationLogicValue(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.length <= MAX_VALUE_LENGTH;
  if (typeof v === 'object' && v !== null && 'value' in v) {
    const o = v as { value: unknown; aliases?: unknown };
    if (typeof o.value !== 'string' || o.value.length > MAX_VALUE_LENGTH) return false;
    if (Array.isArray(o.aliases)) {
      for (const a of o.aliases) {
        if (a != null && typeof a !== 'string') return false;
        if (typeof a === 'string' && a.length > MAX_KEY_LENGTH) return false;
      }
    }
    return true;
  }
  if (typeof v === 'object' && v !== null && ('longForm' in v || 'shortForm' in v)) {
    const o = v as { longForm?: unknown; shortForm?: unknown; aliases?: unknown };
    const ok = (x: unknown) => x == null || (typeof x === 'string' && x.length <= MAX_VALUE_LENGTH);
    if (!ok(o.longForm) || !ok(o.shortForm)) return false;
    if (Array.isArray(o.aliases)) {
      for (const a of o.aliases) {
        if (a != null && typeof a !== 'string') return false;
        if (typeof a === 'string' && a.length > MAX_KEY_LENGTH) return false;
      }
    }
    return true;
  }
  return false;
}

export interface ValidateDocumentDnaResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates a Document DNA payload. Returns human-readable errors for UI or logging.
 * Rules: abbreviationLogic must be object or null; no empty string keys; values string or { value } or { longForm, shortForm }; optional max lengths.
 */
export function validateDocumentDnaPayload(dna: DnaPayloadForValidation): ValidateDocumentDnaResult {
  const errors: string[] = [];
  if (dna == null) {
    return { valid: true, errors: [] };
  }

  if (dna.abbreviationLogic != null) {
    if (typeof dna.abbreviationLogic !== 'object' || Array.isArray(dna.abbreviationLogic)) {
      errors.push('abbreviationLogic must be an object or null');
    } else {
      for (const [key, value] of Object.entries(dna.abbreviationLogic)) {
        if (key === '' || /^\s+$/.test(key)) {
          errors.push('abbreviationLogic has an empty or whitespace-only key');
        }
        if (key.length > MAX_KEY_LENGTH) {
          errors.push(`abbreviationLogic key too long (max ${MAX_KEY_LENGTH}): "${key.slice(0, 50)}..."`);
        }
        if (!isAbbreviationLogicValue(value)) {
          errors.push(`abbreviationLogic invalid value for key "${key.slice(0, 30)}..." (expected string or { value } or { longForm, shortForm })`);
        }
      }
    }
  }

  if (dna.technicalSchema != null && (typeof dna.technicalSchema !== 'object' || Array.isArray(dna.technicalSchema))) {
    errors.push('technicalSchema must be an object or null');
  }
  if (dna.namingConventions != null && (typeof dna.namingConventions !== 'object' || Array.isArray(dna.namingConventions))) {
    errors.push('namingConventions must be an object or null');
  }
  if (dna.entityGroups != null && (typeof dna.entityGroups !== 'object' || Array.isArray(dna.entityGroups))) {
    errors.push('entityGroups must be an object or null');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export interface ValidateDnaCyclesResult {
  valid: boolean;
  errors: string[];
}

/**
 * Build directed graph: key A -> keys B such that value(A) contains B as substring.
 * Used for cycle detection (e.g. EEC -> UPS, UPS -> EEC causes infinite loop).
 */
function buildAbbreviationGraph(abbreviationLogic: Record<string, unknown>): Map<string, string[]> {
  const keys = Object.keys(abbreviationLogic).filter((k) => k && !/^\s+$/.test(k));
  const graph = new Map<string, string[]>();
  for (const key of keys) {
    const value = abbreviationLogic[key];
    const valueStr = getEntryValueString(value).replace(/\s+/g, ' ').trim().toLowerCase();
    if (!valueStr) continue;
    const targets: string[] = [];
    for (const other of keys) {
      if (other === key) continue;
      const otherNorm = other.trim().toLowerCase();
      if (!otherNorm) continue;
      if (valueStr.includes(otherNorm)) targets.push(other);
    }
    if (targets.length > 0) graph.set(key, targets);
  }
  return graph;
}

/**
 * DFS to find a cycle from start. Returns cycle path [..., start] if found, else null.
 */
function findCycleInGraph(graph: Map<string, string[]>, start: string): string[] | null {
  const path: string[] = [];
  const inPath = new Set<string>();
  const visited = new Set<string>();

  function visit(node: string): string[] | null {
    if (inPath.has(node)) {
      const idx = path.indexOf(node);
      return [...path.slice(idx), node];
    }
    if (visited.has(node)) return null;
    visited.add(node);
    inPath.add(node);
    path.push(node);
    const nexts = graph.get(node) ?? [];
    for (const next of nexts) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    inPath.delete(node);
    return null;
  }

  return visit(start);
}

/**
 * Pre-flight check: (1) identity recursion (value === key);
 * (2) Cycle Guard: graph of "key -> keys that appear in value", detect cycles (e.g. EEC->UPS, UPS->EEC).
 */
export function validateDnaForCycles(dna: DnaPayloadForValidation): ValidateDnaCyclesResult {
  const errors: string[] = [];
  if (dna == null || !dna.abbreviationLogic || typeof dna.abbreviationLogic !== 'object') {
    return { valid: true, errors: [] };
  }
  const keys = Object.keys(dna.abbreviationLogic);

  for (const key of keys) {
    if (!key || /^\s+$/.test(key)) continue;
    const value = dna.abbreviationLogic[key];
    const valueStr = getEntryValueString(value).replace(/\s+/g, ' ').trim();
    if (!valueStr) continue;
    const keyTrim = key.replace(/\s+/g, ' ').trim();
    const keyNorm = normalizeDnaKey(key);
    const valueNorm = normalizeDnaKey(valueStr);
    if (keyTrim && valueStr === keyTrim) {
      errors.push(`Риск рекурсии: значение совпадает с ключом "${key.slice(0, 40)}${key.length > 40 ? '...' : ''}"`);
    } else if (keyNorm && valueNorm && keyNorm === valueNorm) {
      errors.push(`Риск рекурсии: значение совпадает с ключом "${key.slice(0, 40)}${key.length > 40 ? '...' : ''}"`);
    }
  }

  const graph = buildAbbreviationGraph(dna.abbreviationLogic);
  const seenInCycle = new Set<string>();
  for (const key of keys) {
    if (!key || seenInCycle.has(key)) continue;
    const cycle = findCycleInGraph(graph, key);
    if (cycle && cycle.length > 1) {
      const cycleStr = cycle.join(' → ');
      errors.push(`Обнаружен цикл в abbreviationLogic: ${cycleStr}`);
      cycle.forEach((n) => seenInCycle.add(n));
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
