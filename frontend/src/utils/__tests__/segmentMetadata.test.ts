/**
 * Тесты для парсинга метаданных сегментов
 */

import { parseMtAnalysis, mapSegmentStatus } from '../segmentMetadata';
import type { Segment } from '../../api/segments.api';
import type { JanitorStatus } from '../../api/janitor.api';

describe('parseMtAnalysis', () => {
  it('should parse auto-corrected segment with quality score', () => {
    const mtAnalysis = 'Auto-corrected: 1 attempt(s) | Quality Score: 88/100 | Errors: 0 | Warnings: 2';
    const result = parseMtAnalysis(mtAnalysis);

    expect(result.autoCorrected).toBe(true);
    expect(result.qualityScore).toBe(88);
    expect(result.correctionAttempts).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(2);
    expect(result.requiresReview).toBe(false); // 88 >= 85
  });

  it('should parse segment with low quality score requiring review', () => {
    const mtAnalysis = 'Quality Score: 72/100 | Errors: 1 | Warnings: 0 | Review: Translation quality below threshold';
    const result = parseMtAnalysis(mtAnalysis);

    expect(result.autoCorrected).toBe(false);
    expect(result.qualityScore).toBe(72);
    expect(result.errors).toBe(1);
    expect(result.warnings).toBe(0);
    expect(result.requiresReview).toBe(true); // 72 < 85
    expect(result.reasoning).toContain('Translation quality below threshold');
  });

  it('should parse auto-corrected but still requiring review', () => {
    const mtAnalysis = 'Auto-corrected but quality score 78/100 still below threshold. Requires manual review.';
    const result = parseMtAnalysis(mtAnalysis);

    expect(result.autoCorrected).toBe(true);
    expect(result.qualityScore).toBe(78);
    expect(result.requiresReview).toBe(true);
    expect(result.reasoning).toBeDefined();
  });

  it('should handle case-insensitive patterns', () => {
    const mtAnalysis = 'AUTO-CORRECTED: 2 attempts | quality score: 95/100 | ERRORS: 0';
    const result = parseMtAnalysis(mtAnalysis);

    expect(result.autoCorrected).toBe(true);
    expect(result.qualityScore).toBe(95);
    expect(result.correctionAttempts).toBe(2);
    expect(result.errors).toBe(0);
  });

  it('should handle empty or null mtAnalysis', () => {
    expect(parseMtAnalysis(null)).toEqual({
      autoCorrected: false,
      requiresReview: false,
    });
    expect(parseMtAnalysis(undefined)).toEqual({
      autoCorrected: false,
      requiresReview: false,
    });
    expect(parseMtAnalysis('')).toEqual({
      autoCorrected: false,
      requiresReview: false,
    });
  });

  it('should extract reasoning from various formats', () => {
    const testCases = [
      {
        input: 'Review: Translation quality below threshold',
        expectedReasoning: 'Translation quality below threshold',
      },
      {
        input: 'Reasoning: Missing glossary terms',
        expectedReasoning: 'Missing glossary terms',
      },
      {
        input: 'Still below threshold: Quality insufficient',
        expectedReasoning: 'Quality insufficient',
      },
    ];

    testCases.forEach(({ input, expectedReasoning }) => {
      const result = parseMtAnalysis(input);
      expect(result.reasoning).toContain(expectedReasoning);
    });
  });

  it('should handle complex mtAnalysis strings', () => {
    const complexAnalysis = `
      Auto-corrected: 1 attempt(s) | 
      Quality Score: 88/100 | 
      Errors: 0 | 
      Warnings: 2 | 
      Review: Translation improved after correction. 
      Some minor style issues remain.
    `;
    const result = parseMtAnalysis(complexAnalysis);

    expect(result.autoCorrected).toBe(true);
    expect(result.qualityScore).toBe(88);
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(2);
    expect(result.reasoning).toBeDefined();
  });
});

describe('mapSegmentStatus', () => {
  const createMockSegment = (status: Segment['status'] = 'MT'): Segment => ({
    id: '1',
    documentId: 'doc1',
    segmentIndex: 1,
    sourceText: 'Test',
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  it('should prioritize janitorStatus over everything', () => {
    const segment = createMockSegment('REQUIRES_REVIEW');
    const janitorStatus: JanitorStatus = 'VALIDATED';
    const metadata = { autoCorrected: false, qualityScore: 50, requiresReview: true };

    const result = mapSegmentStatus(segment, janitorStatus, metadata);
    expect(result).toBe('VALIDATED');
  });

  it('should use segment status if janitorStatus is not provided', () => {
    const segment = createMockSegment('REQUIRES_REVIEW');
    const metadata = { autoCorrected: false, qualityScore: 50, requiresReview: true };

    const result = mapSegmentStatus(segment, undefined, metadata);
    expect(result).toBe('REQUIRES_REVIEW');
  });

  it('should use metadata requiresReview if no explicit status', () => {
    const segment = createMockSegment('MT');
    const metadata = { autoCorrected: false, qualityScore: 70, requiresReview: true };

    const result = mapSegmentStatus(segment, undefined, metadata);
    expect(result).toBe('REQUIRES_REVIEW');
  });

  it('should map AUTO_FIXED for auto-corrected segments with good score', () => {
    const segment = createMockSegment('MT');
    const metadata = { autoCorrected: true, qualityScore: 88, requiresReview: false };

    const result = mapSegmentStatus(segment, undefined, metadata);
    expect(result).toBe('AUTO_FIXED');
  });

  it('should map VALIDATED for excellent quality score', () => {
    const segment = createMockSegment('MT');
    const metadata = { autoCorrected: false, qualityScore: 95, requiresReview: false };

    const result = mapSegmentStatus(segment, undefined, metadata);
    expect(result).toBe('VALIDATED');
  });

  it('should return undefined if no status can be determined', () => {
    const segment = createMockSegment('MT');
    const metadata = { autoCorrected: false, requiresReview: false };

    const result = mapSegmentStatus(segment, undefined, metadata);
    expect(result).toBeUndefined();
  });
});
