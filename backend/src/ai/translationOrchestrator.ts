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
}

/**
 * Результат перевода одного сегмента
 */
export interface TranslatedSegment {
  id: string;
  target: string;
  confidence?: number;
  analysis?: string;
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
      const translatedSegments = this.parseTranslationResponse(
        response.outputText,
        segments,
      );

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
