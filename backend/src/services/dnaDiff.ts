/**
 * DNA change detection: compute delta between previous and next abbreviationLogic
 * for Smart Retranslation of Affected Segments.
 */

import type { DocumentDnaPayload } from '../ai/types';

export type DnaDelta = {
  addedKeys: string[];
  changedKeys: string[];
  removedKeys: string[];
};

function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compare prev and next DNA; return added, changed, and removed keys in abbreviationLogic.
 * Used to find which terms changed so we can retranslate only affected segments.
 */
export function computeDnaDelta(
  prev: DocumentDnaPayload | null,
  next: DocumentDnaPayload,
): DnaDelta {
  const prevKeys = prev?.abbreviationLogic && typeof prev.abbreviationLogic === 'object'
    ? Object.keys(prev.abbreviationLogic)
    : [];
  const nextKeys = next?.abbreviationLogic && typeof next.abbreviationLogic === 'object'
    ? Object.keys(next.abbreviationLogic)
    : [];
  const prevSet = new Set(prevKeys);
  const nextSet = new Set(nextKeys);

  const addedKeys = nextKeys.filter((k) => !prevSet.has(k));
  const removedKeys = prevKeys.filter((k) => !nextSet.has(k));
  const changedKeys = nextKeys.filter((k) => {
    if (prevSet.has(k) && next.abbreviationLogic && prev?.abbreviationLogic) {
      return !valueEquals(
        (prev.abbreviationLogic as Record<string, unknown>)[k],
        (next.abbreviationLogic as Record<string, unknown>)[k],
      );
    }
    return false;
  });

  return { addedKeys, changedKeys, removedKeys };
}
