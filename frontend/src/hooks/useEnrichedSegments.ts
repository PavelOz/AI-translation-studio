/**
 * useEnrichedSegments: Хук для обогащения сегментов метаданными
 * 
 * Объединяет данные из:
 * - prisma.segment (через segmentsApi)
 * - JanitorReport (через janitorApi)
 * - Парсит mtAnalysis для извлечения метаданных автокоррекции
 */

import { useMemo } from 'react';
import { useQuery } from 'react-query';
import { segmentsApi, type Segment } from '../api/segments.api';
import { janitorApi, type JanitorReport, type JanitorStatus } from '../api/janitor.api';
import {
  enrichSegment,
  type EnrichedSegment,
  parseMtAnalysis,
  mapSegmentStatus,
} from '../utils/segmentMetadata';

interface UseEnrichedSegmentsOptions {
  documentId: string;
  enabled?: boolean;
  page?: number;
  pageSize?: number;
}

interface UseEnrichedSegmentsResult {
  segments: EnrichedSegment[];
  isLoading: boolean;
  error: Error | null;
  documentHealth: {
    score: number;
    status: 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';
    validated: number;
    autoFixed: number;
    requiresReview: number;
    total: number;
  };
  statistics: {
    totalSegments: number;
    segmentsWithScore: number;
    averageScore: number;
    autoCorrectedCount: number;
    correctionAttemptsTotal: number;
    totalErrors: number;
    totalWarnings: number;
  };
}

/**
 * Хук для получения и обогащения сегментов метаданными
 */
export function useEnrichedSegments(
  options: UseEnrichedSegmentsOptions,
): UseEnrichedSegmentsResult {
  const { documentId, enabled = true, page = 1, pageSize = 1000 } = options;

  // Загружаем сегменты
  const {
    data: segmentsData,
    isLoading: isLoadingSegments,
    error: segmentsError,
  } = useQuery({
    queryKey: ['segments', documentId, page, pageSize],
    queryFn: () => segmentsApi.list(documentId, page, pageSize),
    enabled: enabled && !!documentId,
  });

  // Загружаем отчет Janitor
  const {
    data: janitorReport,
    isLoading: isLoadingJanitor,
    error: janitorError,
  } = useQuery({
    queryKey: ['janitor-report', documentId],
    queryFn: () => janitorApi.getReport(documentId),
    enabled: enabled && !!documentId,
    retry: false,
  });

  // Создаем мапу статусов из Janitor отчета
  const segmentStatusMap = useMemo(() => {
    const map = new Map<string, JanitorStatus>();
    if (janitorReport?.segments) {
      janitorReport.segments.forEach(seg => {
        map.set(seg.segmentId, seg.status);
      });
    }
    return map;
  }, [janitorReport]);

  // Создаем мапу данных Janitor для быстрого доступа
  const janitorDataMap = useMemo(() => {
    const map = new Map<string, typeof janitorReport.segments[0]>();
    if (janitorReport?.segments) {
      janitorReport.segments.forEach(seg => {
        map.set(seg.segmentId, seg);
      });
    }
    return map;
  }, [janitorReport]);

  // Обогащаем сегменты метаданными
  const enrichedSegments = useMemo(() => {
    if (!segmentsData?.segments) return [];

    return segmentsData.segments.map(segment => {
      const janitorStatus = segmentStatusMap.get(segment.id);
      const janitorData = janitorDataMap.get(segment.id);

      return enrichSegment(segment, janitorData, janitorStatus);
    });
  }, [segmentsData, segmentStatusMap, janitorDataMap]);

  // Вычисляем статистику документа
  const documentHealth = useMemo(() => {
    if (!enrichedSegments.length) {
      return {
        score: 0,
        status: 'unknown' as const,
        validated: 0,
        autoFixed: 0,
        requiresReview: 0,
        total: 0,
      };
    }

    const total = enrichedSegments.length;
    const validated = enrichedSegments.filter(s => s.janitorStatus === 'VALIDATED').length;
    const autoFixed = enrichedSegments.filter(s => s.janitorStatus === 'AUTO_FIXED').length;
    const requiresReview = enrichedSegments.filter(s => s.janitorStatus === 'REQUIRES_REVIEW').length;

    // Вычисляем средний балл качества
    const segmentsWithScore = enrichedSegments.filter(s => s.qualityScore !== undefined);
    const avgScore =
      segmentsWithScore.length > 0
        ? segmentsWithScore.reduce((sum, s) => sum + (s.qualityScore || 0), 0) / segmentsWithScore.length
        : (validated / total) * 100;

    let status: 'excellent' | 'good' | 'fair' | 'poor' = 'excellent';
    if (avgScore >= 90) status = 'excellent';
    else if (avgScore >= 75) status = 'good';
    else if (avgScore >= 60) status = 'fair';
    else status = 'poor';

    return {
      score: Math.round(avgScore),
      status,
      validated,
      autoFixed,
      requiresReview,
      total,
    };
  }, [enrichedSegments]);

  // Дополнительная статистика
  const statistics = useMemo(() => {
    const segmentsWithScore = enrichedSegments.filter(s => s.qualityScore !== undefined);
    const autoCorrectedCount = enrichedSegments.filter(s => s.autoCorrected).length;
    const correctionAttemptsTotal = enrichedSegments.reduce(
      (sum, s) => sum + (s.correctionAttempts || 0),
      0,
    );
    const totalErrors = enrichedSegments.reduce((sum, s) => sum + (s.errors || 0), 0);
    const totalWarnings = enrichedSegments.reduce((sum, s) => sum + (s.warnings || 0), 0);

    const averageScore =
      segmentsWithScore.length > 0
        ? segmentsWithScore.reduce((sum, s) => sum + (s.qualityScore || 0), 0) / segmentsWithScore.length
        : 0;

    return {
      totalSegments: enrichedSegments.length,
      segmentsWithScore: segmentsWithScore.length,
      averageScore: Math.round(averageScore * 100) / 100, // 2 decimal places
      autoCorrectedCount,
      correctionAttemptsTotal,
      totalErrors,
      totalWarnings,
    };
  }, [enrichedSegments]);

  return {
    segments: enrichedSegments,
    isLoading: isLoadingSegments || isLoadingJanitor,
    error: (segmentsError || janitorError) as Error | null,
    documentHealth,
    statistics,
  };
}
