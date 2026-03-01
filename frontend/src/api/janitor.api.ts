/**
 * API для UniversalJanitor
 */

import apiClient from './client';

/**
 * Статус проверки сегмента
 */
export type JanitorStatus = 'VALIDATED' | 'AUTO_FIXED' | 'REQUIRES_REVIEW';

/**
 * Тип ошибки валидации
 */
export type ValidationErrorType =
  | 'MISSED_TERM'
  | 'WRONG_TERM'
  | 'SCRIPT_MIXING'
  | 'CONSTRAINT_VIOLATION'
  | 'CASE_MISMATCH'
  | 'SPACING_ISSUE'
  | 'FORMAT_ISSUE';

/**
 * Ошибка валидации
 */
export type ValidationError = {
  type: ValidationErrorType;
  message: string;
  term?: string;
  expected?: string;
  found?: string;
  position?: number;
};

/**
 * Предупреждение валидации
 */
export type ValidationWarning = {
  type: string;
  message: string;
  suggestion?: string;
};

/**
 * Результат проверки одного сегмента
 */
export type SegmentAuditResult = {
  segmentId: string;
  segmentIndex: number;
  status: JanitorStatus;
  originalText: string;
  fixedText?: string;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  janitorComment?: string;
};

/**
 * Статистика аудита
 */
export type JanitorStatistics = {
  totalSegments: number;
  validated: number;
  autoFixed: number;
  requiresReview: number;
  totalErrors: number;
  totalWarnings: number;
  errorsByType: Record<ValidationErrorType, number>;
};

/**
 * Отчет о проверке
 */
export type JanitorReport = {
  documentId: string;
  documentName?: string;
  direction: string;
  statistics: JanitorStatistics;
  segments: SegmentAuditResult[];
  dnaUsed: {
    totalTerms: number;
    termsChecked: number;
    validationRules: number;
  };
  timestamp: string;
};

/**
 * Опции для аудита
 */
export type AuditOptions = {
  autoFix?: boolean;
  strictMode?: boolean;
  dryRun?: boolean;
};

export const janitorApi = {
  /**
   * Запустить аудит сегментов документа
   */
  auditSegments: async (
    documentId: string,
    options?: AuditOptions,
  ): Promise<JanitorReport> => {
    const response = await apiClient.post<JanitorReport>(
      `/documents/${documentId}/janitor/audit`,
      options || {},
    );
    return response.data;
  },

  /**
   * Получить отчет о проверке (если уже был выполнен)
   */
  getReport: async (documentId: string): Promise<JanitorReport | null> => {
    try {
      const response = await apiClient.get<JanitorReport>(
        `/documents/${documentId}/janitor/report`,
      );
      return response.data;
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  },

  /**
   * Подтвердить исправления для сегмента
   */
  approveSegment: async (
    segmentId: string,
    fixedText?: string,
  ): Promise<void> => {
    await apiClient.post(`/segments/${segmentId}/janitor/approve`, {
      fixedText,
    });
  },

  /**
   * Массовое подтверждение сегментов
   */
  bulkApprove: async (
    segmentIds: string[],
  ): Promise<{ approved: number }> => {
    const response = await apiClient.post<{ approved: number }>(
      '/segments/janitor/bulk-approve',
      { segmentIds },
    );
    return response.data;
  },
};
