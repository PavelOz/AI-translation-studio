import type { Segment } from '../api/segments.api';

/** User-visible TM % for badges and “applied TM” card (handles auto-propagate fuzzyScore offsets). */
export function getSegmentTmDisplayScore(segment: Segment): number | null {
  if (segment.fuzzyScore == null || segment.fuzzyScore === undefined) return null;
  const isAutoPropagated =
    segment._meta?.autoPropagated ??
    (typeof segment.fuzzyScore === 'number' && segment.fuzzyScore >= 1000);
  const withNumberReplacement =
    segment._meta?.differsOnlyByNumbers ?? (typeof segment.fuzzyScore === 'number' && segment.fuzzyScore >= 2000);
  if (isAutoPropagated) {
    return withNumberReplacement ? segment.fuzzyScore - 2000 : segment.fuzzyScore - 1000;
  }
  return segment.fuzzyScore;
}
