/**
 * Утилиты для парсинга метаданных сегментов
 */

import type { Segment } from '../api/segments.api';
import type { JanitorStatus, SegmentAuditResult } from '../api/janitor.api';

/**
 * Метаданные, извлеченные из mtAnalysis
 */
export interface ParsedMetadata {
  autoCorrected: boolean;
  qualityScore?: number;
  correctionAttempts?: number;
  errors?: number;
  warnings?: number;
  reasoning?: string;
  requiresReview?: boolean;
}

/**
 * Парсит mtAnalysis для извлечения метаданных автокоррекции
 * 
 * Примеры строк mtAnalysis:
 * - "Auto-corrected: 1 attempt(s) | Quality Score: 88/100 | Errors: 0 | Warnings: 2"
 * - "Quality Score: 72/100 | Errors: 1 | Warnings: 0 | Review: Translation quality below threshold"
 * - "Auto-corrected but quality score 78/100 still below threshold. Requires manual review."
 */
export function parseMtAnalysis(mtAnalysis: string | null | undefined): ParsedMetadata {
  if (!mtAnalysis) {
    return {
      autoCorrected: false,
      requiresReview: false,
    };
  }

  const analysis = mtAnalysis.trim();
  
  // Флаг автокоррекции
  const autoCorrected = /auto[- ]corrected/i.test(analysis);
  
  // Балл качества: "Quality Score: 88/100" или "quality score 78/100"
  const qualityScorePatterns = [
    /quality\s+score:\s*(\d+)\/100/i,
    /quality\s+score\s+(\d+)\/100/i,
    /score:\s*(\d+)\/100/i,
    /(\d+)\/100/i, // Fallback: просто число/100
  ];
  
  let qualityScore: number | undefined;
  for (const pattern of qualityScorePatterns) {
    const match = analysis.match(pattern);
    if (match) {
      qualityScore = parseInt(match[1], 10);
      if (qualityScore >= 0 && qualityScore <= 100) {
        break;
      }
    }
  }
  
  // Количество попыток исправления: "1 attempt(s)"
  const attemptsMatch = analysis.match(/(\d+)\s+attempt/i);
  const correctionAttempts = attemptsMatch ? parseInt(attemptsMatch[1], 10) : undefined;
  
  // Количество ошибок: "Errors: 0"
  const errorsMatch = analysis.match(/errors?:\s*(\d+)/i);
  const errors = errorsMatch ? parseInt(errorsMatch[1], 10) : undefined;
  
  // Количество предупреждений: "Warnings: 2"
  const warningsMatch = analysis.match(/warnings?:\s*(\d+)/i);
  const warnings = warningsMatch ? parseInt(warningsMatch[1], 10) : undefined;
  
  // Флаг требует ревью
  const requiresReview = 
    /requires?\s+(manual\s+)?review/i.test(analysis) ||
    /review:\s*translation/i.test(analysis) ||
    (qualityScore !== undefined && qualityScore < 85);
  
  // Извлечение reasoning (текст после "Review:" или "Reasoning:")
  let reasoning: string | undefined;
  const reasoningPatterns = [
    /review:\s*(.+?)(?:\s*\||$)/i,
    /reasoning:\s*(.+?)(?:\s*\||$)/i,
    /(?:still\s+)?below\s+threshold[.:]\s*(.+?)(?:\s*\||$)/i,
  ];
  
  for (const pattern of reasoningPatterns) {
    const match = analysis.match(pattern);
    if (match && match[1]) {
      reasoning = match[1].trim();
      break;
    }
  }
  
  return {
    autoCorrected,
    qualityScore,
    correctionAttempts,
    errors,
    warnings,
    reasoning,
    requiresReview,
  };
}

/**
 * Определяет финальный UI-статус сегмента на основе:
 * - status в БД (REQUIRES_REVIEW)
 * - janitorStatus из JanitorReport
 * - метаданных из mtAnalysis
 */
export function mapSegmentStatus(
  segment: Segment,
  janitorStatus?: JanitorStatus,
  parsedMetadata?: ParsedMetadata,
): JanitorStatus | undefined {
  // Приоритет 1: Явный статус из Janitor
  if (janitorStatus) {
    return janitorStatus;
  }
  
  // Приоритет 2: Статус из БД
  if (segment.status === 'REQUIRES_REVIEW') {
    return 'REQUIRES_REVIEW';
  }
  
  // Приоритет 3: Статус на основе метаданных
  if (parsedMetadata?.requiresReview) {
    return 'REQUIRES_REVIEW';
  }
  
  // Приоритет 4: Если был автокорректирован и качество хорошее
  if (parsedMetadata?.autoCorrected && parsedMetadata.qualityScore && parsedMetadata.qualityScore >= 85) {
    return 'AUTO_FIXED';
  }
  
  // Приоритет 5: Если качество отличное
  if (parsedMetadata?.qualityScore && parsedMetadata.qualityScore >= 90) {
    return 'VALIDATED';
  }
  
  // По умолчанию: undefined (не определен)
  return undefined;
}

/**
 * Обогащенный сегмент с метаданными
 */
export interface EnrichedSegment extends Omit<Segment, 'status'> {
  /** Оригинальный статус из БД */
  status: Segment['status'];
  /** Финальный UI-статус на основе Janitor и метаданных */
  janitorStatus?: JanitorStatus;
  janitorComment?: string;
  autoCorrected: boolean;
  qualityScore?: number;
  correctionAttempts?: number;
  errors?: number;
  warnings?: number;
  reasoning?: string;
  requiresReview: boolean;
  parsedMetadata: ParsedMetadata;
}

/**
 * Обогащает сегмент метаданными из JanitorReport и mtAnalysis
 */
export function enrichSegment(
  segment: Segment,
  janitorData?: SegmentAuditResult,
  janitorStatus?: JanitorStatus,
): EnrichedSegment {
  const parsedMetadata = parseMtAnalysis(segment.mtAnalysis);
  const finalStatus = mapSegmentStatus(segment, janitorStatus, parsedMetadata);
  
  return {
    ...segment,
    janitorStatus: finalStatus,
    janitorComment: janitorData?.janitorComment,
    autoCorrected: parsedMetadata.autoCorrected,
    qualityScore: parsedMetadata.qualityScore,
    correctionAttempts: parsedMetadata.correctionAttempts,
    errors: parsedMetadata.errors,
    warnings: parsedMetadata.warnings,
    reasoning: parsedMetadata.reasoning,
    requiresReview: finalStatus === 'REQUIRES_REVIEW' || parsedMetadata.requiresReview || false,
    parsedMetadata,
  };
}
