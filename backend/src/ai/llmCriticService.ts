/**
 * LlmCriticService: сервис для оценки качества переводов с использованием LLM и DNA
 * 
 * Основные возможности:
 * - Интеграция с Document DNA (abbreviationLogic и validationHints)
 * - Модель-агностичный подход через Registry
 * - Строгая проверка терминов по глоссарию
 * - Проверка стиля на основе validationHints
 * - Поиск типичных ошибок (пропуски цифр, неверные единицы измерения)
 */

import { logger } from '../utils/logger';
import { getProvider } from './providers/registry';
import { getLanguageName } from '../utils/languages';
import type { DocumentDnaPayload, ValidationHints } from './types';
import type { ProviderUsage } from './providers/types';

/**
 * Интерфейс для результата критики
 */
export interface CriticReview {
  errors: CriticError[];
  warnings: CriticWarning[];
  score: number; // 0-100, где 100 = идеальный перевод
  reasoning: string;
  modelUsed: string;
  usage?: ProviderUsage;
}

/**
 * Ошибка критики
 */
export interface CriticError {
  type: 'glossary' | 'style' | 'formatting' | 'omission' | 'unit' | 'other';
  term?: string; // Термин из source, который вызвал ошибку
  expected?: string; // Ожидаемый термин из глоссария
  found?: string; // Найденный термин в переводе
  context?: string; // Контекст ошибки (3-4 слова из перевода)
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  suggestion?: string; // Предложение по исправлению
}

/**
 * Предупреждение критики
 */
export interface CriticWarning {
  type: 'style' | 'consistency' | 'naturalness' | 'other';
  message: string;
  suggestion?: string;
}

/**
 * Опции для критики
 */
export interface CriticOptions {
  provider?: 'gemini' | 'openai' | 'yandex' | 'deepseek' | 'claude';
  model?: string;
  apiKey?: string;
  yandexFolderId?: string;
  sourceLocale: string;
  targetLocale: string;
  maxTokens?: number;
  temperature?: number;
  dna?: {
    abbreviationLogic?: Record<string, unknown> | null;
    validationHints?: ValidationHints | null;
  } | null;
}

/**
 * LlmCriticService: сервис для оценки качества переводов
 */
export class LlmCriticService {
  /**
   * Выполнить критику перевода
   */
  async review(
    sourceText: string,
    targetText: string,
    options: CriticOptions,
  ): Promise<CriticReview> {
    const provider = getProvider(
      options.provider,
      options.apiKey,
      options.yandexFolderId,
    );

    // Выбор модели: по умолчанию Gemini Pro, но можно переопределить
    let model = options.model || provider.defaultModel;

    // Для Gemini Flash моделей переключаемся на более стабильную модель для критики
    if (provider.name === 'gemini') {
      const modelLower = (model || '').toLowerCase();
      const isFlashModel = modelLower.includes('flash');
      const isGeminiPro = modelLower === 'gemini-pro' || 
        (modelLower.includes('gemini-pro') && !modelLower.includes('2.5-pro'));
      const isAlready25Pro = modelLower.includes('2.5-pro') && !isFlashModel;

      if ((isFlashModel || isGeminiPro) && !isAlready25Pro) {
        logger.warn(
          { originalModel: model, fallbackModel: 'gemini-2.5-pro' },
          'Switching to gemini-2.5-pro for critic workflow',
        );
        model = 'gemini-2.5-pro';
      }
    }

    logger.info(
      {
        provider: provider.name,
        model,
        sourceLength: sourceText.length,
        targetLength: targetText.length,
        hasDna: !!options.dna,
      },
      'Starting LLM critique',
    );

    // Построение промпта
    const systemPrompt = this.buildSystemPrompt(options);
    const userPrompt = this.buildUserPrompt(sourceText, targetText, options);

    // Вызов LLM
    const maxTokens = options.maxTokens || 8192; // Критика требует больше токенов
    const temperature = options.temperature ?? 0.3; // Низкая температура для стабильности

    try {
      const response = await provider.callModel({
        prompt: userPrompt,
        systemPrompt,
        model,
        temperature,
        maxTokens,
        segments: [], // Критика работает с отдельными текстами, не сегментами
      });

      // Парсинг ответа
      const review = this.parseResponse(response.outputText, model, response.usage);

      logger.info(
        {
          errors: review.errors.length,
          warnings: review.warnings.length,
          score: review.score,
        },
        'LLM critique completed',
      );

      return review;
    } catch (error: any) {
      logger.error(
        { error: error.message, provider: provider.name, model },
        'LLM critique failed',
      );

      // Возвращаем пустой результат при ошибке
      return {
        errors: [
          {
            type: 'other',
            severity: 'medium',
            message: `Critique failed: ${error.message}`,
          },
        ],
        warnings: [],
        score: 0,
        reasoning: 'Critique service encountered an error',
        modelUsed: model,
      };
    }
  }

  /**
   * Построение системного промпта для критика
   */
  private buildSystemPrompt(options: CriticOptions): string {
    const sourceLang = getLanguageName(options.sourceLocale);
    const targetLang = getLanguageName(options.targetLocale);

    const prompt = [
      'You are a Senior Technical QA Linguist and Editor. Your role is to act as a strict quality control specialist for technical translations.',
      '',
      '=== YOUR MISSION ===',
      `You evaluate translations from ${sourceLang} to ${targetLang}.`,
      'You must catch CRITICAL errors while allowing for natural language variations.',
      '',
      '=== TRANSLATION DIRECTION ===',
      `Source language: ${sourceLang}`,
      `Target language: ${targetLang}`,
      '',
      'CRITICAL UNDERSTANDING:',
      `- Source text is in ${sourceLang} (ORIGINAL)`,
      `- Target text is a TRANSLATION into ${targetLang}`,
      `- You check if the Target correctly uses ${targetLang} terms from the glossary`,
      '',
    ];

    // Добавляем секцию DNA Glossary если есть
    if (options.dna?.abbreviationLogic) {
      prompt.push(
        '=== DNA GLOSSARY (CRITICAL) ===',
        'The following glossary terms MUST be used correctly in the translation:',
        this.buildGlossarySection(options.dna.abbreviationLogic, sourceLang, targetLang),
        '',
        'GLOSSARY RULES:',
        `- Terms in Source (${sourceLang}) must be translated to their exact Target (${targetLang}) equivalents`,
        '- Check for exact term matches (case-insensitive, allowing morphological variations)',
        '- Report errors if wrong terms are used',
        '- Report missing terms if glossary terms appear in source but not in target',
        '',
      );
    }

    // Добавляем секцию Validation Hints если есть
    if (options.dna?.validationHints) {
      prompt.push(
        '=== STYLE RULES (from DNA Validation Hints) ===',
        this.buildStyleRulesSection(options.dna.validationHints),
        '',
      );
    }

    prompt.push(
      '=== COMMON ERROR PATTERNS ===',
      '1. GLOSSARY VIOLATIONS:',
      '   - Using wrong term instead of glossary term',
      '   - Missing glossary term that appears in source',
      '   - Using source language term in target (wrong language)',
      '',
      '2. FORMATTING ERRORS:',
      '   - Missing numbers or dates',
      '   - Incorrect units of measurement',
      '   - Broken formatting tags',
      '',
      '3. STYLE VIOLATIONS:',
      '   - Not following style rules from validation hints',
      '   - Inconsistent terminology',
      '',
      '4. OMISSIONS:',
      '   - Missing important information',
      '   - Skipped technical terms',
      '',
      '=== OUTPUT FORMAT ===',
      'Return a JSON object with this structure:',
      '{',
      '  "errors": [',
      '    {',
      '      "type": "glossary" | "style" | "formatting" | "omission" | "unit" | "other",',
      '      "term": "source term (if applicable)",',
      '      "expected": "expected term from glossary",',
      '      "found": "actual term found in translation",',
      '      "context": "3-4 words of context from translation",',
      '      "severity": "critical" | "high" | "medium" | "low",',
      '      "message": "description of the error",',
      '      "suggestion": "suggested fix (optional)"',
      '    }',
      '  ],',
      '  "warnings": [',
      '    {',
      '      "type": "style" | "consistency" | "naturalness" | "other",',
      '      "message": "warning description",',
      '      "suggestion": "suggestion (optional)"',
      '    }',
      '  ],',
      '  "score": 85,',
      '  "reasoning": "brief explanation of the review"',
      '}',
      '',
      'IMPORTANT:',
      '- Return ONLY valid JSON (no markdown, no code blocks)',
      '- Score: 100 = perfect, 0 = completely wrong',
      '- Be strict with glossary violations (critical/high severity)',
      '- Be lenient with minor style variations (low severity or warnings)',
      '- If no errors found, return empty errors array and score 90-100',
    );

    return prompt.join('\n');
  }

  /**
   * Построение пользовательского промпта
   */
  private buildUserPrompt(
    sourceText: string,
    targetText: string,
    options: CriticOptions,
  ): string {
    const sourceLang = getLanguageName(options.sourceLocale);
    const targetLang = getLanguageName(options.targetLocale);

    return [
      '=== TEXTS TO REVIEW ===',
      '',
      `Source (${sourceLang}):`,
      `"${this.escapeJson(sourceText)}"`,
      '',
      `Target (${targetLang}):`,
      `"${this.escapeJson(targetText)}"`,
      '',
      '=== YOUR TASK ===',
      `Review the Target translation for correctness, glossary compliance, and style adherence.`,
      '',
      'Check:',
      '1. All glossary terms from source are correctly translated',
      '2. No source language terms appear in target',
      '3. Style rules are followed',
      '4. No formatting errors (numbers, units, tags)',
      '5. No omissions of important information',
      '',
      'Return your review as JSON.',
    ].join('\n');
  }

  /**
   * Построение секции глоссария из abbreviationLogic
   */
  private buildGlossarySection(
    abbreviationLogic: Record<string, unknown>,
    sourceLang: string,
    targetLang: string,
  ): string {
    const entries: string[] = [];

    for (const [key, value] of Object.entries(abbreviationLogic)) {
      if (!value || typeof value !== 'object') continue;

      const entry = value as Record<string, unknown>;
      const longForm = entry.longForm || entry.value || key;
      const shortForm = entry.shortForm || longForm;

      let entryText = `"${key}" (${sourceLang}) → `;
      
      if (typeof longForm === 'string' && typeof shortForm === 'string' && longForm !== shortForm) {
        entryText += `"${longForm}" (long) / "${shortForm}" (short) (${targetLang})`;
      } else {
        const term = typeof longForm === 'string' ? longForm : String(value);
        entryText += `"${term}" (${targetLang})`;
      }

      if (Array.isArray(entry.aliases) && entry.aliases.length > 0) {
        entryText += ` [aliases: ${entry.aliases.join(', ')}]`;
      }

      entries.push(entryText);
    }

    if (entries.length === 0) {
      return 'No glossary terms provided.';
    }

    return entries.join('\n');
  }

  /**
   * Построение секции стилевых правил из validationHints
   */
  private buildStyleRulesSection(validationHints: ValidationHints): string {
    const sections: string[] = [];

    if (validationHints.rules && validationHints.rules.length > 0) {
      sections.push('STYLE RULES:');
      for (const rule of validationHints.rules) {
        let ruleText = `- "${rule.term}": ${rule.rule}`;
        if (rule.context) {
          ruleText += ` (context: ${rule.context})`;
        }
        if (rule.example) {
          ruleText += `\n  Example: ${rule.example}`;
        }
        sections.push(ruleText);
      }
    }

    if (validationHints.warnings && validationHints.warnings.length > 0) {
      sections.push('\nWARNINGS:');
      for (const warning of validationHints.warnings) {
        sections.push(`- "${warning.term}": ${warning.message}`);
      }
    }

    if (validationHints.notes && validationHints.notes.length > 0) {
      sections.push('\nNOTES:');
      for (const note of validationHints.notes) {
        sections.push(`- ${note}`);
      }
    }

    return sections.length > 0 ? sections.join('\n') : 'No style rules provided.';
  }

  /**
   * Парсинг ответа от LLM
   */
  private parseResponse(
    responseText: string,
    model: string,
    usage?: ProviderUsage,
  ): CriticReview {
    // Удаляем markdown code blocks если есть
    let cleanedText = responseText
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim();

    // Пытаемся найти JSON в ответе
    const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleanedText = jsonMatch[0];
    }

    try {
      const parsed = JSON.parse(cleanedText);

      // Валидация и нормализация структуры
      const errors: CriticError[] = Array.isArray(parsed.errors)
        ? parsed.errors.map((e: any) => ({
            type: e.type || 'other',
            term: e.term,
            expected: e.expected,
            found: e.found,
            context: e.context,
            severity: e.severity || 'medium',
            message: e.message || 'Error found',
            suggestion: e.suggestion,
          }))
        : [];

      const warnings: CriticWarning[] = Array.isArray(parsed.warnings)
        ? parsed.warnings.map((w: any) => ({
            type: w.type || 'other',
            message: w.message || 'Warning',
            suggestion: w.suggestion,
          }))
        : [];

      const score = typeof parsed.score === 'number'
        ? Math.max(0, Math.min(100, parsed.score))
        : errors.length === 0 ? 90 : Math.max(0, 100 - errors.length * 10);

      const reasoning = typeof parsed.reasoning === 'string'
        ? parsed.reasoning
        : errors.length === 0
          ? 'Translation passed all checks'
          : `Found ${errors.length} error(s) and ${warnings.length} warning(s)`;

      return {
        errors,
        warnings,
        score,
        reasoning,
        modelUsed: model,
        usage,
      };
    } catch (error: any) {
      logger.warn(
        { error: error.message, responsePreview: cleanedText.substring(0, 200) },
        'Failed to parse critic response, returning default',
      );

      // Возвращаем результат с ошибкой парсинга
      return {
        errors: [
          {
            type: 'other',
            severity: 'medium',
            message: 'Failed to parse critic response',
          },
        ],
        warnings: [],
        score: 0,
        reasoning: 'Critic response parsing failed',
        modelUsed: model,
        usage,
      };
    }
  }

  /**
   * Экранирование JSON строк
   */
  private escapeJson(text: string): string {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  }
}
