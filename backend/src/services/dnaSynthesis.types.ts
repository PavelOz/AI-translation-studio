import type { DocumentDnaPayload } from '../ai/types';

/**
 * Источник данных для синтеза DNA
 */
export interface IDataSource {
  type: 'document' | 'csv' | 'glossary' | 'manual';
  documentId?: string;
  csvBuffer?: Buffer;
  glossaryEntries?: Array<{ sourceTerm: string; targetTerm: string }>;
  manualTerms?: Array<{ key: string; longForm: string; shortForm: string }>;
  tags?: string[]; // Теги для автоматического подбора Master DNA
  category?: string; // Категория документа (альтернатива tags)
}

/**
 * Статус термина в DNA
 */
export type TermStatus = 'master' | 'draft' | 'extracted' | 'merged';

/**
 * Обогащенная запись abbreviationLogic с метаданными
 */
export interface EnrichedAbbreviationEntry {
  longForm: string;
  shortForm: string;
  aliases?: string[];
  status: TermStatus;
  source?: string; // 'master_dna' | 'document' | 'csv' | 'llm_enriched'
  confidence?: number; // 0-1 для LLM-обогащенных терминов
}

/**
 * Результат разрешения конфликтов
 */
export interface ConflictResolution {
  key: string;
  action: 'keep_master' | 'keep_extracted' | 'merge' | 'skip';
  masterEntry?: EnrichedAbbreviationEntry;
  extractedEntry?: EnrichedAbbreviationEntry;
  resolvedEntry?: EnrichedAbbreviationEntry;
  reason?: string;
}

/**
 * Master DNA может быть:
 * - Массивом DocumentDnaPayload (несколько документов)
 * - Одиночным DocumentDnaPayload
 * - null (нет мастер-данных)
 */
export type MasterDnaInput = 
  | DocumentDnaPayload[] 
  | DocumentDnaPayload 
  | null;

/**
 * Параметры синтеза
 */
export interface DnaSynthesisOptions {
  useLLM?: boolean; // Обогащение через LLM
  llmProvider?: 'gemini' | 'openai' | 'yandex' | 'deepseek' | 'claude';
  llmModel?: string; // Переопределение модели
  apiKey?: string;
  yandexFolderId?: string;
  conflictStrategy?: 'master_priority' | 'merge' | 'ask'; // Стратегия разрешения конфликтов
  enableGlossaryExtraction?: boolean; // Извлекать ли глоссарий из документа
  glossaryMode?: 'fast' | 'deep';
  batchSize?: number; // Размер батча для LLM-обогащения (автоматически определяется если не указан)
  maxMasterDnaTerms?: number; // Максимум терминов из Master DNA для контекста LLM
  autoResolveMasterDna?: boolean; // Автоматически подбирать Master DNA по тегам
}

/**
 * Прогресс синтеза (хранится в БД)
 */
export interface DnaSynthesisProgress {
  documentId: string;
  status: 'idle' | 'extracting' | 'merging' | 'enriching' | 'completed' | 'error';
  stage: string; // Текущий этап
  progressPercentage: number; // 0-100
  currentMessage?: string;
  
  // Статистика
  totalExtracted: number;
  totalMaster: number;
  totalMerged: number;
  conflictsResolved: number;
  llmEnriched: number;
  skipped: number;
  
  // Детали текущего этапа
  currentBatch?: number;
  totalBatches?: number;
  currentTerm?: string;
  
  // Ошибки
  errors?: Array<{ term: string; error: string; stage: string }>;
  
  // Временные метки
  startedAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

/**
 * Validation Hints для специфичных правил проверки
 */
export interface ValidationHints {
  rules?: Array<{
    term: string;
    context: string;
    rule: string;
    example?: string;
  }>;
  warnings?: Array<{
    term: string;
    message: string;
  }>;
  notes?: string[];
}

/**
 * Расширенный DocumentDnaPayload с validationHints
 */
export interface SynthesizedDocumentDnaPayload extends DocumentDnaPayload {
  validationHints?: ValidationHints | null;
}

/**
 * Результат синтеза
 */
export interface DnaSynthesisResult {
  synthesized: SynthesizedDocumentDnaPayload;
  statistics: {
    totalBefore: number;
    totalAfter: number;
    extracted: number;
    fromMaster: number;
    merged: number;
    llmEnriched: number;
    conflictsResolved: number;
    skipped: number;
  };
  conflicts: ConflictResolution[];
  progress: DnaSynthesisProgress;
}
