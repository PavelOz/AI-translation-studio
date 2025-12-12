import type { ProviderUsage } from './providers/types';

// Types exported from orchestrator module
export type OrchestratorGlossaryEntry = {
  term: string;
  translation: string;
  forbidden?: boolean;
  notes?: string | null;
  contextRules?: {
    useOnlyIn?: string[];
    excludeFrom?: string[];
    documentTypes?: string[];
    requires?: string[];
  };
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
  document?: {
    name?: string | null;
    summary?: string | null;
    clusterSummary?: string | null;
  };
  guidelines?: string[];
  glossary?: OrchestratorGlossaryEntry[];
  tmExamples?: TmExample[];
  sourceLocale?: string;
  targetLocale?: string;
  glossaryMode?: 'off' | 'strict_source' | 'strict_semantic';
  // Stage 2: Document-specific context from Analyst Stage
  documentGlossary?: Array<{ sourceTerm: string; targetTerm: string; status: string; occurrenceCount: number }>;
  documentStyleRules?: Array<{ ruleType: string; pattern: string; description: string | null; examples: any }>;
  documentId?: string; // Optional: for per-segment glossary lookup
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







