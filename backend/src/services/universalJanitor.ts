/**
 * UniversalJanitor: DNA-Driven Audit с концепцией Human-in-the-loop
 * 
 * Основные возможности:
 * - DNA-Driven Audit: сопоставление переведенных сегментов с DocumentDnaPayload
 * - Flagging Logic (HITL): система статусов VALIDATED, AUTO_FIXED, REQUIRES_REVIEW
 * - Validation Suite: Glossary Integrity, Script Integrity, Constraint Check
 * - Reason Reporting: понятные описания ошибок для REQUIRES_REVIEW
 * - Batch Processing: эффективная проверка без LLM (чисто алгоритмическая)
 */

import { prisma } from '../db/prisma';
import { getDocumentDna } from './analysis.service';
import { normalizeDocumentDnaPayloadOrNull } from './dnaSchema';
import { logger } from '../utils/logger';
import type { DocumentDnaPayload, ValidationHints } from '../ai/types';

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
 * Результат проверки одного сегмента
 */
export interface SegmentAuditResult {
  segmentId: string;
  segmentIndex: number;
  status: JanitorStatus;
  originalText: string;
  fixedText?: string; // Если AUTO_FIXED
  errors: ValidationError[];
  warnings: ValidationWarning[];
  janitorComment?: string; // Понятное описание для REQUIRES_REVIEW
}

/**
 * Ошибка валидации
 */
export interface ValidationError {
  type: ValidationErrorType;
  message: string;
  term?: string; // Термин из DNA, который вызвал ошибку
  expected?: string; // Ожидаемое значение
  found?: string; // Найденное значение
  position?: number; // Позиция в тексте (опционально)
}

/**
 * Предупреждение валидации
 */
export interface ValidationWarning {
  type: string;
  message: string;
  suggestion?: string;
}

/**
 * Статистика аудита
 */
export interface JanitorStatistics {
  totalSegments: number;
  validated: number;
  autoFixed: number;
  requiresReview: number;
  totalErrors: number;
  totalWarnings: number;
  errorsByType: Record<ValidationErrorType, number>;
}

/**
 * Отчет о проверке
 */
export interface JanitorReport {
  documentId: string;
  documentName?: string;
  direction: string; // sourceLocale → targetLocale
  statistics: JanitorStatistics;
  segments: SegmentAuditResult[];
  dnaUsed: {
    totalTerms: number;
    termsChecked: number;
    validationRules: number;
  };
  timestamp: Date;
}

/**
 * Опции для аудита
 */
export interface AuditOptions {
  autoFix?: boolean; // Автоматически исправлять мелкие ошибки
  strictMode?: boolean; // Строгий режим (больше REQUIRES_REVIEW)
  dryRun?: boolean; // Не сохранять изменения в БД
}

/**
 * Индекс терминов из DNA для быстрого поиска
 */
class DnaTermIndex {
  private termMap: Map<string, { longForm: string; shortForm: string; aliases: string[] }> = new Map();
  private shortFormMap: Map<string, string> = new Map(); // shortForm -> key
  private aliasesMap: Map<string, string> = new Map(); // alias -> key
  private normalizedMap: Map<string, string> = new Map(); // normalized -> key

  /**
   * Построить индекс из abbreviationLogic
   */
  build(abbreviationLogic: Record<string, unknown> | null | undefined): void {
    this.termMap.clear();
    this.shortFormMap.clear();
    this.aliasesMap.clear();
    this.normalizedMap.clear();

    if (!abbreviationLogic || typeof abbreviationLogic !== 'object') return;

    for (const [key, value] of Object.entries(abbreviationLogic)) {
      let longForm = '';
      let shortForm = '';
      const aliases: string[] = [];

      if (typeof value === 'string') {
        longForm = value;
        shortForm = value;
      } else if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        longForm = (obj.longForm as string) || (obj.value as string) || key;
        shortForm = (obj.shortForm as string) || longForm;
        if (Array.isArray(obj.aliases)) {
          aliases.push(...(obj.aliases as string[]).filter(a => typeof a === 'string'));
        }
      }

      if (longForm) {
        this.termMap.set(key, { longForm, shortForm, aliases });
        this.normalizedMap.set(this.normalize(key), key);

        if (shortForm) {
          this.shortFormMap.set(this.normalize(shortForm), key);
        }

        for (const alias of aliases) {
          this.aliasesMap.set(this.normalize(alias), key);
        }
      }
    }

    logger.info(
      {
        totalTerms: this.termMap.size,
        totalShortForms: this.shortFormMap.size,
        totalAliases: this.aliasesMap.size,
      },
      'DNA term index built',
    );
  }

  /**
   * Найти термин по ключу, shortForm или alias
   */
  find(term: string): { key: string; longForm: string; shortForm: string; aliases: string[] } | null {
    const normalized = this.normalize(term);
    
    // Прямой поиск по ключу
    const directKey = this.normalizedMap.get(normalized);
    if (directKey) {
      const entry = this.termMap.get(directKey);
      if (entry) return { key: directKey, ...entry };
    }

    // Поиск по shortForm
    const shortFormKey = this.shortFormMap.get(normalized);
    if (shortFormKey) {
      const entry = this.termMap.get(shortFormKey);
      if (entry) return { key: shortFormKey, ...entry };
    }

    // Поиск по alias
    const aliasKey = this.aliasesMap.get(normalized);
    if (aliasKey) {
      const entry = this.termMap.get(aliasKey);
      if (entry) return { key: aliasKey, ...entry };
    }

    return null;
  }

  /**
   * Получить все термины
   */
  getAllTerms(): Array<{ key: string; longForm: string; shortForm: string; aliases: string[] }> {
    return Array.from(this.termMap.entries()).map(([key, value]) => ({
      key,
      ...value,
    }));
  }

  /**
   * Нормализация термина для поиска
   */
  private normalize(term: string): string {
    return term
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[^\p{L}\p{N}]/gu, ''); // Убираем пунктуацию
  }
}

/**
 * UniversalJanitor: уборщик с DNA-Driven Audit
 */
export class UniversalJanitor {
  private dnaIndex: DnaTermIndex = new DnaTermIndex();
  private validationHints: ValidationHints | null = null;
  private sourceLocale: string = '';
  private targetLocale: string = '';

  /**
   * Основной метод аудита сегментов
   */
  async auditSegments(
    documentId: string,
    options: AuditOptions = {},
  ): Promise<JanitorReport> {
    // Загружаем документ и сегменты
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        name: true,
        sourceLocale: true,
        targetLocale: true,
        segments: {
          select: {
            id: true,
            segmentIndex: true,
            sourceText: true,
            targetMt: true,
            targetFinal: true,
          },
          orderBy: {
            segmentIndex: 'asc',
          },
        },
      },
    });

    if (!document) {
      throw new Error(`Document ${documentId} not found`);
    }

    this.sourceLocale = document.sourceLocale;
    this.targetLocale = document.targetLocale;

    // Загружаем DNA
    const dna = await getDocumentDna(documentId);
    const normalizedDna = normalizeDocumentDnaPayloadOrNull(dna);

    if (!normalizedDna?.abbreviationLogic) {
      logger.warn({ documentId }, 'No DNA found for document');
    } else {
      // Строим индекс терминов
      this.dnaIndex.build(normalizedDna.abbreviationLogic);
      this.validationHints = normalizedDna.validationHints || null;
    }

    // Проверяем все сегменты
    const auditResults: SegmentAuditResult[] = [];
    
    for (const segment of document.segments) {
      const targetText = segment.targetFinal || segment.targetMt || '';
      
      if (!targetText) {
        // Пропускаем сегменты без перевода
        continue;
      }

      const result = this.auditSingleSegment(
        segment.id,
        segment.segmentIndex,
        segment.sourceText,
        targetText,
        options,
      );

      auditResults.push(result);
    }

    // Вычисляем статистику
    const statistics = this.calculateStatistics(auditResults);

    // Сохраняем результаты в БД (если не dryRun)
    if (!options.dryRun) {
      await this.saveAuditResults(documentId, auditResults);
    }

    return {
      documentId,
      documentName: document.name,
      direction: `${document.sourceLocale} → ${document.targetLocale}`,
      statistics,
      segments: auditResults,
      dnaUsed: {
        totalTerms: this.dnaIndex.getAllTerms().length,
        termsChecked: this.countCheckedTerms(auditResults),
        validationRules: this.validationHints?.rules?.length || 0,
      },
      timestamp: new Date(),
    };
  }

  /**
   * Проверка одного сегмента
   */
  private auditSingleSegment(
    segmentId: string,
    segmentIndex: number,
    sourceText: string,
    targetText: string,
    options: AuditOptions,
  ): SegmentAuditResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    let fixedText: string | undefined = undefined;
    let status: JanitorStatus = 'VALIDATED';

    // 1. Glossary Integrity Check
    const glossaryErrors = this.checkGlossaryIntegrity(sourceText, targetText);
    errors.push(...glossaryErrors);

    // 2. Script Integrity Check
    const scriptErrors = this.checkScriptIntegrity(targetText);
    errors.push(...scriptErrors);

    // 3. Constraint Check (validationHints.rules)
    const constraintErrors = this.checkConstraints(sourceText, targetText);
    errors.push(...constraintErrors);

    // 4. Auto-fix мелких ошибок (если включено)
    if (options.autoFix !== false && errors.length > 0) {
      const fixResult = this.attemptAutoFix(targetText, errors);
      if (fixResult.fixed) {
        fixedText = fixResult.text;
        // Удаляем исправленные ошибки из списка
        errors.splice(0, errors.length, ...fixResult.remainingErrors);
        status = 'AUTO_FIXED';
      }
    }

    // 5. Определяем финальный статус
    if (errors.length > 0) {
      // Если есть критические ошибки - REQUIRES_REVIEW
      const criticalErrors = errors.filter(
        e => e.type === 'MISSED_TERM' || e.type === 'WRONG_TERM' || e.type === 'CONSTRAINT_VIOLATION',
      );
      
      if (criticalErrors.length > 0 || options.strictMode) {
        status = 'REQUIRES_REVIEW';
      } else if (status !== 'AUTO_FIXED') {
        // Если есть некритические ошибки и не было автофикса
        status = 'AUTO_FIXED';
      }
    }

    // 6. Генерируем понятный комментарий для REQUIRES_REVIEW
    const janitorComment = status === 'REQUIRES_REVIEW' 
      ? this.generateJanitorComment(errors, warnings)
      : undefined;

    return {
      segmentId,
      segmentIndex,
      status,
      originalText: targetText,
      fixedText,
      errors,
      warnings,
      janitorComment,
    };
  }

  /**
   * Glossary Integrity: проверка терминов из DNA
   */
  private checkGlossaryIntegrity(
    sourceText: string,
    targetText: string,
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const sourceLower = sourceText.toLowerCase();
    const targetLower = targetText.toLowerCase();

    // Получаем все термины из DNA
    const allTerms = this.dnaIndex.getAllTerms();

    for (const term of allTerms) {
      const sourceKeyLower = term.key.toLowerCase();
      
      // Проверяем, есть ли термин в исходном тексте
      if (!sourceLower.includes(sourceKeyLower) && 
          !sourceLower.includes(term.longForm.toLowerCase()) &&
          !term.aliases.some(alias => sourceLower.includes(alias.toLowerCase()))) {
        continue; // Термин не встречается в исходном тексте
      }

      // Термин есть в исходном тексте - проверяем перевод
      const longFormLower = term.longForm.toLowerCase();
      const shortFormLower = term.shortForm.toLowerCase();
      const aliasesLower = term.aliases.map(a => a.toLowerCase());

      // Проверяем наличие longForm или shortForm в переводе
      const hasLongForm = targetLower.includes(longFormLower);
      const hasShortForm = shortFormLower && targetLower.includes(shortFormLower);
      const hasAlias = aliasesLower.some(alias => targetLower.includes(alias));

      if (!hasLongForm && !hasShortForm && !hasAlias) {
        // Термин пропущен в переводе
        errors.push({
          type: 'MISSED_TERM',
          message: `Missed term: '${term.key}' (expected: '${term.longForm}' or '${term.shortForm}')`,
          term: term.key,
          expected: term.longForm,
          found: undefined,
        });
      } else if (hasLongForm && hasShortForm) {
        // Проверяем правильность использования
        // Если в исходном тексте был shortForm, а в переводе longForm - это может быть ошибкой
        if (sourceLower.includes(term.shortForm.toLowerCase()) && !targetLower.includes(shortFormLower)) {
          errors.push({
            type: 'WRONG_TERM',
            message: `Wrong term usage: '${term.key}' should use shortForm '${term.shortForm}' but found '${term.longForm}'`,
            term: term.key,
            expected: term.shortForm,
            found: term.longForm,
          });
        }
      }
    }

    return errors;
  }

  /**
   * Script Integrity: детекция смешения алфавитов
   */
  private checkScriptIntegrity(targetText: string): ValidationError[] {
    const errors: ValidationError[] = [];

    // Определяем ожидаемый алфавит на основе направления перевода
    const isTargetEnglish = this.targetLocale.toLowerCase().startsWith('en');
    const isTargetRussian = this.targetLocale.toLowerCase().startsWith('ru');

    if (isTargetEnglish) {
      // В английском переводе не должно быть кириллицы
      const cyrillicRegex = /[\u0400-\u04FF]/;
      if (cyrillicRegex.test(targetText)) {
        const matches = targetText.match(/[\u0400-\u04FF]+/g);
        if (matches) {
          errors.push({
            type: 'SCRIPT_MIXING',
            message: `Cyrillic script detected in English translation: '${matches[0]}'`,
            found: matches[0],
          });
        }
      }
    } else if (isTargetRussian) {
      // В русском переводе может быть латиница для аббревиатур, но не должно быть смешения
      // Проверяем на подозрительные паттерны (например, русские слова с латинскими буквами)
      const mixedPattern = /[а-яё][a-z]|[a-z][а-яё]/i;
      if (mixedPattern.test(targetText)) {
        errors.push({
          type: 'SCRIPT_MIXING',
          message: 'Mixed script detected (Cyrillic and Latin in same word)',
        });
      }
    }

    return errors;
  }

  /**
   * Constraint Check: проверка правил из validationHints.rules
   */
  private checkConstraints(
    sourceText: string,
    targetText: string,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    if (!this.validationHints?.rules) {
      return errors;
    }

    const sourceLower = sourceText.toLowerCase();
    const targetLower = targetText.toLowerCase();

    for (const rule of this.validationHints.rules) {
      const termLower = rule.term.toLowerCase();
      
      // Проверяем, есть ли термин в исходном тексте
      if (!sourceLower.includes(termLower)) {
        continue; // Правило не применимо к этому сегменту
      }

      // Проверяем правило в контексте
      // Это упрощенная проверка - можно расширить для более сложных правил
      const ruleLower = rule.rule.toLowerCase();
      
      // Пример: если правило говорит "always means X, not Y"
      if (ruleLower.includes('always means') || ruleLower.includes('not')) {
        // Извлекаем ожидаемое значение из правила
        const expectedMatch = rule.rule.match(/means ['"]([^'"]+)['"]/i) || 
                            rule.rule.match(/→\s*['"]?([^'"]+)['"]?/i);
        const notMatch = rule.rule.match(/not ['"]([^'"]+)['"]/i);

        if (expectedMatch) {
          const expected = expectedMatch[1].toLowerCase();
          const notExpected = notMatch ? notMatch[1].toLowerCase() : null;

          // Проверяем наличие ожидаемого значения
          if (!targetLower.includes(expected)) {
            errors.push({
              type: 'CONSTRAINT_VIOLATION',
              message: `Constraint violation: '${rule.term}' - ${rule.rule}`,
              term: rule.term,
              expected: expectedMatch[1],
              found: notExpected && targetLower.includes(notExpected) ? notExpected : undefined,
            });
          }

          // Проверяем отсутствие недопустимого значения
          if (notExpected && targetLower.includes(notExpected)) {
            errors.push({
              type: 'CONSTRAINT_VIOLATION',
              message: `Constraint violation: '${rule.term}' should not be '${notExpected}' - ${rule.rule}`,
              term: rule.term,
              expected: expectedMatch[1],
              found: notExpected,
            });
          }
        }
      }
    }

    return errors;
  }

  /**
   * Попытка автоматического исправления мелких ошибок
   */
  private attemptAutoFix(
    text: string,
    errors: ValidationError[],
  ): { fixed: boolean; text: string; remainingErrors: ValidationError[] } {
    let fixedText = text;
    const remainingErrors: ValidationError[] = [];
    let fixed = false;

    for (const error of errors) {
      switch (error.type) {
        case 'CASE_MISMATCH':
          // Исправление регистра
          if (error.expected && error.found) {
            fixedText = fixedText.replace(error.found, error.expected);
            fixed = true;
          }
          break;

        case 'SPACING_ISSUE':
          // Исправление пробелов
          fixedText = fixedText.replace(/\s+/g, ' ').trim();
          fixed = true;
          break;

        case 'FORMAT_ISSUE':
          // Простые исправления формата
          // (можно расширить)
          break;

        default:
          // Критические ошибки не исправляем автоматически
          remainingErrors.push(error);
          break;
      }
    }

    return { fixed, text: fixedText, remainingErrors };
  }

  /**
   * Генерация понятного комментария для REQUIRES_REVIEW
   */
  private generateJanitorComment(
    errors: ValidationError[],
    warnings: ValidationWarning[],
  ): string {
    const parts: string[] = [];

    // Группируем ошибки по типу
    const missedTerms = errors.filter(e => e.type === 'MISSED_TERM');
    const wrongTerms = errors.filter(e => e.type === 'WRONG_TERM');
    const scriptErrors = errors.filter(e => e.type === 'SCRIPT_MIXING');
    const constraintErrors = errors.filter(e => e.type === 'CONSTRAINT_VIOLATION');

    if (missedTerms.length > 0) {
      const terms = missedTerms.map(e => `'${e.term}'`).join(', ');
      parts.push(`Missed terms: ${terms}`);
    }

    if (wrongTerms.length > 0) {
      const terms = wrongTerms.map(e => `'${e.term}' (expected: '${e.expected}', found: '${e.found}')`).join('; ');
      parts.push(`Wrong term usage: ${terms}`);
    }

    if (scriptErrors.length > 0) {
      parts.push(`Script mixing detected: ${scriptErrors[0].message}`);
    }

    if (constraintErrors.length > 0) {
      const constraints = constraintErrors.map(e => e.message).join('; ');
      parts.push(`Constraint violations: ${constraints}`);
    }

    if (warnings.length > 0) {
      const warningMessages = warnings.map(w => w.message).join('; ');
      parts.push(`Warnings: ${warningMessages}`);
    }

    return parts.join('. ') || 'Review required';
  }

  /**
   * Вычисление статистики
   */
  private calculateStatistics(results: SegmentAuditResult[]): JanitorStatistics {
    const stats: JanitorStatistics = {
      totalSegments: results.length,
      validated: 0,
      autoFixed: 0,
      requiresReview: 0,
      totalErrors: 0,
      totalWarnings: 0,
      errorsByType: {
        MISSED_TERM: 0,
        WRONG_TERM: 0,
        SCRIPT_MIXING: 0,
        CONSTRAINT_VIOLATION: 0,
        CASE_MISMATCH: 0,
        SPACING_ISSUE: 0,
        FORMAT_ISSUE: 0,
      },
    };

    for (const result of results) {
      switch (result.status) {
        case 'VALIDATED':
          stats.validated++;
          break;
        case 'AUTO_FIXED':
          stats.autoFixed++;
          break;
        case 'REQUIRES_REVIEW':
          stats.requiresReview++;
          break;
      }

      stats.totalErrors += result.errors.length;
      stats.totalWarnings += result.warnings.length;

      for (const error of result.errors) {
        stats.errorsByType[error.type]++;
      }
    }

    return stats;
  }

  /**
   * Подсчет проверенных терминов
   */
  private countCheckedTerms(results: SegmentAuditResult[]): number {
    const checkedTerms = new Set<string>();
    
    for (const result of results) {
      for (const error of result.errors) {
        if (error.term) {
          checkedTerms.add(error.term);
        }
      }
    }

    return checkedTerms.size;
  }

  /**
   * Сохранение результатов аудита в БД
   */
  private async saveAuditResults(
    documentId: string,
    results: SegmentAuditResult[],
  ): Promise<void> {
    // Обновляем сегменты с результатами аудита
    // Используем mtAnalysis для хранения janitorComment (можно добавить отдельное поле позже)
    for (const result of results) {
      const updateData: any = {};

      if (result.status === 'REQUIRES_REVIEW' && result.janitorComment) {
        // Сохраняем комментарий в mtAnalysis (временное решение)
        // TODO: Добавить поле janitorComment в схему Segment
        updateData.mtAnalysis = result.janitorComment;
      }

      if (result.status === 'AUTO_FIXED' && result.fixedText) {
        // Обновляем текст с исправлениями
        updateData.targetMt = result.fixedText;
      }

      if (Object.keys(updateData).length > 0) {
        await prisma.segment.update({
          where: { id: result.segmentId },
          data: updateData,
        });
      }
    }

    logger.info(
      {
        documentId,
        updated: results.filter(r => r.status !== 'VALIDATED').length,
      },
      'Audit results saved to database',
    );
  }
}
