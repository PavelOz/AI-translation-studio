/**
 * DnaSynthesisService: синтез DNA из множественных источников с поддержкой Master DNA
 * 
 * Основные возможности:
 * - Multi-layer DNA logic с Master DNA
 * - Batch LLM processing для эффективного обогащения
 * - Автоматический подбор Master DNA по тегам
 * - Conflict Resolution с различными стратегиями
 * - Validation Hints для специфичных правил
 */

import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { getProvider } from '../ai/providers/registry';
import { normalizeDocumentDnaPayloadOrNull } from './dnaSchema';
import { getDocumentDna } from './analysis.service';
import { extractGlossary } from './analysis.service';
import type {
  IDataSource,
  MasterDnaInput,
  DnaSynthesisOptions,
  DnaSynthesisResult,
  DnaSynthesisProgress,
  EnrichedAbbreviationEntry,
  ConflictResolution,
  SynthesizedDocumentDnaPayload,
  ValidationHints,
} from './dnaSynthesis.types';
import type { DocumentDnaPayload } from '../ai/types';

/**
 * Master DNA Index для эффективного поиска
 * Индексирует термины по нормализованным ключам для быстрого поиска
 */
class MasterDnaIndex {
  private index: Map<string, EnrichedAbbreviationEntry> = new Map();
  private shortFormIndex: Map<string, EnrichedAbbreviationEntry> = new Map();
  private aliasesIndex: Map<string, EnrichedAbbreviationEntry> = new Map();

  /**
   * Нормализация ключа для индексации
   */
  private normalizeKey(key: string): string {
    return key.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  /**
   * Построить индекс из Master DNA
   */
  build(masterDna: MasterDnaInput): void {
    this.index.clear();
    this.shortFormIndex.clear();
    this.aliasesIndex.clear();

    if (!masterDna) return;

    const dnaArray = Array.isArray(masterDna) ? masterDna : [masterDna];

    for (const dna of dnaArray) {
      const abbrevLogic = dna?.abbreviationLogic;
      if (!abbrevLogic || typeof abbrevLogic !== 'object') continue;

      for (const [key, value] of Object.entries(abbrevLogic)) {
        const normalizedKey = this.normalizeKey(key);
        
        // Парсинг значения
        let entry: EnrichedAbbreviationEntry;
        if (typeof value === 'string') {
          entry = {
            longForm: value,
            shortForm: value,
            status: 'master',
            source: 'master_dna',
          };
        } else if (value && typeof value === 'object') {
          entry = {
            longForm: (value as any).longForm || (value as any).value || key,
            shortForm: (value as any).shortForm || (value as any).longForm || key,
            aliases: (value as any).aliases,
            status: 'master',
            source: 'master_dna',
          };
        } else {
          continue;
        }

        // Индексация по ключу
        if (!this.index.has(normalizedKey)) {
          this.index.set(normalizedKey, entry);
        }

        // Индексация по shortForm
        const normalizedShort = this.normalizeKey(entry.shortForm);
        if (!this.shortFormIndex.has(normalizedShort)) {
          this.shortFormIndex.set(normalizedShort, entry);
        }

        // Индексация по aliases
        if (entry.aliases) {
          for (const alias of entry.aliases) {
            const normalizedAlias = this.normalizeKey(alias);
            if (!this.aliasesIndex.has(normalizedAlias)) {
              this.aliasesIndex.set(normalizedAlias, entry);
            }
          }
        }
      }
    }

    logger.info(
      {
        totalKeys: this.index.size,
        totalShortForms: this.shortFormIndex.size,
        totalAliases: this.aliasesIndex.size,
      },
      'Master DNA index built',
    );
  }

  /**
   * Поиск термина в Master DNA
   * Возвращает найденную запись или null
   */
  find(key: string): EnrichedAbbreviationEntry | null {
    const normalized = this.normalizeKey(key);
    return (
      this.index.get(normalized) ||
      this.shortFormIndex.get(normalized) ||
      this.aliasesIndex.get(normalized) ||
      null
    );
  }

  /**
   * Получить все термины для контекста LLM (с ограничением)
   */
  getContextTerms(maxTerms: number = 50): Array<{ key: string; entry: EnrichedAbbreviationEntry }> {
    const entries = Array.from(this.index.entries())
      .slice(0, maxTerms)
      .map(([key, entry]) => ({ key, entry }));
    return entries;
  }

  /**
   * Получить размер индекса
   */
  getSize(): number {
    return this.index.size;
  }
}

/**
 * DnaSynthesisService: синтез DNA из множественных источников
 */
export class DnaSynthesisService {
  private masterDnaIndex: MasterDnaIndex = new MasterDnaIndex();

  /**
   * Основной pipeline синтеза
   */
  async synthesize(
    sourceData: IDataSource,
    masterDna: MasterDnaInput,
    documentId: string,
    options: DnaSynthesisOptions = {},
  ): Promise<DnaSynthesisResult> {
    // Инициализация прогресса
    await this.initializeProgress(documentId);

    try {
      // Этап 0: Автоматический подбор Master DNA по тегам (если включено)
      if (options.autoResolveMasterDna !== false && sourceData.tags && sourceData.tags.length > 0) {
        await this.updateProgress(documentId, {
          status: 'merging',
          stage: 'resolving_master_dna',
          progressPercentage: 2,
          currentMessage: `Resolving Master DNA by tags: ${sourceData.tags.join(', ')}...`,
        });

        const resolvedMasterDna = await this.resolveMasterDna(sourceData.tags, documentId);
        if (resolvedMasterDna) {
          // Объединяем с переданным Master DNA
          const existingArray = Array.isArray(masterDna) ? masterDna : (masterDna ? [masterDna] : []);
          masterDna = [...existingArray, resolvedMasterDna];
          logger.info({ tags: sourceData.tags, foundDna: true }, 'Master DNA resolved by tags');
        }
      }

      // Этап 1: Построение индекса Master DNA
      await this.updateProgress(documentId, {
        status: 'merging',
        stage: 'indexing_master_dna',
        progressPercentage: 5,
        currentMessage: 'Indexing master DNA...',
      });

      this.masterDnaIndex.build(masterDna);
      const masterSize = this.masterDnaIndex.getSize();

      await this.updateProgress(documentId, {
        progressPercentage: 10,
        totalMaster: masterSize,
        currentMessage: `Indexed ${masterSize} master DNA terms`,
      });

      // Этап 2: Извлечение терминов из источника
      await this.updateProgress(documentId, {
        status: 'extracting',
        stage: 'extracting_terms',
        progressPercentage: 15,
        currentMessage: 'Extracting terms from source...',
      });

      const extractedTerms = await this.extractTerms(sourceData, documentId, options);
      
      await this.updateProgress(documentId, {
        progressPercentage: 40,
        totalExtracted: extractedTerms.length,
        currentMessage: `Extracted ${extractedTerms.length} terms`,
      });

      // Этап 3: Merge с Master DNA (Conflict Resolution)
      await this.updateProgress(documentId, {
        status: 'merging',
        stage: 'resolving_conflicts',
        progressPercentage: 45,
        currentMessage: 'Resolving conflicts with master DNA...',
      });

      const { merged, conflicts } = await this.mergeWithMaster(
        extractedTerms,
        options.conflictStrategy || 'master_priority',
      );

      await this.updateProgress(documentId, {
        progressPercentage: 60,
        totalMerged: merged.length,
        conflictsResolved: conflicts.length,
        currentMessage: `Merged ${merged.length} terms, resolved ${conflicts.length} conflicts`,
      });

      // Этап 4: Batch LLM-обогащение (опционально)
      let enriched = merged;
      let llmEnrichedCount = 0;
      let validationHints: ValidationHints | null = null;

      if (options.useLLM !== false) {
        await this.updateProgress(documentId, {
          status: 'enriching',
          stage: 'llm_enrichment',
          progressPercentage: 65,
          currentMessage: 'Enriching terms with LLM (batch processing)...',
        });

        const enrichmentResult = await this.enrichWithLLMBatch(
          merged,
          documentId,
          options,
          sourceData.tags || [],
        );

        enriched = enrichmentResult.enriched;
        llmEnrichedCount = enrichmentResult.enrichedCount;
        validationHints = enrichmentResult.validationHints;

        await this.updateProgress(documentId, {
          progressPercentage: 90,
          llmEnriched: llmEnrichedCount,
          currentMessage: `Enriched ${llmEnrichedCount} terms with LLM (batch mode)`,
        });
      }

      // Этап 5: Формирование финального DNA
      await this.updateProgress(documentId, {
        status: 'completed',
        stage: 'finalizing',
        progressPercentage: 95,
        currentMessage: 'Finalizing DNA synthesis...',
      });

      const synthesized = this.buildFinalDna(enriched, masterDna, validationHints);

      // Сохранение результата
      await this.saveSynthesizedDna(documentId, synthesized);

      // Завершение прогресса
      await this.updateProgress(documentId, {
        status: 'completed',
        stage: 'completed',
        progressPercentage: 100,
        currentMessage: 'DNA synthesis completed',
        completedAt: new Date(),
      });

      return {
        synthesized,
        statistics: {
          totalBefore: this.countTerms(masterDna) + extractedTerms.length,
          totalAfter: this.countTerms({ abbreviationLogic: synthesized.abbreviationLogic }),
          extracted: extractedTerms.length,
          fromMaster: masterSize,
          merged: merged.length,
          llmEnriched: llmEnrichedCount,
          conflictsResolved: conflicts.length,
          skipped: extractedTerms.length - merged.length,
        },
        conflicts,
        progress: await this.getProgress(documentId),
      };
    } catch (error) {
      await this.updateProgress(documentId, {
        status: 'error',
        currentMessage: error instanceof Error ? error.message : 'Unknown error',
        errors: [
          {
            term: '',
            error: error instanceof Error ? error.message : 'Unknown error',
            stage: 'synthesis',
          },
        ],
      });
      throw error;
    }
  }

  /**
   * Автоматический подбор Master DNA по тегам
   * Ищет документы в проекте с подходящими тегами/доменами
   */
  async resolveMasterDna(tags: string[], documentId: string): Promise<DocumentDnaPayload | null> {
    try {
      // Получаем документ для определения проекта
      const document = await prisma.document.findUnique({
        where: { id: documentId },
        select: {
          projectId: true,
          project: {
            select: {
              domain: true,
              clientName: true,
            },
          },
        },
      });

      if (!document) {
        logger.warn({ documentId }, 'Document not found for Master DNA resolution');
        return null;
      }

      // Поиск документов в том же проекте с подходящими характеристиками
      const matchingDocuments = await prisma.document.findMany({
        where: {
          projectId: document.projectId,
          id: { not: documentId }, // Исключаем текущий документ
          documentDna: { isNot: null }, // Только документы с DNA
          status: 'COMPLETED', // Только завершенные документы
        },
        select: {
          id: true,
          name: true,
          documentDna: {
            select: {
              abbreviationLogic: true,
              technicalSchema: true,
              namingConventions: true,
              entityGroups: true,
            },
          },
        },
        orderBy: {
          updatedAt: 'desc', // Более свежие документы в приоритете
        },
        take: 5, // Берем до 5 документов
      });

      if (matchingDocuments.length === 0) {
        logger.info({ projectId: document.projectId, tags }, 'No matching documents found for Master DNA');
        return null;
      }

      // Объединяем DNA из найденных документов
      const masterDnaArray: DocumentDnaPayload[] = matchingDocuments
        .map(doc => doc.documentDna)
        .filter((dna): dna is NonNullable<typeof dna> => dna !== null)
        .map(dna => ({
          technicalSchema: dna.technicalSchema as Record<string, unknown> | null,
          namingConventions: dna.namingConventions as Record<string, unknown> | null,
          abbreviationLogic: dna.abbreviationLogic as Record<string, unknown> | null,
          entityGroups: dna.entityGroups as Record<string, unknown> | null,
        }));

      if (masterDnaArray.length === 0) {
        return null;
      }

      // Если один документ - возвращаем его DNA
      if (masterDnaArray.length === 1) {
        logger.info(
          { documentId, sourceDocument: matchingDocuments[0].id },
          'Master DNA resolved from single document',
        );
        return masterDnaArray[0];
      }

      // Если несколько - объединяем abbreviationLogic
      const mergedAbbrevLogic: Record<string, unknown> = {};
      for (const dna of masterDnaArray) {
        if (dna.abbreviationLogic && typeof dna.abbreviationLogic === 'object') {
          Object.assign(mergedAbbrevLogic, dna.abbreviationLogic);
        }
      }

      logger.info(
        {
          documentId,
          sourceDocuments: matchingDocuments.map(d => d.id),
          mergedTerms: Object.keys(mergedAbbrevLogic).length,
        },
        'Master DNA resolved from multiple documents',
      );

      return {
        abbreviationLogic: mergedAbbrevLogic,
        technicalSchema: masterDnaArray[0]?.technicalSchema || null,
        namingConventions: masterDnaArray[0]?.namingConventions || null,
        entityGroups: masterDnaArray[0]?.entityGroups || null,
      };
    } catch (error) {
      logger.error({ error, tags, documentId }, 'Failed to resolve Master DNA by tags');
      return null;
    }
  }

  /**
   * Извлечение терминов из источника данных
   */
  private async extractTerms(
    source: IDataSource,
    documentId: string,
    options: DnaSynthesisOptions,
  ): Promise<Array<{ key: string; entry: EnrichedAbbreviationEntry }>> {
    switch (source.type) {
      case 'document':
        if (!source.documentId) throw new Error('Document ID required for document source');
        
        if (options.enableGlossaryExtraction !== false) {
          // Извлечение глоссария из документа
          await extractGlossary(
            source.documentId,
            options.glossaryMode || 'fast',
            options.llmProvider,
            options.llmModel,
          );
        }

        // Получение существующего DNA документа
        const documentDna = await getDocumentDna(source.documentId);
        return this.dnaToTerms(documentDna, 'extracted', 'document');

      case 'csv':
        // Парсинг CSV (используем существующую логику)
        const { parseCSVBuffer } = await import('./dnaEnrichment.service');
        const csvRows = parseCSVBuffer(source.csvBuffer!);
        return csvRows.map(row => ({
          key: row['Наименование энергопроизводящей организации'],
          entry: {
            longForm: row['Наименование на английском'] || row['Наименование энергопроизводящей организации'],
            shortForm: row['Сокращенное наименование'],
            status: 'extracted',
            source: 'csv',
          },
        }));

      case 'glossary':
        return (source.glossaryEntries || []).map(entry => ({
          key: entry.sourceTerm,
          entry: {
            longForm: entry.targetTerm,
            shortForm: entry.targetTerm,
            status: 'extracted',
            source: 'glossary',
          },
        }));

      case 'manual':
        return (source.manualTerms || []).map(term => ({
          key: term.key,
          entry: {
            longForm: term.longForm,
            shortForm: term.shortForm,
            status: 'draft',
            source: 'manual',
          },
        }));

      default:
        throw new Error(`Unsupported source type: ${(source as any).type}`);
    }
  }

  /**
   * Конвертация DNA в массив терминов
   */
  private dnaToTerms(
    dna: DocumentDnaPayload | null,
    status: TermStatus,
    source: string,
  ): Array<{ key: string; entry: EnrichedAbbreviationEntry }> {
    if (!dna?.abbreviationLogic || typeof dna.abbreviationLogic !== 'object') {
      return [];
    }

    return Object.entries(dna.abbreviationLogic).map(([key, value]) => {
      let entry: EnrichedAbbreviationEntry;
      
      if (typeof value === 'string') {
        entry = {
          longForm: value,
          shortForm: value,
          status,
          source,
        };
      } else if (value && typeof value === 'object') {
        entry = {
          longForm: (value as any).longForm || (value as any).value || key,
          shortForm: (value as any).shortForm || (value as any).longForm || key,
          aliases: (value as any).aliases,
          status,
          source,
        };
      } else {
        entry = {
          longForm: key,
          shortForm: key,
          status,
          source,
        };
      }

      return { key, entry };
    });
  }

  /**
   * Merge извлеченных терминов с Master DNA
   */
  private async mergeWithMaster(
    extracted: Array<{ key: string; entry: EnrichedAbbreviationEntry }>,
    strategy: 'master_priority' | 'merge' | 'ask',
  ): Promise<{
    merged: Array<{ key: string; entry: EnrichedAbbreviationEntry }>;
    conflicts: ConflictResolution[];
  }> {
    const merged: Array<{ key: string; entry: EnrichedAbbreviationEntry }> = [];
    const conflicts: ConflictResolution[] = [];
    const seenKeys = new Set<string>();

    for (const { key, entry: extractedEntry } of extracted) {
      const normalizedKey = this.normalizeKey(key);
      
      // Проверка на дубликаты в уже обработанных терминах
      if (seenKeys.has(normalizedKey)) {
        conflicts.push({
          key,
          action: 'skip',
          extractedEntry,
          reason: 'Duplicate key in extracted terms',
        });
        continue;
      }

      // Поиск в Master DNA
      const masterEntry = this.masterDnaIndex.find(key);

      if (masterEntry) {
        // Конфликт: термин есть и в Master, и в извлеченных
        if (strategy === 'master_priority') {
          // Приоритет Master DNA
          merged.push({
            key,
            entry: {
              ...masterEntry,
              status: 'master',
            },
          });
          conflicts.push({
            key,
            action: 'keep_master',
            masterEntry,
            extractedEntry,
            resolvedEntry: masterEntry,
            reason: 'Master DNA has priority',
          });
        } else if (strategy === 'merge') {
          // Слияние: объединяем aliases, берем лучшее из обоих
          const mergedEntry: EnrichedAbbreviationEntry = {
            longForm: masterEntry.longForm || extractedEntry.longForm,
            shortForm: masterEntry.shortForm || extractedEntry.shortForm,
            aliases: [
              ...(masterEntry.aliases || []),
              ...(extractedEntry.aliases || []),
              // Добавляем ключи как aliases если они различаются
              ...(this.normalizeKey(key) !== this.normalizeKey(masterEntry.shortForm)
                ? [key]
                : []),
            ].filter((v, i, arr) => arr.indexOf(v) === i), // Уникальные
            status: 'merged',
            source: 'merged',
          };
          merged.push({ key, entry: mergedEntry });
          conflicts.push({
            key,
            action: 'merge',
            masterEntry,
            extractedEntry,
            resolvedEntry: mergedEntry,
            reason: 'Merged master and extracted entries',
          });
        } else {
          // 'ask' - оставляем оба, помечаем как конфликт
          conflicts.push({
            key,
            action: 'ask',
            masterEntry,
            extractedEntry,
            reason: 'Manual resolution required',
          });
          // Пока оставляем master
          merged.push({ key, entry: masterEntry });
        }
      } else {
        // Нет конфликта - добавляем извлеченный термин
        merged.push({ key, entry: extractedEntry });
      }

      seenKeys.add(normalizedKey);
    }

    return { merged, conflicts };
  }

  /**
   * Batch LLM-обогащение терминов
   * Отправляет массив терминов в одном промпте для эффективности
   */
  private async enrichWithLLMBatch(
    terms: Array<{ key: string; entry: EnrichedAbbreviationEntry }>,
    documentId: string,
    options: DnaSynthesisOptions,
    tags: string[],
  ): Promise<{
    enriched: Array<{ key: string; entry: EnrichedAbbreviationEntry }>;
    enrichedCount: number;
    validationHints: ValidationHints | null;
  }> {
    const provider = getProvider(
      options.llmProvider || 'gemini',
      options.apiKey,
      options.yandexFolderId,
    );

    const model = options.llmModel || (options.llmProvider === 'gemini' 
      ? 'gemini-1.5-pro' 
      : provider.defaultModel);

    // Определяем размер батча на основе возможностей модели
    const capabilities = provider.getCapabilities(model);
    const batchSize = options.batchSize || capabilities.maxBatchSize;
    
    logger.info(
      {
        model,
        maxBatchSize: capabilities.maxBatchSize,
        contextLimit: capabilities.contextLimit,
        selectedBatchSize: batchSize,
        totalTerms: terms.length,
      },
      'LLM batch enrichment configuration',
    );

    // Фильтруем термины, которые нужно обогатить
    const termsToEnrich = terms.filter(
      ({ entry }) => entry.status !== 'master' && entry.source !== 'llm_enriched'
    );

    if (termsToEnrich.length === 0) {
      return {
        enriched: terms,
        enrichedCount: 0,
        validationHints: null,
      };
    }

    const enriched: Array<{ key: string; entry: EnrichedAbbreviationEntry }> = [];
    let enrichedCount = 0;
    const validationHintsRules: ValidationHints['rules'] = [];
    const validationHintsWarnings: ValidationHints['warnings'] = [];

    // Получаем контекст из Master DNA (ограниченный размер)
    const masterContext = this.masterDnaIndex.getContextTerms(
      options.maxMasterDnaTerms || 50,
    );

    // Обработка батчами
    const totalBatches = Math.ceil(termsToEnrich.length / batchSize);
    
    for (let i = 0; i < termsToEnrich.length; i += batchSize) {
      const batch = termsToEnrich.slice(i, i + batchSize);
      const batchNumber = Math.floor(i / batchSize) + 1;

      await this.updateProgress(documentId, {
        currentBatch: batchNumber,
        totalBatches,
        currentTerm: batch[0]?.key,
        currentMessage: `Enriching batch ${batchNumber}/${totalBatches} (${batch.length} terms)...`,
      });

      try {
        // Используем retry из BaseProvider
        const response = await (provider as any).callModelWithRetry({
          prompt: this.buildBatchEnrichmentPrompt(batch, masterContext, tags),
          systemPrompt: this.buildSystemPrompt(tags),
          model,
          temperature: 0.3,
          maxTokens: 4000, // Увеличенный лимит для батча
          segments: [],
        });

        const batchResult = this.parseBatchEnrichmentResponse(response.outputText, batch);
        
        // Добавляем обогащенные термины
        for (const { key, entry } of batch) {
          const enrichedData = batchResult.terms[key];
          if (enrichedData) {
            enriched.push({
              key,
              entry: {
                ...entry,
                ...enrichedData,
                status: 'extracted',
                source: 'llm_enriched',
                confidence: enrichedData.confidence || 0.8,
              },
            });
            enrichedCount++;
          } else {
            // Fallback на оригинал
            enriched.push({ key, entry });
          }
        }

        // Собираем validation hints из ответа
        if (batchResult.validationHints) {
          if (batchResult.validationHints.rules) {
            validationHintsRules.push(...batchResult.validationHints.rules);
          }
          if (batchResult.validationHints.warnings) {
            validationHintsWarnings.push(...batchResult.validationHints.warnings);
          }
        }

        // Задержка между батчами
        if (i + batchSize < termsToEnrich.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        logger.warn(
          { batchNumber, batchSize: batch.length, error },
          'LLM batch enrichment failed, using original entries',
        );
        // Fallback: добавляем оригинальные термины
        for (const term of batch) {
          enriched.push(term);
        }
      }
    }

    // Добавляем термины, которые не нужно было обогащать
    const alreadyEnrichedKeys = new Set(enriched.map(t => this.normalizeKey(t.key)));
    for (const term of terms) {
      if (!alreadyEnrichedKeys.has(this.normalizeKey(term.key))) {
        enriched.push(term);
      }
    }

    return {
      enriched,
      enrichedCount,
      validationHints: validationHintsRules.length > 0 || validationHintsWarnings.length > 0
        ? {
            rules: validationHintsRules.length > 0 ? validationHintsRules : undefined,
            warnings: validationHintsWarnings.length > 0 ? validationHintsWarnings : undefined,
          }
        : null,
    };
  }

  /**
   * Построение системного промпта для LLM
   */
  private buildSystemPrompt(tags: string[]): string {
    const tagsContext = tags.length > 0 
      ? `Контекст документа: ${tags.join(', ')}. `
      : '';

    return `Ты — эксперт по синтезу Digital DNA. Твоя задача — обогатить список терминов, соблюдая стилистику Master DNA и учитывая контекст предоставленных тегов.

${tagsContext}Используй Master DNA как эталон стиля и терминологии. Для каждого термина:
1. Предоставь точный английский перевод (longForm)
2. Предложи корректную аббревиатуру (shortForm)
3. Укажи альтернативные названия (aliases), если применимо
4. Добавь validation hints для специфичных правил использования термина в этом контексте

Возвращай результат в формате JSON с ключами-терминами и validationHints.`;
  }

  /**
   * Построение промпта для батч-обогащения
   */
  private buildBatchEnrichmentPrompt(
    batch: Array<{ key: string; entry: EnrichedAbbreviationEntry }>,
    masterContext: Array<{ key: string; entry: EnrichedAbbreviationEntry }>,
    tags: string[],
  ): string {
    const batchJson = JSON.stringify(
      batch.reduce((acc, { key, entry }) => {
        acc[key] = {
          longForm: entry.longForm,
          shortForm: entry.shortForm,
          aliases: entry.aliases || [],
        };
        return acc;
      }, {} as Record<string, any>),
      null,
      2,
    );

    const masterExamples = masterContext
      .slice(0, 10)
      .map(({ key: k, entry: e }) => `"${k}": { "longForm": "${e.longForm}", "shortForm": "${e.shortForm}" }`)
      .join(',\n');

    const tagsContext = tags.length > 0 
      ? `\n\nКонтекст документа (теги): ${tags.join(', ')}`
      : '';

    return `Обогати следующие технические термины, соблюдая стилистику Master DNA:

Термины для обогащения:
${batchJson}

Примеры из Master DNA (для стилистической ориентации):
${masterExamples ? `{\n${masterExamples}\n}` : 'Нет примеров'}

${tagsContext}

Для каждого термина верни:
- longForm: полный английский перевод
- shortForm: аббревиатура или краткая форма
- aliases: массив альтернативных названий (если есть)
- confidence: уверенность в переводе (0-1)

Также добавь validationHints с правилами для специфичных случаев использования терминов в этом контексте.

Формат ответа:
{
  "terms": {
    "ключ1": { "longForm": "...", "shortForm": "...", "aliases": [...], "confidence": 0.9 },
    "ключ2": { ... }
  },
  "validationHints": {
    "rules": [
      { "term": "ключ", "context": "контекст", "rule": "правило", "example": "пример" }
    ],
    "warnings": [
      { "term": "ключ", "message": "предупреждение" }
    ]
  }
}

Верни только JSON, без markdown.`;
  }

  /**
   * Парсинг ответа LLM для батч-обогащения
   */
  private parseBatchEnrichmentResponse(
    response: string,
    originalBatch: Array<{ key: string; entry: EnrichedAbbreviationEntry }>,
  ): {
    terms: Record<string, Partial<EnrichedAbbreviationEntry>>;
    validationHints: ValidationHints | null;
  } {
    try {
      const cleaned = response
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      const parsed = JSON.parse(cleaned);

      const terms: Record<string, Partial<EnrichedAbbreviationEntry>> = {};
      
      // Парсинг терминов
      if (parsed.terms && typeof parsed.terms === 'object') {
        for (const [key, value] of Object.entries(parsed.terms)) {
          if (value && typeof value === 'object') {
            terms[key] = {
              longForm: (value as any).longForm || (value as any).long_form,
              shortForm: (value as any).shortForm || (value as any).short_form,
              aliases: (value as any).aliases || [],
              confidence: (value as any).confidence,
            };
          }
        }
      }

      // Парсинг validation hints
      let validationHints: ValidationHints | null = null;
      if (parsed.validationHints && typeof parsed.validationHints === 'object') {
        validationHints = {
          rules: parsed.validationHints.rules || undefined,
          warnings: parsed.validationHints.warnings || undefined,
        };
      }

      return { terms, validationHints };
    } catch (error) {
      logger.warn({ response: response.substring(0, 500), error }, 'Failed to parse LLM batch response');
      // Fallback: возвращаем пустые результаты
      return {
        terms: {},
        validationHints: null,
      };
    }
  }

  /**
   * Построение финального DNA
   */
  private buildFinalDna(
    terms: Array<{ key: string; entry: EnrichedAbbreviationEntry }>,
    masterDna: MasterDnaInput,
    validationHints: ValidationHints | null,
  ): SynthesizedDocumentDnaPayload {
    const abbreviationLogic: Record<string, { longForm: string; shortForm: string; aliases?: string[] }> = {};

    // Добавляем все термины
    for (const { key, entry } of terms) {
      abbreviationLogic[key] = {
        longForm: entry.longForm,
        shortForm: entry.shortForm,
        ...(entry.aliases && entry.aliases.length > 0 ? { aliases: entry.aliases } : undefined),
      };
    }

    // Объединяем с Master DNA (если есть термины, которых нет в merged)
    if (masterDna) {
      const masterArray = Array.isArray(masterDna) ? masterDna : [masterDna];
      for (const dna of masterArray) {
        if (dna?.abbreviationLogic && typeof dna.abbreviationLogic === 'object') {
          for (const [key, value] of Object.entries(dna.abbreviationLogic)) {
            if (!abbreviationLogic[key]) {
              // Добавляем только если нет в merged
              if (typeof value === 'string') {
                abbreviationLogic[key] = { longForm: value, shortForm: value };
              } else if (value && typeof value === 'object') {
                abbreviationLogic[key] = {
                  longForm: (value as any).longForm || (value as any).value || key,
                  shortForm: (value as any).shortForm || (value as any).longForm || key,
                  ...((value as any).aliases ? { aliases: (value as any).aliases } : undefined),
                };
              }
            }
          }
        }
      }
    }

    // Объединяем другие секции из Master DNA
    const masterArray = Array.isArray(masterDna) ? masterDna : (masterDna ? [masterDna] : []);
    const technicalSchema = masterArray.find(d => d?.technicalSchema)?.technicalSchema;
    const namingConventions = masterArray.find(d => d?.namingConventions)?.namingConventions;
    const entityGroups = masterArray.find(d => d?.entityGroups)?.entityGroups;

    return {
      technicalSchema: technicalSchema || null,
      namingConventions: namingConventions || null,
      abbreviationLogic,
      entityGroups: entityGroups || null,
      validationHints: validationHints || null,
    };
  }

  /**
   * Сохранение синтезированного DNA
   */
  private async saveSynthesizedDna(
    documentId: string,
    dna: SynthesizedDocumentDnaPayload,
  ): Promise<void> {
    const toJson = (v: Record<string, unknown> | null | undefined) =>
      v === undefined ? undefined : v === null ? null : (v as any);

    await prisma.documentDna.upsert({
      where: { documentId },
      create: {
        documentId,
        technicalSchema: toJson(dna.technicalSchema),
        namingConventions: toJson(dna.namingConventions),
        abbreviationLogic: toJson(dna.abbreviationLogic),
        entityGroups: toJson(dna.entityGroups),
        // Note: validationHints пока не хранится в БД (нужна миграция)
        // Можно временно хранить в namingConventions или отдельном поле
      },
      update: {
        technicalSchema: toJson(dna.technicalSchema),
        namingConventions: toJson(dna.namingConventions),
        abbreviationLogic: toJson(dna.abbreviationLogic),
        entityGroups: toJson(dna.entityGroups),
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Подсчет терминов в DNA
   */
  private countTerms(dna: DocumentDnaPayload | null | undefined): number {
    if (!dna?.abbreviationLogic || typeof dna.abbreviationLogic !== 'object') {
      return 0;
    }
    return Object.keys(dna.abbreviationLogic).length;
  }

  /**
   * Нормализация ключа
   */
  private normalizeKey(key: string): string {
    return key.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  // ========== Progress Management (БД) ==========

  /**
   * Инициализация прогресса в БД
   */
  private async initializeProgress(documentId: string): Promise<void> {
    await prisma.documentAnalysis.upsert({
      where: { documentId },
      create: {
        documentId,
        status: 'PENDING',
        currentStage: 'initializing',
        progressPercentage: 0,
        currentMessage: 'Initializing DNA synthesis...',
        executionLogs: [],
      },
      update: {
        status: 'PENDING',
        currentStage: 'initializing',
        progressPercentage: 0,
        currentMessage: 'Initializing DNA synthesis...',
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Обновление прогресса в БД
   */
  private async updateProgress(
    documentId: string,
    updates: Partial<DnaSynthesisProgress>,
  ): Promise<void> {
    try {
      const current = await prisma.documentAnalysis.findUnique({
        where: { documentId },
        select: {
          executionLogs: true,
        },
      });

      const logs = (current?.executionLogs as any[]) || [];
      if (updates.currentMessage) {
        logs.push({
          timestamp: new Date().toISOString(),
          stage: updates.stage || 'unknown',
          message: updates.currentMessage,
          progress: updates.progressPercentage,
          ...(updates.currentBatch ? { batch: `${updates.currentBatch}/${updates.totalBatches}` } : {}),
        });
      }

      await prisma.documentAnalysis.update({
        where: { documentId },
        data: {
          status: updates.status?.toUpperCase() || undefined,
          currentStage: updates.stage || updates.currentMessage || undefined,
          progressPercentage: updates.progressPercentage ?? undefined,
          currentMessage: updates.currentMessage || undefined,
          executionLogs: logs,
          updatedAt: new Date(),
          ...(updates.completedAt ? { completedAt: updates.completedAt } : {}),
        },
      });
    } catch (error) {
      logger.warn({ documentId, error }, 'Failed to update synthesis progress');
    }
  }

  /**
   * Получение прогресса из БД
   */
  async getProgress(documentId: string): Promise<DnaSynthesisProgress> {
    const analysis = await prisma.documentAnalysis.findUnique({
      where: { documentId },
    });

    if (!analysis) {
      return {
        documentId,
        status: 'idle',
        stage: 'not_started',
        progressPercentage: 0,
        totalExtracted: 0,
        totalMaster: 0,
        totalMerged: 0,
        conflictsResolved: 0,
        llmEnriched: 0,
        skipped: 0,
        startedAt: new Date(),
        updatedAt: new Date(),
      };
    }

    const logs = (analysis.executionLogs as any[]) || [];
    const lastLog = logs[logs.length - 1];

    return {
      documentId,
      status: (analysis.status?.toLowerCase() as any) || 'idle',
      stage: analysis.currentStage || 'unknown',
      progressPercentage: analysis.progressPercentage || 0,
      currentMessage: analysis.currentMessage || undefined,
      totalExtracted: 0, // TODO: хранить в executionLogs
      totalMaster: 0,
      totalMerged: 0,
      conflictsResolved: 0,
      llmEnriched: 0,
      skipped: 0,
      startedAt: analysis.createdAt,
      updatedAt: analysis.updatedAt,
      completedAt: analysis.completedAt || undefined,
    };
  }
}
