import type { ProviderUsage } from './providers/types';

// Types exported from orchestrator module
export type OrchestratorGlossaryEntry = {
  term: string;
  translation: string;
  forbidden?: boolean;
  notes?: string | null;
};

export type OrchestratorSegment = {
  segmentId: string;
  sourceText: string;
  previousText?: string | null;
  nextText?: string | null;
  summary?: string | null;
  documentName?: string;
};

export type TmExample = {
  sourceText: string;
  targetText: string;
  fuzzyScore: number;
  searchMethod: 'fuzzy' | 'vector' | 'hybrid';
};

export type TranslateSegmentsOptions = {
  segments: OrchestratorSegment[];
  provider?: string;
  model?: string;
  apiKey?: string;
  yandexFolderId?: string; // Yandex Cloud Folder ID (required for YandexGPT)
  temperature?: number;
  maxTokens?: number;
  batchSize?: number;
  retries?: number;
  project?: {
    name?: string | null;
    client?: string | null;
    domain?: string | null;
    sourceLang?: string | null;
    targetLang?: string | null;
    summary?: string | null;
  };
  guidelines?: string[];
  glossary?: OrchestratorGlossaryEntry[];
  tmExamples?: TmExample[];
  sourceLocale?: string;
  targetLocale?: string;
  glossaryMode?: 'off' | 'strict_source' | 'strict_semantic';
};

// Valid provider names for translation results
export type TranslationProvider = 
  | 'gemini' 
  | 'openai' 
  | 'yandex' 
  | 'rule-based' 
  | 'rule'
  | 'project-tm' 
  | 'global-tm'
  | string; // Allow any string for extensibility

export type OrchestratorResult = {
  segmentId: string;
  targetText: string;
  provider: TranslationProvider;
  model: string;
  confidence: number;
  usage?: ProviderUsage;
  raw?: unknown;
  fallback?: boolean;
};

// Re-export types for external use
export type { ProviderUsage, TranslationProvider };







