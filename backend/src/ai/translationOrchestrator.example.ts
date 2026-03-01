/**
 * Пример использования TranslationOrchestrator
 * 
 * Этот файл демонстрирует, как использовать TranslationOrchestrator
 * для массового перевода с синтезированной DNA
 */

import { TranslationOrchestrator } from './translationOrchestrator';
import type { OrchestratorSegment } from './types';
import type { DocumentDnaPayload } from './types';

/**
 * Пример 1: Базовый батч-перевод с DNA
 */
export async function exampleBasicBatchTranslation() {
  const orchestrator = new TranslationOrchestrator();

  // Сегменты для перевода
  const segments: OrchestratorSegment[] = [
    {
      segmentId: 'seg-1',
      sourceText: 'Наименование энергопроизводящей организации: ООО "Энерго-Плюс"',
      previousText: null,
      nextText: 'Адрес: г. Москва, ул. Ленина, д. 1',
    },
    {
      segmentId: 'seg-2',
      sourceText: 'Адрес: г. Москва, ул. Ленина, д. 1',
      previousText: 'Наименование энергопроизводящей организации: ООО "Энерго-Плюс"',
      nextText: 'Контактный телефон: +7 (495) 123-45-67',
    },
  ];

  // Синтезированная DNA
  const dna: DocumentDnaPayload = {
    abbreviationLogic: {
      'ООО "Энерго-Плюс"': {
        longForm: 'Energy Plus Limited Liability Company',
        shortForm: 'Energy Plus LLC',
        aliases: ['Энерго-Плюс', 'ЭП'],
      },
      'энергопроизводящая организация': {
        longForm: 'energy-producing organization',
        shortForm: 'EPO',
      },
    },
    validationHints: {
      rules: [
        {
          term: 'ООО',
          context: 'company names',
          rule: 'Always translate as "LLC" (Limited Liability Company)',
          example: 'ООО "Энерго-Плюс" → Energy Plus LLC',
        },
      ],
      warnings: [
        {
          term: 'энергопроизводящая организация',
          message: 'Do not confuse with "power plant" - this refers to the organization, not the facility',
        },
      ],
    },
  };

  // Опции перевода
  const options = {
    provider: 'gemini' as const,
    model: 'gemini-1.5-pro',
    apiKey: process.env.GEMINI_API_KEY,
    sourceLocale: 'ru',
    targetLocale: 'en',
    dna,
    documentName: 'Energy Plant Certification Report 2025',
    documentSummary: 'Annual certification report for energy-producing organizations',
    temperature: 0.2,
    maxTokens: 2048,
  };

  // Выполняем батч-перевод
  const result = await orchestrator.translateBatch(segments, options);

  console.log('Translated segments:', result.segments);
  console.log('Usage:', result.usage);
  
  return result;
}

/**
 * Пример 2: Массовый перевод всех сегментов с прогрессом
 */
export async function exampleMassTranslation() {
  const orchestrator = new TranslationOrchestrator();

  // Загружаем сегменты из базы данных (пример)
  const segments: OrchestratorSegment[] = [
    // ... множество сегментов
  ];

  // Загружаем DNA из базы данных
  const dna: DocumentDnaPayload | null = await loadDocumentDna('document-id');

  // Опции с callback для прогресса
  const options = {
    provider: 'gemini' as const,
    model: 'gemini-1.5-pro',
    apiKey: process.env.GEMINI_API_KEY,
    sourceLocale: 'ru',
    targetLocale: 'en',
    dna,
    onProgress: (progress: { current: number; total: number; batch: number; totalBatches: number }) => {
      console.log(
        `Progress: ${progress.current}/${progress.total} segments ` +
        `(Batch ${progress.batch}/${progress.totalBatches})`
      );
    },
  };

  // Выполняем массовый перевод
  const result = await orchestrator.translateAll(segments, options);

  console.log(`Translated ${result.results.length} segments`);
  console.log(`Errors: ${result.errors.length}`);
  console.log(`Total batches: ${result.totalBatches}`);

  return result;
}

/**
 * Пример 3: Демонстрация Contextual DNA Filtering
 */
export async function exampleDnaFiltering() {
  const orchestrator = new TranslationOrchestrator();

  // Полная DNA с множеством терминов
  const fullDna: DocumentDnaPayload = {
    abbreviationLogic: {
      'энергопроизводящая организация': {
        longForm: 'energy-producing organization',
        shortForm: 'EPO',
      },
      'тепловая электростанция': {
        longForm: 'thermal power plant',
        shortForm: 'TPP',
      },
      'гидроэлектростанция': {
        longForm: 'hydroelectric power plant',
        shortForm: 'HPP',
      },
      'атомная электростанция': {
        longForm: 'nuclear power plant',
        shortForm: 'NPP',
      },
    },
  };

  // Сегменты, которые содержат только некоторые термины
  const segments: OrchestratorSegment[] = [
    {
      segmentId: 'seg-1',
      sourceText: 'Наименование энергопроизводящей организации',
    },
    {
      segmentId: 'seg-2',
      sourceText: 'Тепловая электростанция работает в штатном режиме',
    },
  ];

  // Фильтруем релевантную DNA
  const relevantDna = orchestrator.getRelevantDna(segments, fullDna);

  console.log('Relevant terms:', relevantDna.relevantTerms);
  console.log('Filtered abbreviationLogic:', relevantDna.abbreviationLogic);
  // Вывод:
  // Relevant terms: ['энергопроизводящая организация', 'тепловая электростанция']
  // Filtered abbreviationLogic: { только релевантные термины }

  return relevantDna;
}

/**
 * Пример 4: Демонстрация формирования промпта с DNA
 */
export function examplePromptGeneration() {
  const orchestrator = new TranslationOrchestrator();

  const segments: OrchestratorSegment[] = [
    {
      segmentId: 'seg-1',
      sourceText: 'ООО "Энерго-Плюс" является энергопроизводящей организацией',
    },
  ];

  const relevantDna = {
    abbreviationLogic: {
      'ООО "Энерго-Плюс"': {
        longForm: 'Energy Plus LLC',
        shortForm: 'Energy Plus LLC',
      },
      'энергопроизводящая организация': {
        longForm: 'energy-producing organization',
        shortForm: 'EPO',
      },
    },
    validationHints: {
      rules: [
        {
          term: 'ООО',
          context: 'company names',
          rule: 'Always translate as "LLC"',
          example: 'ООО "Энерго-Плюс" → Energy Plus LLC',
        },
      ],
    },
    relevantTerms: ['ООО "Энерго-Плюс"', 'энергопроизводящая организация'],
  };

  // Формируем системный промпт
  const systemPrompt = orchestrator['buildSystemPrompt'](
    relevantDna,
    'ru',
    'en',
    true, // supportsSystemInstructions
  );

  // Формируем пользовательский промпт
  const userPrompt = orchestrator['buildUserPrompt'](
    segments,
    relevantDna,
    'ru',
    'en',
    'Test Document',
    undefined,
    true,
  );

  console.log('=== SYSTEM PROMPT ===');
  console.log(systemPrompt);
  console.log('\n=== USER PROMPT ===');
  console.log(userPrompt);

  // Пример вывода:
  // === SYSTEM PROMPT ===
  // You are a professional technical translator. Translate from ru to en.
  // 
  // [GLOSSARY]
  // "ООО "Энерго-Плюс"" → "Energy Plus LLC" (abbr: Energy Plus LLC)
  // "энергопроизводящая организация" → "energy-producing organization" (abbr: EPO)
  // 
  // [STYLE_RULES]
  // - "ООО": Always translate as "LLC" (context: company names)
  //   Example: ООО "Энерго-Плюс" → Energy Plus LLC
  // 
  // === USER PROMPT ===
  // Translate the following segments from ru to en.
  // Document: Test Document
  // 
  // Segments to translate:
  // 1. [ID: seg-1] ООО "Энерго-Плюс" является энергопроизводящей организацией
  // 
  // Return ONLY a JSON array in this exact format:
  // [{"id": "segment_id_1", "target": "translated text 1"}]
}

// Вспомогательная функция для загрузки DNA (пример)
async function loadDocumentDna(documentId: string): Promise<DocumentDnaPayload | null> {
  // Реализация загрузки из БД
  return null;
}
