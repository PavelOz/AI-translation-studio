/**
 * TranslationOrchestrator: массовый перевод с использованием синтезированной DNA
 * 
 * Основные возможности:
 * - Contextual DNA Filtering: фильтрация DNA по релевантности к сегментам
 * - Agnostic Batch Translation: поддержка любых моделей через ModelCapabilities
 * - DNA-Injected Prompt Template: динамические промпты с GLOSSARY и STYLE_RULES
 * - Model-Specific Optimization: использование systemInstructions где возможно
 * - Reliability: интеграция callModelWithRetry для защиты от сбоев
 */

import { logger } from '../utils/logger';
import { getProvider } from './providers/registry';
import { LlmCriticService } from './llmCriticService';
import type {
  OrchestratorSegment,
  DocumentDnaPayload,
  ValidationHints,
} from './types';
import type { ModelCapabilities } from './providers/types';

/**
 * Опции для массового перевода
 */
export interface BatchTranslationOptions {
  provider: 'gemini' | 'openai' | 'yandex' | 'deepseek' | 'claude';
  model?: string;
  apiKey?: string;
  yandexFolderId?: string;
  temperature?: number;
  maxTokens?: number;
  dna?: DocumentDnaPayload | null;
  sourceLocale: string;
  targetLocale: string;
  documentName?: string;
  documentSummary?: string;
  onProgress?: (progress: { current: number; total: number; batch: number; totalBatches: number }) => void;
  autoCorrect?: boolean; // Enable self-correction loop with LlmCriticService
  minQualityScore?: number; // Minimum quality score (0-100) to trigger correction, default: 85
}

/**
 * Результат перевода одного сегмента
 */
export interface TranslatedSegment {
  id: string;
  target: string;
  confidence?: number;
  analysis?: string;
  // Self-correction metadata
  autoCorrected?: boolean; // Was this segment auto-corrected?
  correctionAttempts?: number; // Number of correction attempts (0 = no correction needed)
  finalCriticScore?: number; // Final quality score from critic (0-100)
  requiresReview?: boolean; // Should be reviewed by Janitor (score still low after correction)
  criticReview?: {
    errors: number;
    warnings: number;
    reasoning?: string;
  };
}

/**
 * Результат батч-перевода
 */
export interface BatchTranslationResult {
  segments: TranslatedSegment[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
  errors?: Array<{ segmentId: string; error: string }>;
}

/**
 * Релевантная DNA для сегментов
 */
interface RelevantDna {
  abbreviationLogic: Record<string, unknown>;
  validationHints: ValidationHints | null;
  relevantTerms: string[]; // Ключи терминов, которые были найдены в сегментах
}

/**
 * TranslationOrchestrator: оркестратор массового перевода с DNA
 */
export class TranslationOrchestrator {
  /**
   * Contextual DNA Filtering
   * Анализирует текст сегментов и возвращает только релевантные записи из DNA
   */
  getRelevantDna(
    segments: OrchestratorSegment[],
    dna: DocumentDnaPayload | null | undefined,
  ): RelevantDna {
    if (!dna?.abbreviationLogic || typeof dna.abbreviationLogic !== 'object') {
      return {
        abbreviationLogic: {},
        validationHints: dna?.validationHints || null,
        relevantTerms: [],
      };
    }

    // Объединяем весь текст сегментов для анализа
    const combinedText = segments
      .map(s => s.sourceText)
      .join(' ')
      .toLowerCase();

    const relevantLogic: Record<string, unknown> = {};
    const relevantTerms: string[] = [];

    // Проходим по всем терминам в abbreviationLogic
    for (const [key, value] of Object.entries(dna.abbreviationLogic)) {
      // Проверяем, встречается ли ключ или его вариации в тексте
      const keyLower = key.toLowerCase();
      const keyWords = keyLower.split(/\s+/);
      
      // Проверяем прямое вхождение ключа
      if (combinedText.includes(keyLower)) {
        relevantLogic[key] = value;
        relevantTerms.push(key);
        continue;
      }

      // Проверяем вхождение отдельных слов ключа
      const keyWordsFound = keyWords.filter(word => 
        word.length > 3 && combinedText.includes(word)
      );
      if (keyWordsFound.length >= Math.min(2, keyWords.length)) {
        relevantLogic[key] = value;
        relevantTerms.push(key);
        continue;
      }

      // Проверяем shortForm и aliases
      if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const shortForm = obj.shortForm;
        const aliases = obj.aliases;

        if (typeof shortForm === 'string' && combinedText.includes(shortForm.toLowerCase())) {
          relevantLogic[key] = value;
          relevantTerms.push(key);
          continue;
        }

        if (Array.isArray(aliases)) {
          const aliasFound = aliases.some(alias => {
            if (typeof alias === 'string') {
              return combinedText.includes(alias.toLowerCase());
            }
            return false;
          });
          if (aliasFound) {
            relevantLogic[key] = value;
            relevantTerms.push(key);
            continue;
          }
        }
      }

      // Проверяем longForm
      if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const longForm = obj.longForm;
        if (typeof longForm === 'string' && combinedText.includes(longForm.toLowerCase())) {
          relevantLogic[key] = value;
          relevantTerms.push(key);
        }
      }
    }

    logger.info(
      {
        totalTerms: Object.keys(dna.abbreviationLogic).length,
        relevantTerms: relevantTerms.length,
        segmentsCount: segments.length,
      },
      'DNA filtered by relevance',
    );

    return {
      abbreviationLogic: relevantLogic,
      validationHints: dna.validationHints || null,
      relevantTerms,
    };
  }

  /**
   * Формирование GLOSSARY секции из релевантной DNA
   */
  private buildGlossarySection(relevantDna: RelevantDna): string {
    const { abbreviationLogic } = relevantDna;
    
    if (Object.keys(abbreviationLogic).length === 0) {
      return '';
    }

    const glossaryEntries: string[] = [];

    for (const [key, value] of Object.entries(abbreviationLogic)) {
      let entry = '';
      
      if (typeof value === 'string') {
        entry = `"${key}" → "${value}"`;
      } else if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const longForm = obj.longForm;
        const shortForm = obj.shortForm;
        const aliases = obj.aliases;

        if (longForm && shortForm) {
          entry = `"${key}" → "${longForm}" (abbr: ${shortForm})`;
        } else if (longForm) {
          entry = `"${key}" → "${longForm}"`;
        } else if (shortForm) {
          entry = `"${key}" → "${shortForm}"`;
        } else {
          entry = `"${key}" → "${JSON.stringify(value)}"`;
        }

        if (Array.isArray(aliases) && aliases.length > 0) {
          const aliasList = aliases.filter(a => typeof a === 'string').join(', ');
          entry += ` [aliases: ${aliasList}]`;
        }
      }

      if (entry) {
        glossaryEntries.push(entry);
      }
    }

    if (glossaryEntries.length === 0) {
      return '';
    }

    return `[GLOSSARY]
${glossaryEntries.join('\n')}`;
  }

  /**
   * Формирование STYLE_RULES секции из validationHints
   */
  private buildStyleRulesSection(validationHints: ValidationHints | null): string {
    if (!validationHints) {
      return '';
    }

    const rules: string[] = [];
    const warnings: string[] = [];

    if (validationHints.rules && validationHints.rules.length > 0) {
      for (const rule of validationHints.rules) {
        let ruleText = `- "${rule.term}": ${rule.rule}`;
        if (rule.context) {
          ruleText += ` (context: ${rule.context})`;
        }
        if (rule.example) {
          ruleText += `\n  Example: ${rule.example}`;
        }
        rules.push(ruleText);
      }
    }

    if (validationHints.warnings && validationHints.warnings.length > 0) {
      for (const warning of validationHints.warnings) {
        warnings.push(`- "${warning.term}": ${warning.message}`);
      }
    }

    if (rules.length === 0 && warnings.length === 0) {
      return '';
    }

    const sections: string[] = [];
    if (rules.length > 0) {
      sections.push(`[STYLE_RULES]\n${rules.join('\n')}`);
    }
    if (warnings.length > 0) {
      sections.push(`[WARNINGS]\n${warnings.join('\n')}`);
    }

    return sections.join('\n\n');
  }

  /**
   * Построение системного промпта с DNA
   */
  private buildSystemPrompt(
    relevantDna: RelevantDna,
    sourceLocale: string,
    targetLocale: string,
    supportsSystemInstructions: boolean,
  ): string {
    const glossarySection = this.buildGlossarySection(relevantDna);
    const styleRulesSection = this.buildStyleRulesSection(relevantDna.validationHints);

    let systemPrompt = `You are a professional technical translator. Translate from ${sourceLocale} to ${targetLocale}.

CRITICAL REQUIREMENTS:
1. Follow the translation direction: FROM ${sourceLocale} TO ${targetLocale}
2. Your output MUST be in ${targetLocale} only
3. Return translations in strict JSON format: [{"id": "segment_id", "target": "translated_text"}]
4. Preserve technical terminology and formatting
5. Maintain consistency with provided glossary terms`;

    if (glossarySection) {
      if (supportsSystemInstructions) {
        systemPrompt += `\n\n${glossarySection}`;
      } else {
        // Если не поддерживает systemInstructions, добавим в user prompt
        systemPrompt += `\n\nIMPORTANT: Use the glossary terms provided in the user prompt.`;
      }
    }

    if (styleRulesSection) {
      if (supportsSystemInstructions) {
        systemPrompt += `\n\n${styleRulesSection}`;
      } else {
        systemPrompt += `\n\nIMPORTANT: Follow the style rules provided in the user prompt.`;
      }
    }

    return systemPrompt;
  }

  /**
   * Построение пользовательского промпта с DNA
   */
  private buildUserPrompt(
    segments: OrchestratorSegment[],
    relevantDna: RelevantDna,
    sourceLocale: string,
    targetLocale: string,
    documentName?: string,
    documentSummary?: string,
    supportsSystemInstructions: boolean,
  ): string {
    const glossarySection = this.buildGlossarySection(relevantDna);
    const styleRulesSection = this.buildStyleRulesSection(relevantDna.validationHints);

    let prompt = `Translate the following segments from ${sourceLocale} to ${targetLocale}.`;

    if (documentName) {
      prompt += `\nDocument: ${documentName}`;
    }

    if (documentSummary) {
      prompt += `\nDocument Summary: ${documentSummary}`;
    }

    // Если модель не поддерживает systemInstructions, включаем DNA в user prompt
    if (!supportsSystemInstructions) {
      if (glossarySection) {
        prompt += `\n\n${glossarySection}`;
      }
      if (styleRulesSection) {
        prompt += `\n\n${styleRulesSection}`;
      }
    }

    prompt += `\n\nSegments to translate:\n`;

    // Формируем список сегментов
    const segmentsList = segments.map((seg, index) => {
      let segmentText = `${index + 1}. [ID: ${seg.segmentId}] ${seg.sourceText}`;
      
      // Добавляем контекст если есть
      if (seg.previousText) {
        segmentText += `\n   [Previous: ${seg.previousText.substring(0, 100)}...]`;
      }
      if (seg.nextText) {
        segmentText += `\n   [Next: ${seg.nextText.substring(0, 100)}...]`;
      }
      
      return segmentText;
    }).join('\n\n');

    prompt += segmentsList;

    prompt += `\n\nReturn ONLY a JSON array in this exact format:
[
  {"id": "segment_id_1", "target": "translated text 1"},
  {"id": "segment_id_2", "target": "translated text 2"}
]

Do not include any markdown, explanations, or additional text. Only the JSON array.`;

    return prompt;
  }

  /**
   * Проверка поддержки systemInstructions провайдером
   */
  private supportsSystemInstructions(providerName: string): boolean {
    // Gemini поддерживает systemInstructions через systemInstruction в API
    // OpenAI поддерживает через messages с role: 'system'
    // Yandex поддерживает через messages с role: 'system'
    // DeepSeek поддерживает через messages с role: 'system'
    return ['gemini', 'openai', 'yandex', 'deepseek'].includes(providerName.toLowerCase());
  }

  /**
   * Agnostic Batch Translation
   * Использует ModelCapabilities для определения оптимального размера батча
   */
  async translateBatch(
    segments: OrchestratorSegment[],
    options: BatchTranslationOptions,
  ): Promise<BatchTranslationResult> {
    const provider = getProvider(
      options.provider,
      options.apiKey,
      options.yandexFolderId,
    );

    const model = options.model || provider.defaultModel;
    const capabilities = provider.getCapabilities(model);

    // Определяем размер батча на основе возможностей модели
    // Учитываем, что промпт будет содержать DNA, поэтому уменьшаем размер батча
    const baseBatchSize = capabilities.maxBatchSize;
    const dnaOverhead = options.dna ? 0.7 : 1.0; // DNA занимает ~30% контекста
    const optimalBatchSize = Math.max(1, Math.floor(baseBatchSize * dnaOverhead));

    logger.info(
      {
        provider: options.provider,
        model,
        maxBatchSize: capabilities.maxBatchSize,
        optimalBatchSize,
        totalSegments: segments.length,
        hasDna: !!options.dna,
      },
      'Batch translation configuration',
    );

    // Фильтруем релевантную DNA
    const relevantDna = this.getRelevantDna(segments, options.dna || null);

    // Проверяем поддержку systemInstructions
    const supportsSystemInstructions = this.supportsSystemInstructions(options.provider);

    // Формируем промпты
    const systemPrompt = this.buildSystemPrompt(
      relevantDna,
      options.sourceLocale,
      options.targetLocale,
      supportsSystemInstructions,
    );

    const userPrompt = this.buildUserPrompt(
      segments,
      relevantDna,
      options.sourceLocale,
      options.targetLocale,
      options.documentName,
      options.documentSummary,
      supportsSystemInstructions,
    );

    // Выполняем перевод с retry
    try {
      const response = await (provider as any).callModelWithRetry(
        {
          prompt: userPrompt,
          systemPrompt: supportsSystemInstructions ? systemPrompt : undefined,
          model,
          temperature: options.temperature ?? 0.2,
          maxTokens: options.maxTokens ?? 2048,
          segments: segments.map(s => ({
            segmentId: s.segmentId,
            sourceText: s.sourceText,
          })),
        },
        {
          maxRetries: 3,
          onRetry: (attempt, delay, error) => {
            logger.warn(
              {
                attempt,
                delay,
                error: error.message,
                batchSize: segments.length,
              },
              'Retrying batch translation',
            );
          },
        },
      );

      // Парсим ответ
      let translatedSegments = this.parseTranslationResponse(
        response.outputText,
        segments,
      );

      // Self-Correction Loop: проверка качества и автокоррекция
      if (options.autoCorrect) {
        translatedSegments = await this.applySelfCorrection(
          segments,
          translatedSegments,
          options,
          relevantDna,
        );
      }

      return {
        segments: translatedSegments,
        usage: response.usage,
      };
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          segmentsCount: segments.length,
          provider: options.provider,
          model,
        },
        'Batch translation failed',
      );

      return {
        segments: [],
        errors: segments.map(s => ({
          segmentId: s.segmentId,
          error: error instanceof Error ? error.message : 'Unknown error',
        })),
      };
    }
  }

  /**
   * Парсинг ответа LLM в формат TranslatedSegment
   */
  private parseTranslationResponse(
    responseText: string,
    originalSegments: OrchestratorSegment[],
  ): TranslatedSegment[] {
    try {
      // Очистка ответа от markdown
      let cleaned = responseText
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      // Находим JSON массив
      const jsonStart = cleaned.indexOf('[');
      const jsonEnd = cleaned.lastIndexOf(']') + 1;
      
      if (jsonStart === -1 || jsonEnd === 0) {
        throw new Error('No JSON array found in response');
      }

      cleaned = cleaned.substring(jsonStart, jsonEnd);
      const parsed = JSON.parse(cleaned);

      if (!Array.isArray(parsed)) {
        throw new Error('Response is not an array');
      }

      // Создаем мапу для быстрого поиска
      const resultMap = new Map<string, TranslatedSegment>();
      
      for (const item of parsed) {
        if (item.id && item.target) {
          resultMap.set(item.id, {
            id: item.id,
            target: item.target,
            confidence: item.confidence,
            analysis: item.analysis,
          });
        }
      }

      // Сопоставляем с оригинальными сегментами
      const results: TranslatedSegment[] = [];
      
      for (const segment of originalSegments) {
        const translated = resultMap.get(segment.segmentId);
        if (translated) {
          results.push(translated);
        } else {
          // Fallback: если перевод не найден, возвращаем исходный текст
          logger.warn(
            { segmentId: segment.segmentId },
            'Translation not found in response, using source text',
          );
          results.push({
            id: segment.segmentId,
            target: segment.sourceText,
          });
        }
      }

      return results;
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          responsePreview: responseText.substring(0, 500),
        },
        'Failed to parse translation response',
      );

      // Fallback: возвращаем исходные тексты
      return originalSegments.map(s => ({
        id: s.segmentId,
        target: s.sourceText,
      }));
    }
  }

  /**
   * Self-Correction Loop: проверка качества через LlmCriticService и автокоррекция
   */
  private async applySelfCorrection(
    originalSegments: OrchestratorSegment[],
    initialTranslations: TranslatedSegment[],
    options: BatchTranslationOptions,
    relevantDna: RelevantDna,
  ): Promise<TranslatedSegment[]> {
    const minQualityScore = options.minQualityScore ?? 85;
    const criticService = new LlmCriticService();
    const correctedSegments: TranslatedSegment[] = [];

    logger.info(
      {
        segmentsCount: originalSegments.length,
        minQualityScore,
      },
      'Starting self-correction loop',
    );

    for (let i = 0; i < originalSegments.length; i++) {
      const segment = originalSegments[i];
      let translation = initialTranslations[i];
      let correctionAttempts = 0;
      let finalScore = 100;
      let requiresReview = false;

      // Проверяем качество перевода
      const criticReview = await criticService.review(
        segment.sourceText,
        translation.target,
        {
          provider: options.provider,
          model: options.model,
          apiKey: options.apiKey,
          yandexFolderId: options.yandexFolderId,
          sourceLocale: options.sourceLocale,
          targetLocale: options.targetLocale,
          maxTokens: Math.max(options.maxTokens ?? 2048, 8192),
          temperature: 0.3,
          dna: {
            abbreviationLogic: relevantDna.abbreviationLogic || null,
            validationHints: relevantDna.validationHints || null,
          },
        },
      );

      finalScore = criticReview.score;
      const hasCriticalErrors = criticReview.errors.some(
        e => e.severity === 'critical' || e.severity === 'high',
      );
      const isAcceptable = criticReview.score >= minQualityScore && !hasCriticalErrors;

      // Если качество низкое - выполняем одну попытку исправления
      if (!isAcceptable && correctionAttempts < 1) {
        logger.info(
          {
            segmentId: segment.segmentId,
            initialScore: criticReview.score,
            errors: criticReview.errors.length,
            hasCriticalErrors,
          },
          'Translation quality below threshold, attempting correction',
        );

        // Формируем промпт для исправления
        const correctionPrompt = this.buildCorrectionPrompt(
          segment,
          translation.target,
          criticReview,
          relevantDna,
          options,
        );

        try {
          const provider = getProvider(
            options.provider,
            options.apiKey,
            options.yandexFolderId,
          );
          const model = options.model || provider.defaultModel;
          const supportsSystemInstructions = this.supportsSystemInstructions(options.provider);

          const systemPrompt = this.buildSystemPrompt(
            relevantDna,
            options.sourceLocale,
            options.targetLocale,
            supportsSystemInstructions,
          );

          const correctionResponse = await (provider as any).callModelWithRetry(
            {
              prompt: correctionPrompt,
              systemPrompt: supportsSystemInstructions ? systemPrompt : undefined,
              model,
              temperature: (options.temperature ?? 0.2) * 0.8,
              maxTokens: options.maxTokens ?? 2048,
              segments: [{
                segmentId: segment.segmentId,
                sourceText: segment.sourceText,
              }],
            },
            {
              maxRetries: 2,
              onRetry: (attempt, delay, error) => {
                logger.warn(
                  { attempt, delay, error: error.message, segmentId: segment.segmentId },
                  'Retrying correction',
                );
              },
            },
          );

          // Парсим исправленный перевод
          const correctedResults = this.parseTranslationResponse(
            correctionResponse.outputText,
            [segment],
          );

          if (correctedResults.length > 0) {
            translation = correctedResults[0];
            correctionAttempts = 1;

            // Проверяем качество исправленного перевода
            const secondReview = await criticService.review(
              segment.sourceText,
              translation.target,
              {
                provider: options.provider,
                model: options.model,
                apiKey: options.apiKey,
                yandexFolderId: options.yandexFolderId,
                sourceLocale: options.sourceLocale,
                targetLocale: options.targetLocale,
                maxTokens: Math.max(options.maxTokens ?? 2048, 8192),
                temperature: 0.3,
                dna: {
                  abbreviationLogic: relevantDna.abbreviationLogic || null,
                  validationHints: relevantDna.validationHints || null,
                },
              },
            );

            finalScore = secondReview.score;
            const stillHasCriticalErrors = secondReview.errors.some(
              e => e.severity === 'critical' || e.severity === 'high',
            );

            // Если после исправления качество все еще низкое - помечаем для ревью
            if (secondReview.score < minQualityScore || stillHasCriticalErrors) {
              requiresReview = true;
              logger.warn(
                {
                  segmentId: segment.segmentId,
                  finalScore: secondReview.score,
                  errors: secondReview.errors.length,
                },
                'Translation still requires review after correction',
              );
            } else {
              logger.info(
                {
                  segmentId: segment.segmentId,
                  initialScore: criticReview.score,
                  finalScore: secondReview.score,
                },
                'Translation improved after correction',
              );
            }

            translation.criticReview = {
              errors: secondReview.errors.length,
              warnings: secondReview.warnings.length,
              reasoning: secondReview.reasoning,
            };
          }
        } catch (error) {
          logger.error(
            {
              error: error instanceof Error ? error.message : String(error),
              segmentId: segment.segmentId,
            },
            'Correction attempt failed, using original translation',
          );
          translation.criticReview = {
            errors: criticReview.errors.length,
            warnings: criticReview.warnings.length,
            reasoning: criticReview.reasoning,
          };
        }
      } else {
        translation.criticReview = {
          errors: criticReview.errors.length,
          warnings: criticReview.warnings.length,
          reasoning: criticReview.reasoning,
        };
      }

      // Добавляем метаданные
      translation.autoCorrected = correctionAttempts > 0;
      translation.correctionAttempts = correctionAttempts;
      translation.finalCriticScore = finalScore;
      translation.requiresReview = requiresReview;
      translation.confidence = finalScore / 100;

      correctedSegments.push(translation);
    }

    const correctedCount = correctedSegments.filter(s => s.autoCorrected).length;
    const reviewRequiredCount = correctedSegments.filter(s => s.requiresReview).length;

    logger.info(
      {
        totalSegments: originalSegments.length,
        corrected: correctedCount,
        requiresReview: reviewRequiredCount,
      },
      'Self-correction loop completed',
    );

    return correctedSegments;
  }

  /**
   * Построение промпта для исправления перевода на основе замечаний критика
   */
  private buildCorrectionPrompt(
    segment: OrchestratorSegment,
    currentTranslation: string,
    criticReview: any,
    relevantDna: RelevantDna,
    options: BatchTranslationOptions,
  ): string {
    const sourceLang = options.sourceLocale;
    const targetLang = options.targetLocale;

    const errorsList = criticReview.errors
      .map((e: any) => {
        let errorText = `- ${e.message}`;
        if (e.term) errorText += ` (term: "${e.term}")`;
        if (e.expected && e.found) {
          errorText += ` Expected: "${e.expected}", Found: "${e.found}"`;
        }
        if (e.suggestion) errorText += ` Suggestion: ${e.suggestion}`;
        return errorText;
      })
      .join('\n');

    const warningsList = criticReview.warnings
      .map((w: any) => `- ${w.message}${w.suggestion ? ` (${w.suggestion})` : ''}`)
      .join('\n');

    let prompt = `Your previous translation was reviewed and found to have quality issues.\n\n`;
    prompt += `=== ORIGINAL SOURCE TEXT (${sourceLang}) ===\n`;
    prompt += `"${segment.sourceText}"\n\n`;
    prompt += `=== YOUR PREVIOUS TRANSLATION (${targetLang}) ===\n`;
    prompt += `"${currentTranslation}"\n\n`;
    prompt += `=== QUALITY SCORE ===\n`;
    prompt += `Score: ${criticReview.score}/100\n`;
    prompt += `Reasoning: ${criticReview.reasoning}\n\n`;

    if (errorsList) {
      prompt += `=== ERRORS FOUND ===\n${errorsList}\n\n`;
    }

    if (warningsList) {
      prompt += `=== WARNINGS ===\n${warningsList}\n\n`;
    }

    prompt += `=== YOUR TASK ===\n`;
    prompt += `Translate the source text again, but this time:\n`;
    prompt += `1. Fix ALL the errors listed above\n`;
    prompt += `2. Address the warnings if possible\n`;
    prompt += `3. Ensure you use the correct glossary terms from DNA\n`;
    prompt += `4. Follow all style rules from validation hints\n`;
    prompt += `5. Maintain the same meaning and tone\n\n`;

    if (relevantDna.abbreviationLogic && Object.keys(relevantDna.abbreviationLogic).length > 0) {
      prompt += `=== RELEVANT GLOSSARY TERMS ===\n`;
      for (const [key, value] of Object.entries(relevantDna.abbreviationLogic)) {
        const entry = value as Record<string, unknown>;
        const longForm = entry.longForm || entry.value || key;
        const shortForm = entry.shortForm || longForm;
        if (typeof longForm === 'string' && typeof shortForm === 'string' && longForm !== shortForm) {
          prompt += `"${key}" → "${longForm}" (long) / "${shortForm}" (short)\n`;
        } else {
          prompt += `"${key}" → "${longForm}"\n`;
        }
      }
      prompt += `\n`;
    }

    prompt += `Return ONLY the corrected translation in ${targetLang}. Do not include explanations, just the translation text.`;

    return prompt;
  }

  /**
   * Массовый перевод всех сегментов с автоматическим батчингом
   */
  async translateAll(
    segments: OrchestratorSegment[],
    options: BatchTranslationOptions,
  ): Promise<{
    results: TranslatedSegment[];
    totalBatches: number;
    errors: Array<{ segmentId: string; error: string }>;
  }> {
    const provider = getProvider(
      options.provider,
      options.apiKey,
      options.yandexFolderId,
    );

    const model = options.model || provider.defaultModel;
    const capabilities = provider.getCapabilities(model);
    const dnaOverhead = options.dna ? 0.7 : 1.0;
    const batchSize = Math.max(1, Math.floor(capabilities.maxBatchSize * dnaOverhead));

    const totalBatches = Math.ceil(segments.length / batchSize);
    const results: TranslatedSegment[] = [];
    const errors: Array<{ segmentId: string; error: string }> = [];

    logger.info(
      {
        totalSegments: segments.length,
        batchSize,
        totalBatches,
      },
      'Starting mass translation',
    );

    // Обрабатываем батчами
    for (let i = 0; i < segments.length; i += batchSize) {
      const batch = segments.slice(i, i + batchSize);
      const batchNumber = Math.floor(i / batchSize) + 1;

      if (options.onProgress) {
        options.onProgress({
          current: i + batch.length,
          total: segments.length,
          batch: batchNumber,
          totalBatches,
        });
      }

      logger.info(
        {
          batch: batchNumber,
          totalBatches,
          batchSize: batch.length,
        },
        'Translating batch',
      );

      const batchResult = await this.translateBatch(batch, options);

      results.push(...batchResult.segments);
      
      if (batchResult.errors) {
        errors.push(...batchResult.errors);
      }

      // Задержка между батчами для избежания rate limits
      if (i + batchSize < segments.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    logger.info(
      {
        totalSegments: segments.length,
        translated: results.length,
        errors: errors.length,
        totalBatches,
      },
      'Mass translation completed',
    );

    return {
      results,
      totalBatches,
      errors,
    };
  }
}
