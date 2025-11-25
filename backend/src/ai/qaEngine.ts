import { distance as levenshteinDistance } from 'fastest-levenshtein';

export type QAIssue = {
  segmentId: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  category: 'terminology' | 'format' | 'consistency' | 'tags' | 'general';
};

export type GlossaryTerm = {
  sourceTerm: string;
  targetTerm: string;
  forbidden: boolean;
};

export type SegmentContext = {
  id: string;
  sourceText: string;
  targetText: string | null;
  targetMt?: string | null;
  tags?: string[];
  fileType?: string;
};

export type QACheckOptions = {
  glossary?: GlossaryTerm[];
  projectSegments?: Array<{ sourceText: string; targetText: string | null }>;
  fileType?: string;
};

export class QAEngine {
  private extractNumbers(text: string): string[] {
    return text.match(/\d+(?:\.\d+)?/g) ?? [];
  }

  private extractUnits(text: string): string[] {
    const unitPattern = /\b(kV|MW|kW|km|m|mm|cm|kg|g|mg|°C|°F|Hz|MHz|GHz|V|A|W|J|Pa|bar|psi|rpm|rps)\b/gi;
    return text.match(unitPattern) ?? [];
  }

  private normalizeForComparison(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private checkTerminology(sourceText: string, targetText: string, glossary: GlossaryTerm[]): QAIssue[] {
    const issues: QAIssue[] = [];
    const sourceLower = sourceText.toLowerCase();
    const targetLower = targetText.toLowerCase();

    for (const term of glossary) {
      const sourceTermLower = term.sourceTerm.toLowerCase();
      const targetTermLower = term.targetTerm.toLowerCase();

      if (sourceLower.includes(sourceTermLower)) {
        if (term.forbidden) {
          if (targetLower.includes(targetTermLower)) {
            issues.push({
              segmentId: '',
              severity: 'error',
              message: `Forbidden term "${term.targetTerm}" found in translation`,
              category: 'terminology',
            });
          }
        } else {
          if (!targetLower.includes(targetTermLower)) {
            issues.push({
              segmentId: '',
              severity: 'warning',
              message: `Required term "${term.targetTerm}" missing in translation`,
              category: 'terminology',
            });
          }
        }
      }
    }

    return issues;
  }

  private checkNumbersAndUnits(sourceText: string, targetText: string): QAIssue[] {
    const issues: QAIssue[] = [];
    const sourceNumbers = this.extractNumbers(sourceText);
    const targetNumbers = this.extractNumbers(targetText);
    const sourceUnits = this.extractUnits(sourceText);
    const targetUnits = this.extractUnits(targetText);

    if (sourceNumbers.length > 0) {
      const sourceNumsStr = sourceNumbers.sort().join(',');
      const targetNumsStr = targetNumbers.sort().join(',');
      if (sourceNumsStr !== targetNumsStr) {
        issues.push({
          segmentId: '',
          severity: 'error',
          message: `Numeric mismatch: source has [${sourceNumsStr}], target has [${targetNumsStr}]`,
          category: 'format',
        });
      }
    }

    if (sourceUnits.length > 0) {
      const sourceUnitsStr = sourceUnits.map((u) => u.toLowerCase()).sort().join(',');
      const targetUnitsStr = targetUnits.map((u) => u.toLowerCase()).sort().join(',');
      if (sourceUnitsStr !== targetUnitsStr) {
        issues.push({
          segmentId: '',
          severity: 'warning',
          message: `Unit mismatch: source has [${sourceUnitsStr}], target has [${targetUnitsStr}]`,
          category: 'format',
        });
      }
    }

    return issues;
  }

  private extractTagSequence(text: string): string[] {
    const tagPattern = /<(\/?)(g|x|ph|bx|ex|bpt|ept|it|mrk)(?:\s+[^>]*)?\/?>/gi;
    const tags: string[] = [];
    let match;
    while ((match = tagPattern.exec(text)) !== null) {
      if (match[1] !== '/') {
        tags.push(match[2].toLowerCase());
      }
    }
    return tags;
  }

  private checkTagSequence(sourceText: string, targetText: string, fileType?: string): QAIssue[] {
    const issues: QAIssue[] = [];

    if (fileType !== 'XLIFF' && fileType !== 'xlf' && fileType !== 'xliff') {
      return issues;
    }

    const sourceTags = this.extractTagSequence(sourceText);
    const targetTags = this.extractTagSequence(targetText);

    if (sourceTags.length !== targetTags.length) {
      issues.push({
        segmentId: '',
        severity: 'error',
        message: `Tag count mismatch: source has ${sourceTags.length} tags, target has ${targetTags.length} tags`,
        category: 'tags',
      });
    } else {
      for (let i = 0; i < sourceTags.length; i++) {
        if (sourceTags[i] !== targetTags[i]) {
          issues.push({
            segmentId: '',
            severity: 'error',
            message: `Tag sequence mismatch at position ${i + 1}: source has "${sourceTags[i]}", target has "${targetTags[i]}"`,
            category: 'tags',
          });
        }
      }
    }

    return issues;
  }

  private checkConsistency(
    segment: SegmentContext,
    projectSegments: Array<{ sourceText: string; targetText: string | null }>,
  ): QAIssue[] {
    const issues: QAIssue[] = [];
    if (!segment.targetText) return issues;

    const normalizedSource = this.normalizeForComparison(segment.sourceText);
    const similarityThreshold = 0.9;

    for (const other of projectSegments) {
      if (!other.targetText || other.sourceText === segment.sourceText) continue;

      const normalizedOther = this.normalizeForComparison(other.sourceText);
      const similarity = 1 - levenshteinDistance(normalizedSource, normalizedOther) / Math.max(normalizedSource.length, normalizedOther.length, 1);

      if (similarity >= similarityThreshold) {
        const normalizedTarget = this.normalizeForComparison(segment.targetText);
        const normalizedOtherTarget = this.normalizeForComparison(other.targetText);
        const targetSimilarity = 1 - levenshteinDistance(normalizedTarget, normalizedOtherTarget) / Math.max(normalizedTarget.length, normalizedOtherTarget.length, 1);

        if (targetSimilarity < 0.7) {
          issues.push({
            segmentId: '',
            severity: 'warning',
            message: `Inconsistent translation: similar source segments have different translations`,
            category: 'consistency',
          });
          break;
        }
      }
    }

    return issues;
  }

  runChecks(segments: SegmentContext[], options: QACheckOptions = {}): QAIssue[] {
    const issues: QAIssue[] = [];

    for (const segment of segments) {
      if (!segment.targetText || segment.targetText.trim().length === 0) {
        issues.push({
          segmentId: segment.id,
          severity: 'warning',
          message: 'Target text missing',
          category: 'general',
        });
        continue;
      }

      const segmentIssues: QAIssue[] = [];

      if (options.glossary && options.glossary.length > 0) {
        segmentIssues.push(...this.checkTerminology(segment.sourceText, segment.targetText, options.glossary));
      }

      segmentIssues.push(...this.checkNumbersAndUnits(segment.sourceText, segment.targetText));

      if (segment.tags || options.fileType) {
        segmentIssues.push(...this.checkTagSequence(segment.sourceText, segment.targetText, options.fileType));
      }

      if (options.projectSegments && options.projectSegments.length > 0) {
        segmentIssues.push(...this.checkConsistency(segment, options.projectSegments));
      }

      segmentIssues.forEach((issue) => {
        issues.push({ ...issue, segmentId: segment.id });
      });
    }

    return issues;
  }
}
