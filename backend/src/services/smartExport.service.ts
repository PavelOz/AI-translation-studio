/**
 * SmartExportService: Экспорт документов с учетом статусов Janitor и метаданных
 * 
 * Возможности:
 * - Status-Driven Formatting: VALIDATED/AUTO_FIXED - обычный текст, REQUIRES_REVIEW - выделение
 * - Comment Injection: Комментарии для REQUIRES_REVIEW сегментов
 * - DNA Abbreviation Handling: Проверка соответствия аббревиатур
 */

import { prisma } from '../db/prisma';
import { getDocument } from './document.service';
import { getDocumentSegments } from './segment.service';
import { getDocumentDna } from './analysis.service';
import { UniversalJanitor } from './universalJanitor';
// import { exportDocumentFile } from './file.service'; // Не используется напрямую
import { logger } from '../utils/logger';
import { ApiError } from '../utils/apiError';
import type { JanitorStatus } from './universalJanitor';
import type { DocumentDnaPayload } from '../ai/types';
import * as UniversalFileService from './universalFile.service';

/**
 * Метаданные для экспорта сегмента
 */
interface ExportSegmentMetadata {
  segmentId: string;
  janitorStatus?: JanitorStatus;
  janitorComment?: string;
  requiresReview: boolean;
  qualityScore?: number;
  autoCorrected?: boolean;
  errors?: Array<{ type: string; message: string }>;
}

/**
 * Обогащенный сегмент для экспорта
 */
interface EnrichedExportSegment {
  index: number;
  targetText: string;
  segmentType?: string;
  metadata: ExportSegmentMetadata & {
    sourceText: string;
    shouldHighlight: boolean; // Требует выделения (REQUIRES_REVIEW)
    comment?: string; // Текст комментария
  };
}

/**
 * Опции для Smart Export
 */
export interface SmartExportOptions {
  documentId: string;
  highlightColor?: string; // Цвет выделения для REQUIRES_REVIEW (по умолчанию желтый)
  includeComments?: boolean; // Включать комментарии (по умолчанию true)
  validateAbbreviations?: boolean; // Проверять аббревиатуры из DNA (по умолчанию true)
}

/**
 * Результат Smart Export
 */
export interface SmartExportResult {
  buffer: Buffer;
  filename: string;
  statistics: {
    totalSegments: number;
    validated: number;
    autoFixed: number;
    requiresReview: number;
    segmentsWithComments: number;
  };
}

/**
 * Извлекает причину из janitorComment или errors
 */
function extractReason(janitorComment?: string, errors?: Array<{ type: string; message: string }>): string {
  if (janitorComment) {
    // Пытаемся извлечь краткую причину
    if (janitorComment.includes('Missed term')) return 'Missed term from DNA';
    if (janitorComment.includes('Wrong term')) return 'Wrong term usage';
    if (janitorComment.includes('Script mixing')) return 'Script mixing detected';
    if (janitorComment.includes('Low quality')) return 'Low quality score';
    if (janitorComment.includes('Constraint')) return 'Constraint violation';
    return janitorComment.substring(0, 100); // Первые 100 символов
  }
  
  if (errors && errors.length > 0) {
    const errorTypes = errors.map(e => e.type).join(', ');
    return `Validation errors: ${errorTypes}`;
  }
  
  return 'Requires manual review';
}

/**
 * Проверяет соответствие аббревиатур в тексте DNA
 */
function validateAbbreviationsInText(
  text: string,
  abbreviationLogic: DocumentDnaPayload['abbreviationLogic'],
): Array<{ term: string; found: string; expected: string }> {
  if (!abbreviationLogic || typeof abbreviationLogic !== 'object') {
    return [];
  }

  const issues: Array<{ term: string; found: string; expected: string }> = [];
  const terms = Object.entries(abbreviationLogic);

  for (const [key, value] of terms) {
    if (!value || typeof value !== 'object') continue;
    
    const longForm = value.longForm || '';
    const shortForm = value.shortForm || '';
    
    // Проверяем, используется ли аббревиатура
    const hasShortForm = text.includes(shortForm);
    const hasLongForm = text.includes(longForm);
    
    // Если используется и короткая, и длинная форма одновременно - это может быть проблемой
    if (hasShortForm && hasLongForm && shortForm !== longForm) {
      issues.push({
        term: key,
        found: `${shortForm} and ${longForm}`,
        expected: 'Use either short or long form consistently',
      });
    }
  }

  return issues;
}

/**
 * Обогащает сегменты метаданными для экспорта
 */
async function enrichSegmentsForExport(
  documentId: string,
  segments: Array<{ id: string; segmentIndex: number; sourceText: string; targetFinal?: string | null; targetMt?: string | null }>,
  janitorReport: Awaited<ReturnType<typeof UniversalJanitor.prototype.auditSegments>>,
  dna?: DocumentDnaPayload | null,
): Promise<EnrichedExportSegment[]> {
  // Создаем мапу статусов из Janitor отчета
  const statusMap = new Map<string, JanitorStatus>();
  const commentMap = new Map<string, string>();
  const errorsMap = new Map<string, Array<{ type: string; message: string }>>();

  if (janitorReport.segments) {
    for (const seg of janitorReport.segments) {
      statusMap.set(seg.segmentId, seg.status);
      if (seg.janitorComment) {
        commentMap.set(seg.segmentId, seg.janitorComment);
      }
      if (seg.errors && seg.errors.length > 0) {
        errorsMap.set(
          seg.segmentId,
          seg.errors.map(e => ({ type: e.type, message: e.message })),
        );
      }
    }
  }

  const enriched: EnrichedExportSegment[] = [];

  for (const segment of segments) {
    const janitorStatus = statusMap.get(segment.id);
    const janitorComment = commentMap.get(segment.id);
    const errors = errorsMap.get(segment.id);
    const requiresReview = janitorStatus === 'REQUIRES_REVIEW' || segment.targetFinal === null;

    // Проверяем аббревиатуры, если включена валидация
    const abbreviationIssues = dna?.abbreviationLogic
      ? validateAbbreviationsInText(segment.targetFinal || segment.targetMt || '', dna.abbreviationLogic)
      : [];

    // Формируем комментарий
    let comment: string | undefined;
    if (requiresReview && janitorComment) {
      const reason = extractReason(janitorComment, errors);
      comment = `${reason}\n\n${janitorComment}`;
    } else if (requiresReview && errors && errors.length > 0) {
      comment = extractReason(undefined, errors);
    } else if (abbreviationIssues.length > 0) {
      comment = `Abbreviation issues: ${abbreviationIssues.map(i => `${i.term} (${i.found})`).join(', ')}`;
    }

    enriched.push({
      index: segment.segmentIndex,
      targetText: segment.targetFinal || segment.targetMt || segment.sourceText,
      segmentType: 'paragraph',
      metadata: {
        segmentId: segment.id,
        janitorStatus,
        janitorComment,
        requiresReview,
        errors,
        shouldHighlight: requiresReview,
        comment,
        sourceText: segment.sourceText,
      },
    });
  }

  return enriched;
}

/**
 * Применяет форматирование и комментарии к экспортируемому документу
 */
async function applySmartFormatting(
  documentId: string,
  enrichedSegments: EnrichedExportSegment[],
  options: SmartExportOptions,
): Promise<Buffer> {
  const document = await getDocument(documentId);
  if (!document) {
    throw ApiError.notFound('Document not found');
  }

  // Загружаем оригинальный файл
  const originalBuffer = await import('fs/promises').then(fs => 
    fs.readFile(document.storagePath)
  );

  // Преобразуем обогащенные сегменты в формат для экспорта
  const exportSegments = enrichedSegments.map(seg => ({
    index: seg.index,
    targetText: seg.targetText,
    segmentType: seg.segmentType || 'paragraph',
    metadata: {
      ...seg.metadata,
      // Добавляем флаги для форматирования
      highlight: seg.metadata.shouldHighlight,
      comment: options.includeComments !== false ? seg.metadata.comment : undefined,
    },
  }));

  // Используем UniversalFileService для экспорта с расширенными метаданными
  // ВАЖНО: Обработчики файлов должны поддерживать highlight и comment в metadata
  try {
    const exportedBuffer = await UniversalFileService.exportDocument(
      {
        segments: exportSegments,
        originalBuffer,
        metadata: {
          documentId: document.id,
          filename: document.filename ?? document.name,
          smartExport: true,
          highlightColor: options.highlightColor || 'yellow',
          includeComments: options.includeComments !== false,
        },
      },
      document.filename ?? document.name,
    );
    return exportedBuffer;
  } catch (error) {
    logger.error({ documentId, error }, 'Failed to apply smart formatting');
    throw ApiError.internalServerError(`Failed to export document: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Главная функция Smart Export
 */
export async function smartExportDocument(options: SmartExportOptions): Promise<SmartExportResult> {
  const { documentId, highlightColor = 'yellow', includeComments = true, validateAbbreviations = true } = options;

  logger.info({ documentId }, 'Starting smart export');

  // 1. Загружаем документ
  const document = await getDocument(documentId);
  if (!document) {
    throw ApiError.notFound('Document not found');
  }

  // 2. Загружаем сегменты
  const segmentsData = await getDocumentSegments(documentId, 1, 100000); // Большой лимит для экспорта
  const segments = segmentsData.segments;

  // 3. Загружаем Janitor отчет
  const janitor = new UniversalJanitor();
  const janitorReport = await janitor.auditSegments(documentId, {
    autoFix: false, // Только проверка, без исправлений
    strictMode: true,
    dryRun: true, // Не сохраняем изменения
  });

  // 4. Загружаем DNA (если нужна валидация аббревиатур)
  let dna: DocumentDnaPayload | null = null;
  if (validateAbbreviations) {
    dna = await getDocumentDna(documentId);
  }

  // 5. Обогащаем сегменты метаданными
  const enrichedSegments = await enrichSegmentsForExport(
    documentId,
    segments,
    janitorReport,
    dna,
  );

  // 6. Применяем форматирование и комментарии
  const buffer = await applySmartFormatting(documentId, enrichedSegments, {
    documentId,
    highlightColor,
    includeComments,
    validateAbbreviations,
  });

  // 7. Формируем имя файла с суффиксом
  const originalFilename = document.filename ?? document.name;
  const baseName = originalFilename.replace(/\.(docx|xlsx|xliff|xlf)$/i, '');
  const extension = originalFilename.match(/\.(docx|xlsx|xliff|xlf)$/i)?.[1] || 'docx';
  const filename = `${baseName}_DNA_REVIEWED.${extension}`;

  // 8. Статистика
  const statistics = {
    totalSegments: enrichedSegments.length,
    validated: enrichedSegments.filter(s => s.metadata.janitorStatus === 'VALIDATED').length,
    autoFixed: enrichedSegments.filter(s => s.metadata.janitorStatus === 'AUTO_FIXED').length,
    requiresReview: enrichedSegments.filter(s => s.metadata.requiresReview).length,
    segmentsWithComments: enrichedSegments.filter(s => s.metadata.comment).length,
  };

  logger.info({ documentId, statistics }, 'Smart export completed');

  return {
    buffer,
    filename,
    statistics,
  };
}
