import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { AIOrchestrator, type OrchestratorGlossaryEntry, type OrchestratorSegment, type TmExample, type TranslationProvider } from '../ai/orchestrator';
import { QAEngine } from '../ai/qaEngine';
import { searchTranslationMemory } from './tm.service';
import { ApiError } from '../utils/apiError';
import { getSegmentWithDocument } from './segment.service';
import { listProviders as listAvailableProviders, getProvider } from '../ai/providers/registry';
import { logger } from '../utils/logger';
import type { GlossaryMode } from '../types/glossary';

const orchestrator = new AIOrchestrator();
const qaEngine = new QAEngine();

type MachineTranslationOptions = {
  applyTm?: boolean;
  minScore?: number;
  glossaryMode?: GlossaryMode;
  // Опции для синхронизации с TM Search Panel
  tmRagSettings?: {
    minScore?: number;
    vectorSimilarity?: number;
    mode?: 'basic' | 'extended';
    useVectorSearch?: boolean;
    limit?: number;
  };
};

// Метаданные для прозрачности процесса перевода
export type TranslationMetadata = {
  stage: 'tm-direct' | 'ai-draft' | 'critic' | 'editor' | 'complete';
  priority: number; // 1 = highest priority
  source: 'tm-direct' | 'tm-rag' | 'glossary' | 'guidelines' | 'ai';
  tmDirectMatch?: {
    id: string;
    sourceText: string;
    targetText: string;
    fuzzyScore: number;
    searchMethod: 'fuzzy' | 'vector' | 'hybrid';
  };
  tmExamples?: Array<{
    sourceText: string;
    targetText: string;
    fuzzyScore: number;
    searchMethod: 'fuzzy' | 'vector' | 'hybrid';
  }>;
  glossaryEntries?: Array<{
    sourceTerm: string;
    targetTerm: string;
    mode: GlossaryMode;
    isForbidden: boolean;
  }>;
  glossaryMode?: GlossaryMode;
  guidelinesCount?: number;
  tmSearchSettings?: {
    minScore: number;
    vectorSimilarity: number;
    mode: 'basic' | 'extended';
    useVectorSearch: boolean;
    limit: number;
  };
  message?: string;
};

type ProjectAISettingsPayload = {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  config?: Record<string, unknown>;
};

const toJsonValue = (value?: Record<string, unknown>): Prisma.InputJsonValue | undefined =>
  value ? (value as Prisma.InputJsonValue) : undefined;

const normalizeGuidelines = (rules: Prisma.JsonValue | null | undefined): string[] => {
  if (!rules) return [];
  if (Array.isArray(rules)) {
    return (rules as Prisma.JsonValue[]).map((rule) => {
      // Handle string format
      if (typeof rule === 'string') {
        return rule;
      }
      // Handle object format with title/instruction/description
      if (typeof rule === 'object' && rule !== null) {
        const ruleObj = rule as Record<string, unknown>;
        return (
          (ruleObj.title as string) ||
          (ruleObj.instruction as string) ||
          (ruleObj.description as string) ||
          ''
        );
      }
      return '';
    }).filter((rule): rule is string => typeof rule === 'string' && rule.length > 0);
  }
  return [];
};

const mapGlossaryEntries = (
  entries: Array<{ sourceTerm: string; targetTerm: string; isForbidden: boolean; notes: string | null }>,
): OrchestratorGlossaryEntry[] =>
  entries.map((entry) => ({
    term: entry.sourceTerm,
    translation: entry.targetTerm,
    forbidden: entry.isForbidden,
    notes: entry.notes,
  }));

type AiContext = {
  projectMeta: {
    name?: string | null;
    client?: string | null;
    domain?: string | null;
    sourceLang?: string | null;
    targetLang?: string | null;
    summary?: string | null;
  };
  settings: Awaited<ReturnType<typeof getProjectAISettings>> | null;
  guidelines: string[];
  glossary: OrchestratorGlossaryEntry[];
  apiKey?: string; // Project-specific API key from config
  yandexFolderId?: string; // Project-specific Yandex Folder ID from config
};

const buildAiContext = async (projectId: string): Promise<AiContext> => {
  const [project, settings, guidelineRecord, glossaryEntries] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: {
        name: true,
        clientName: true,
        domain: true,
        description: true,
        sourceLang: true,
        sourceLocale: true,
        targetLang: true,
        targetLocales: true,
      },
    }),
    getProjectAISettings(projectId),
    prisma.projectGuideline.findUnique({ where: { projectId } }),
    prisma.glossaryEntry.findMany({
      where: { OR: [{ projectId }, { projectId: null }] },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { sourceTerm: true, targetTerm: true, isForbidden: true, notes: true },
    }),
  ]);

  if (!project) {
    throw ApiError.notFound('Project not found for AI context');
  }

  // Extract API key and folderId from project settings config if available
  // Priority: provider-specific key (e.g., openaiApiKey) > legacy apiKey > undefined
  let apiKey: string | undefined;
  let yandexFolderId: string | undefined;
  
  // Log settings for debugging
  logger.debug({
    hasSettings: !!settings,
    hasConfig: !!(settings?.config),
    configType: typeof settings?.config,
    configIsNull: settings?.config === null,
    configIsUndefined: settings?.config === undefined,
    configValue: settings?.config ? JSON.stringify(settings.config).substring(0, 200) : 'none',
    provider: settings?.provider,
  }, 'Checking project settings for API key');
  
  // Handle config: it can be null (from database) or undefined, or a valid object
  // Skip if config is null or undefined - this means no API keys are configured
  if (settings?.config && typeof settings.config === 'object' && settings.config !== null && !Array.isArray(settings.config)) {
    const config = settings.config as Record<string, unknown>;
    const providerName = settings.provider?.toLowerCase();
    
    logger.debug({
      provider: providerName,
      configKeys: Object.keys(config),
      configKeysCount: Object.keys(config).length,
    }, 'Processing project settings config');
    
    // Try provider-specific key first (e.g., openaiApiKey, geminiApiKey, yandexApiKey)
    const providerKeyName = providerName ? `${providerName}ApiKey` : null;
    if (providerKeyName && providerKeyName in config) {
      apiKey = config[providerKeyName] as string;
      logger.debug({
        provider: providerName,
        keyFound: 'provider-specific',
        keyName: providerKeyName,
        keyLength: apiKey?.length ?? 0,
        hasKey: !!apiKey,
      }, 'Extracted provider-specific API key from project settings');
    }
    // Fallback to legacy apiKey field
    else if ('apiKey' in config) {
      apiKey = config.apiKey as string;
      logger.debug({
        provider: providerName,
        keyFound: 'legacy',
        keyLength: apiKey?.length ?? 0,
        hasKey: !!apiKey,
      }, 'Extracted legacy API key from project settings');
    } else {
      logger.warn({
        provider: providerName,
        configKeys: Object.keys(config),
        expectedKey: providerKeyName,
      }, 'No API key found in project settings config');
    }
    
    // Extract Yandex Folder ID if available
    if ('yandexFolderId' in config) {
      yandexFolderId = config.yandexFolderId as string;
      logger.debug({
        folderIdLength: yandexFolderId?.length ?? 0,
        hasFolderId: !!yandexFolderId,
      }, 'Extracted Yandex Folder ID from project settings');
    }
  } else {
    logger.warn({
      hasSettings: !!settings,
      hasConfig: !!(settings?.config),
      configType: typeof settings?.config,
      configIsNull: settings?.config === null,
      configIsUndefined: settings?.config === undefined,
      configIsArray: Array.isArray(settings?.config),
      provider: settings?.provider,
    }, 'Project settings config is not available or not an object');
  }

  return {
    projectMeta: {
      name: project.name,
      client: project.clientName,
      domain: project.domain,
      sourceLang: project.sourceLang ?? project.sourceLocale,
      targetLang: project.targetLang ?? project.targetLocales?.[0],
      summary: project.description,
    },
    settings,
    guidelines: normalizeGuidelines(guidelineRecord?.rules ?? null),
    glossary: mapGlossaryEntries(glossaryEntries),
    apiKey,
    yandexFolderId,
  };
};

const buildOrchestratorSegment = (
  segment: { id: string; sourceText: string; segmentIndex: number },
  previous?: { sourceText: string } | null,
  next?: { sourceText: string } | null,
  documentName?: string | null,
): OrchestratorSegment => ({
  segmentId: segment.id,
  sourceText: segment.sourceText,
  previousText: previous?.sourceText,
  nextText: next?.sourceText,
  documentName: documentName ?? undefined,
});

export const listAIProviders = () => listAvailableProviders();

export const getProjectAISettings = (projectId: string) =>
  prisma.projectAISetting.findUnique({
    where: { projectId },
  });

export const upsertProjectAISettings = (projectId: string, payload: ProjectAISettingsPayload) => {
  // Only include config if it's provided and not empty
  const configValue = payload.config && Object.keys(payload.config).length > 0 
    ? toJsonValue(payload.config) 
    : undefined;
  
  return prisma.projectAISetting.upsert({
    where: { projectId },
    update: {
      provider: payload.provider,
      model: payload.model,
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
      ...(configValue !== undefined ? { config: configValue } : {}),
    },
    create: {
      projectId,
      provider: payload.provider,
      model: payload.model,
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
      ...(configValue !== undefined ? { config: configValue } : {}),
    },
  });
};

export const getProjectGuidelines = async (projectId: string) => {
  const record = await prisma.projectGuideline.findUnique({ where: { projectId } });
  return record ?? { projectId, rules: [] };
};

export const upsertProjectGuidelines = (projectId: string, rules: unknown) =>
  prisma.projectGuideline.upsert({
    where: { projectId },
    update: { rules: rules as Prisma.InputJsonValue },
    create: { projectId, rules: rules as Prisma.InputJsonValue },
  });

type SegmentSuggestion = {
  segmentId: string;
  targetText: string;
  confidence: number;
  provider: TranslationProvider;
  source: 'memory' | 'llm' | 'rule';
};

export const generateSegmentSuggestions = async (documentId: string): Promise<SegmentSuggestion[]> => {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      segments: {
        orderBy: { segmentIndex: 'asc' },
        select: { id: true, sourceText: true, segmentIndex: true },
      },
    },
  });
  if (!document) {
    throw ApiError.notFound('Document not found');
  }

  const context = await buildAiContext(document.projectId);
  const suggestionMap = new Map<string, SegmentSuggestion>();
  const segmentsNeedingAI: OrchestratorSegment[] = [];
  const tmThreshold = 85;

  for (let i = 0; i < document.segments.length; i += 1) {
    const segment = document.segments[i];
    const neighbors = {
      previous: i > 0 ? document.segments[i - 1] : null,
      next: i < document.segments.length - 1 ? document.segments[i + 1] : null,
    };

    const tmMatches = await searchTranslationMemory({
      sourceText: segment.sourceText,
      sourceLocale: document.sourceLocale,
      targetLocale: document.targetLocale,
      projectId: document.projectId,
      limit: 1,
      minScore: tmThreshold,
    });
    const bestTm = tmMatches[0];
    if (bestTm) {
      suggestionMap.set(segment.id, {
        segmentId: segment.id,
        targetText: bestTm.targetText,
        confidence: bestTm.fuzzyScore / 100,
        provider: bestTm.scope === 'project' ? 'project-tm' : 'global-tm',
        source: 'memory',
      });
    } else {
      segmentsNeedingAI.push(
        buildOrchestratorSegment(segment, neighbors.previous, neighbors.next, document.name ?? undefined),
      );
    }
  }

  if (segmentsNeedingAI.length > 0) {
    const aiResults = await orchestrator.translateSegments({
      provider: context.settings?.provider,
      model: context.settings?.model,
      apiKey: context.apiKey,
      yandexFolderId: context.yandexFolderId,
      segments: segmentsNeedingAI,
      glossary: context.glossary,
      guidelines: context.guidelines,
      project: context.projectMeta,
      sourceLocale: document.sourceLocale, // Pass explicit source locale from document
      targetLocale: document.targetLocale, // Pass explicit target locale from document
      temperature: context.settings?.temperature ?? 0.2,
      maxTokens: context.settings?.maxTokens ?? 1024,
    });

    aiResults.forEach((result) => {
      suggestionMap.set(result.segmentId, {
        segmentId: result.segmentId,
        targetText: result.targetText,
        confidence: result.confidence,
        provider: result.provider,
        source: result.fallback ? 'rule' : 'llm',
      });
    });
  }

  return document.segments.map(
    (segment) =>
      suggestionMap.get(segment.id) ?? {
        segmentId: segment.id,
        targetText: segment.sourceText,
        confidence: 0.35,
        provider: 'rule-based',
        source: 'rule',
      },
  );
};

export const runQualityAssurance = async (documentId: string) => {
  const segments = await prisma.segment.findMany({
    where: { documentId },
    select: { id: true, sourceText: true, targetFinal: true },
  });

  return qaEngine.runChecks(
    segments.map((segment) => ({
      id: segment.id,
      sourceText: segment.sourceText,
      targetText: segment.targetFinal,
    })),
  );
};

export const runSegmentMachineTranslation = async (segmentId: string, options?: MachineTranslationOptions) => {
  const segment = await getSegmentWithDocument(segmentId);
  if (!segment || !segment.document) {
    throw ApiError.notFound('Segment not found');
  }

  const context = await buildAiContext(segment.document.projectId);
  const minScore = options?.minScore ?? 70;
  const tmAllowed = options?.applyTm ?? true;
  const glossaryMode = options?.glossaryMode ?? 'strict_source'; // Default to strict_source if not provided
  
  // Log glossary mode for debugging
  logger.info({
    segmentId: segment.id,
    glossaryMode,
  }, 'Using glossary mode for segment translation');

  let translationText: string | undefined;
  let fuzzyScore: number | null = null;
  let bestTmEntryId: string | null = null;
  const metadata: TranslationMetadata[] = [];

  // Priority 1: Check for direct TM match (≥70%)
  if (tmAllowed) {
    const tmMatches = await searchTranslationMemory({
      sourceText: segment.sourceText,
      sourceLocale: segment.document.sourceLocale,
      targetLocale: segment.document.targetLocale,
      projectId: segment.document.projectId,
      limit: 1,
      minScore,
    });
    const bestMatch = tmMatches[0];
    if (bestMatch) {
      translationText = bestMatch.targetText;
      fuzzyScore = bestMatch.fuzzyScore;
      bestTmEntryId = bestMatch.id;
      
      // Add metadata for TM direct match
      metadata.push({
        stage: 'tm-direct',
        priority: 1,
        source: 'tm-direct',
        tmDirectMatch: {
          id: bestMatch.id,
          sourceText: bestMatch.sourceText,
          targetText: bestMatch.targetText,
          fuzzyScore: bestMatch.fuzzyScore,
          searchMethod: bestMatch.searchMethod || 'fuzzy',
        },
        message: `Using direct TM match (${bestMatch.fuzzyScore}% similarity)`,
      });
    }
  }

  if (!translationText) {
    const neighborSegments = await prisma.segment.findMany({
      where: {
        documentId: segment.document.id,
        segmentIndex: {
          in: [segment.segmentIndex - 1, segment.segmentIndex + 1],
        },
      },
      select: { segmentIndex: true, sourceText: true },
    });
    const previous = neighborSegments.find((item) => item.segmentIndex === segment.segmentIndex - 1);
    const next = neighborSegments.find((item) => item.segmentIndex === segment.segmentIndex + 1);

    // Priority 3: Classic RAG - Retrieve TM examples for AI context (even if <70% threshold)
    // These examples help the AI learn translation style and terminology
    let tmExamples: TmExample[] = [];
    if (tmAllowed) {
      // Использовать настройки из TM Search Panel, если переданы, иначе использовать значения по умолчанию
      const ragMinScore = options?.tmRagSettings?.minScore ?? 50; // Default 50
      const ragVectorSimilarity = options?.tmRagSettings?.vectorSimilarity ?? 60; // Default 60
      const ragMode = options?.tmRagSettings?.mode ?? 'basic'; // Default basic
      const ragUseVectorSearch = options?.tmRagSettings?.useVectorSearch ?? true; // Default true
      const ragLimit = options?.tmRagSettings?.limit ?? 5; // Default 5

      const exampleMatches = await searchTranslationMemory({
        sourceText: segment.sourceText,
        sourceLocale: segment.document.sourceLocale,
        targetLocale: segment.document.targetLocale,
        projectId: segment.document.projectId,
        limit: ragLimit,
        minScore: ragMinScore,
        vectorSimilarity: ragVectorSimilarity,
        mode: ragMode,
        useVectorSearch: ragUseVectorSearch,
      });
      
      tmExamples = exampleMatches.map((match) => ({
        sourceText: match.sourceText,
        targetText: match.targetText,
        fuzzyScore: match.fuzzyScore,
        searchMethod: match.searchMethod || 'fuzzy',
      }));

      // Add metadata for TM RAG examples
      if (tmExamples.length > 0) {
        metadata.push({
          stage: 'ai-draft',
          priority: 3,
          source: 'tm-rag',
          tmExamples: tmExamples.map(ex => ({
            sourceText: ex.sourceText,
            targetText: ex.targetText,
            fuzzyScore: ex.fuzzyScore,
            searchMethod: ex.searchMethod || 'fuzzy',
          })),
          tmSearchSettings: {
            minScore: ragMinScore,
            vectorSimilarity: ragVectorSimilarity,
            mode: ragMode,
            useVectorSearch: ragUseVectorSearch,
            limit: ragLimit,
          },
          message: `Using ${tmExamples.length} TM example(s) for RAG context (${ragMinScore}%+ similarity)`,
        });
        
        logger.info({
          segmentId: segment.id,
          sourceText: segment.sourceText.substring(0, 50),
          exampleCount: tmExamples.length,
          topExample: tmExamples[0] ? {
            source: tmExamples[0].sourceText.substring(0, 50),
            target: tmExamples[0].targetText.substring(0, 50),
            score: tmExamples[0].fuzzyScore,
            method: tmExamples[0].searchMethod,
          } : null,
        }, 'Retrieved TM examples for Classic RAG');
      } else {
        logger.debug({
          segmentId: segment.id,
          sourceText: segment.sourceText.substring(0, 50),
        }, 'No TM examples found for Classic RAG');
      }
    }

    // Priority 2: Glossary entries - find which terms are actually in the source text
    if (context.glossary && context.glossary.length > 0) {
      const sourceTextLower = segment.sourceText.toLowerCase();
      const relevantGlossaryEntries = context.glossary
        .filter(entry => {
          const termLower = entry.term.toLowerCase();
          // Check if the term appears in the source text (case-insensitive)
          return sourceTextLower.includes(termLower);
        })
        .map(entry => ({
          sourceTerm: entry.term,
          targetTerm: entry.translation,
          mode: glossaryMode,
          isForbidden: entry.forbidden || false,
        }));

      if (relevantGlossaryEntries.length > 0) {
        metadata.push({
          stage: 'ai-draft',
          priority: 2,
          source: 'glossary',
          glossaryEntries: relevantGlossaryEntries,
          glossaryMode,
          message: `Found ${relevantGlossaryEntries.length} glossary term(s) in source text (mode: ${glossaryMode})`,
        });
      }
    }

    // Priority 4: Guidelines
    if (context.guidelines && context.guidelines.length > 0) {
      metadata.push({
        stage: 'ai-draft',
        priority: 4,
        source: 'guidelines',
        guidelinesCount: context.guidelines.length,
        message: `Using ${context.guidelines.length} guideline(s)`,
      });
    }

    // Priority 5: AI Translation
    metadata.push({
      stage: 'ai-draft',
      priority: 5,
      source: 'ai',
      message: `Generating AI translation using ${context.settings?.provider || 'default'} (${context.settings?.model || 'default model'})`,
    });

    const aiResult = await orchestrator.translateSingleSegment(
      buildOrchestratorSegment(segment, previous, next, segment.document.name),
      {
        provider: context.settings?.provider,
        model: context.settings?.model,
        apiKey: context.apiKey,
        yandexFolderId: context.yandexFolderId,
        glossary: context.glossary,
        guidelines: context.guidelines,
        tmExamples, // Pass examples for RAG
        project: context.projectMeta,
        sourceLocale: segment.document.sourceLocale, // Pass explicit source locale from document
        targetLocale: segment.document.targetLocale, // Pass explicit target locale from document
        temperature: context.settings?.temperature ?? 0.2,
        maxTokens: context.settings?.maxTokens ?? 1024,
        glossaryMode, // Pass glossary mode to orchestrator
      },
    );
    translationText = aiResult.targetText;
    fuzzyScore = Math.round((aiResult.confidence ?? 0.85) * 100);
    bestTmEntryId = null;
  }

  if (!translationText) {
    translationText = segment.sourceText;
  }

  const updatedSegment = await prisma.segment.update({
    where: { id: segmentId },
    data: {
      targetMt: translationText,
      fuzzyScore,
      bestTmEntryId,
      status: 'MT',
    },
    include: { document: true },
  });

  // Add metadata to the response (extend the Segment type in the API response)
  (updatedSegment as any).translationMetadata = metadata.sort((a, b) => a.priority - b.priority);

  return updatedSegment;
};

export const runSegmentMachineTranslationWithCritic = async (
  segmentId: string,
  options?: MachineTranslationOptions,
  onProgress?: (stage: 'draft' | 'critic' | 'editor' | 'complete', message?: string) => void,
) => {
  const segment = await getSegmentWithDocument(segmentId);
  if (!segment || !segment.document) {
    throw ApiError.notFound('Segment not found');
  }

  const context = await buildAiContext(segment.document.projectId);
  const minScore = options?.minScore ?? 70;
  const tmAllowed = options?.applyTm ?? true;
  const glossaryMode = options?.glossaryMode ?? 'strict_source';

  logger.info(
    {
      segmentId: segment.id,
      glossaryMode,
    },
    'Using critic workflow for segment translation',
  );

  // Get neighbor segments for context
  const neighborSegments = await prisma.segment.findMany({
    where: {
      documentId: segment.document.id,
      segmentIndex: {
        in: [segment.segmentIndex - 1, segment.segmentIndex + 1],
      },
    },
    select: { segmentIndex: true, sourceText: true },
  });
  const previous = neighborSegments.find((item) => item.segmentIndex === segment.segmentIndex - 1);
  const next = neighborSegments.find((item) => item.segmentIndex === segment.segmentIndex + 1);

  // Get TM examples for RAG
  let tmExamples: TmExample[] = [];
  if (tmAllowed) {
    // Использовать настройки из TM Search Panel, если переданы, иначе использовать значения по умолчанию
    const ragMinScore = options?.tmRagSettings?.minScore ?? 50; // Default 50
    const ragVectorSimilarity = options?.tmRagSettings?.vectorSimilarity ?? 60; // Default 60
    const ragMode = options?.tmRagSettings?.mode ?? 'basic'; // Default basic
    const ragUseVectorSearch = options?.tmRagSettings?.useVectorSearch ?? true; // Default true
    const ragLimit = options?.tmRagSettings?.limit ?? 5; // Default 5

    const exampleMatches = await searchTranslationMemory({
      sourceText: segment.sourceText,
      sourceLocale: segment.document.sourceLocale,
      targetLocale: segment.document.targetLocale,
      projectId: segment.document.projectId,
      limit: ragLimit,
      minScore: ragMinScore,
      vectorSimilarity: ragVectorSimilarity,
      mode: ragMode,
      useVectorSearch: ragUseVectorSearch,
    });

    tmExamples = exampleMatches.map((match) => ({
      sourceText: match.sourceText,
      targetText: match.targetText,
      fuzzyScore: match.fuzzyScore,
      searchMethod: match.searchMethod || 'fuzzy',
    }));
  }

  // In critic mode, always generate fresh AI translation (don't use TM matches directly)
  // TM examples are still used for RAG, but we always generate a complete translation
  // This ensures the translation is complete and accurate, not just a partial TM match
  logger.info(
    { segmentId: segment.id },
    'Critic mode: Generating fresh AI translation (TM examples used for RAG only)',
  );

  // Always use full critic workflow with AI translation
  // TM examples are passed for RAG context, but we don't use TM matches directly
  // Log context for debugging YandexGPT
  if (context.settings?.provider?.toLowerCase() === 'yandex') {
    logger.debug({
      provider: context.settings?.provider,
      hasApiKey: !!context.apiKey,
      apiKeyLength: context.apiKey?.length ?? 0,
      hasYandexFolderId: !!context.yandexFolderId,
      yandexFolderIdLength: context.yandexFolderId?.length ?? 0,
      sourceLocale: segment.document.sourceLocale,
      targetLocale: segment.document.targetLocale,
    }, 'YandexGPT: Starting translation with critic workflow');
  }
  
  const aiResult = await orchestrator.translateWithCritic(
    buildOrchestratorSegment(segment, previous, next, segment.document.name),
    {
      provider: context.settings?.provider,
      model: context.settings?.model,
      apiKey: context.apiKey,
      yandexFolderId: context.yandexFolderId,
      glossary: context.glossary,
      guidelines: context.guidelines,
      tmExamples, // TM examples used for RAG, but we always generate fresh translation
      project: context.projectMeta,
      sourceLocale: segment.document.sourceLocale, // Pass explicit source locale from document
      targetLocale: segment.document.targetLocale, // Pass explicit target locale from document
      temperature: context.settings?.temperature ?? 0.2,
      maxTokens: context.settings?.maxTokens ?? 1024,
      glossaryMode,
    },
    onProgress,
  );

  let translationText = aiResult.targetText;
  const fuzzyScore = Math.round((aiResult.confidence ?? 0.95) * 100);
  const bestTmEntryId = null; // Not using TM match directly in critic mode

  if (!translationText) {
    translationText = segment.sourceText;
  }

  const updatedSegment = await prisma.segment.update({
    where: { id: segmentId },
    data: {
      targetMt: translationText,
      fuzzyScore,
      bestTmEntryId,
      status: 'MT',
    },
    include: { document: true },
  });

  return updatedSegment;
};

export const runDocumentMachineTranslation = async (
  documentId: string,
  mode: 'translate_all' | 'pre_translate',
  options?: MachineTranslationOptions & { mtOnlyEmpty?: boolean },
) => {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      segments: {
        orderBy: { segmentIndex: 'asc' },
        select: { id: true, sourceText: true, segmentIndex: true, targetMt: true, targetFinal: true },
      },
    },
  });
  if (!document) {
    throw ApiError.notFound('Document not found');
  }

  const eligibleSegments = document.segments.filter((segment) => {
    if (mode === 'translate_all') {
      return true;
    }
    if (options?.mtOnlyEmpty) {
      return !segment.targetFinal && !segment.targetMt;
    }
    return !segment.targetFinal;
  });

  if (eligibleSegments.length === 0) {
    return { documentId, processed: 0, results: [] };
  }

  const context = await buildAiContext(document.projectId);
  const tmAllowed = options?.applyTm ?? true;
  const minScore = options?.minScore ?? 70;
  const glossaryMode = options?.glossaryMode ?? 'strict_source'; // Default to strict_source if not provided
  
  // Log glossary mode for debugging
  logger.info({
    documentId,
    mode,
    glossaryMode,
  }, 'Using glossary mode for document translation');

  const updates: Prisma.PrismaPromise<unknown>[] = [];
  const queuedForAI: { segment: typeof eligibleSegments[number]; previous?: typeof eligibleSegments[number]; next?: typeof eligibleSegments[number] }[] =
    [];
  const responseLog: Array<{ segmentId: string; targetMt: string | null }> = [];

  for (let i = 0; i < eligibleSegments.length; i += 1) {
    const segment = eligibleSegments[i];
    const neighbors = {
      previous: i > 0 ? eligibleSegments[i - 1] : undefined,
      next: i < eligibleSegments.length - 1 ? eligibleSegments[i + 1] : undefined,
    };

    if (tmAllowed) {
      // eslint-disable-next-line no-await-in-loop
      const tmMatches = await searchTranslationMemory({
        sourceText: segment.sourceText,
        sourceLocale: document.sourceLocale,
        targetLocale: document.targetLocale,
        projectId: document.projectId,
        limit: 1,
        minScore,
      });
      const bestTm = tmMatches[0];
      if (bestTm) {
        updates.push(
          prisma.segment.update({
            where: { id: segment.id },
            data: {
              targetMt: bestTm.targetText,
              fuzzyScore: bestTm.fuzzyScore,
              bestTmEntryId: bestTm.id,
              status: 'MT',
            },
          }),
        );
        responseLog.push({ segmentId: segment.id, targetMt: bestTm.targetText });
        continue;
      }
    }

    queuedForAI.push({ segment, previous: neighbors.previous, next: neighbors.next });
  }

  if (queuedForAI.length > 0) {
    // Classic RAG: Retrieve TM examples for each segment in parallel
    const examplePromises = queuedForAI.map(async (entry) => {
      if (!tmAllowed) {
        return { segmentId: entry.segment.id, examples: [] };
      }
      
      const exampleMatches = await searchTranslationMemory({
        sourceText: entry.segment.sourceText,
        sourceLocale: document.sourceLocale,
        targetLocale: document.targetLocale,
        projectId: document.projectId,
        limit: 5, // Top 5 examples per segment
        minScore: 50, // Lower threshold for examples
        vectorSimilarity: 60, // Include semantic matches
      });

      const examples: TmExample[] = exampleMatches.map((match) => ({
        sourceText: match.sourceText,
        targetText: match.targetText,
        fuzzyScore: match.fuzzyScore,
        searchMethod: match.searchMethod || 'fuzzy',
      }));

      return { segmentId: entry.segment.id, examples };
    });

    const exampleResults = await Promise.all(examplePromises);
    const examplesMap = new Map(exampleResults.map((r) => [r.segmentId, r.examples]));

    // Group segments by their examples (segments with same examples can share them)
    // For simplicity, we'll use examples from the first segment in each batch
    // In future, we could optimize this to group segments with similar examples
    const orchestratorSegments = queuedForAI.map((entry) =>
      buildOrchestratorSegment(entry.segment, entry.previous, entry.next, document.name ?? undefined),
    );
    
    // Use examples from the first segment for the batch (can be optimized later)
    // For now, we'll pass examples per segment if they're different
    // Since batch translation processes segments together, we'll use the first segment's examples
    const batchExamples = examplesMap.get(queuedForAI[0]?.segment.id) ?? [];

    const aiResults = await orchestrator.translateSegments({
      provider: context.settings?.provider,
      model: context.settings?.model,
      apiKey: context.apiKey,
      yandexFolderId: context.yandexFolderId,
      segments: orchestratorSegments,
      glossary: context.glossary,
      guidelines: context.guidelines,
      tmExamples: batchExamples, // Pass examples for RAG (using first segment's examples for batch)
      project: context.projectMeta,
      sourceLocale: document.sourceLocale, // Pass explicit source locale from document
      targetLocale: document.targetLocale, // Pass explicit target locale from document
      temperature: context.settings?.temperature ?? 0.2,
      maxTokens: context.settings?.maxTokens ?? 1024,
      glossaryMode, // Pass glossary mode to orchestrator
    });

    const resultMap = new Map(aiResults.map((result) => [result.segmentId, result]));

    queuedForAI.forEach((entry) => {
      const aiResult = resultMap.get(entry.segment.id);
      const targetText = aiResult?.targetText ?? entry.segment.sourceText;
      updates.push(
        prisma.segment.update({
          where: { id: entry.segment.id },
          data: {
            targetMt: targetText,
            fuzzyScore: aiResult ? Math.round((aiResult.confidence ?? 0.85) * 100) : null,
            bestTmEntryId: null,
            status: 'MT',
          },
        }),
      );
      responseLog.push({ segmentId: entry.segment.id, targetMt: targetText });
    });
  }

  if (updates.length > 0) {
    await prisma.$transaction(updates);
  }

  return {
    documentId,
    processed: responseLog.length,
    results: responseLog,
  };
};

export const pretranslateDocument = async (
  documentId: string,
  options?: {
    applyAiToLowMatches?: boolean; // Apply AI to segments with < 100% matches
    applyAiToEmptyOnly?: boolean; // Apply AI only to empty segments (no matches at all)
    rewriteConfirmed?: boolean; // Rewrite confirmed segments
    rewriteNonConfirmed?: boolean; // Rewrite non-confirmed but not empty segments
    glossaryMode?: GlossaryMode; // Glossary enforcement mode
  },
) => {
  const glossaryMode = options?.glossaryMode ?? 'strict_source'; // Default to strict_source if not provided
  
  // Log glossary mode for debugging
  logger.info({
    documentId,
    glossaryMode,
  }, 'Using glossary mode for pretranslation');
  const { createProgress, updateProgress, addResult, completeProgress, cancelProgress, isCancelled, setError, clearProgress } = await import('./pretranslateProgress');
  
  // Clear any old progress/cancellation flags before starting
  clearProgress(documentId);

  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      segments: {
        orderBy: { segmentIndex: 'asc' },
        select: {
          id: true,
          sourceText: true,
          segmentIndex: true,
          targetMt: true,
          targetFinal: true,
          status: true,
        },
      },
    },
  });
  if (!document) {
    throw ApiError.notFound('Document not found');
  }

  // Filter segments based on options
  const eligibleSegments = document.segments.filter((segment) => {
    const isEmpty = !segment.targetFinal && !segment.targetMt;
    const isConfirmed = segment.status === 'CONFIRMED';
    const isNonConfirmedButNotEmpty = !isEmpty && !isConfirmed;

    // Always include empty segments
    if (isEmpty) {
      return true;
    }

    // Include confirmed segments if rewriteConfirmed is true
    if (isConfirmed && options?.rewriteConfirmed) {
      return true;
    }

    // Include non-confirmed but not empty segments if rewriteNonConfirmed is true
    if (isNonConfirmedButNotEmpty && options?.rewriteNonConfirmed) {
      return true;
    }

    // Otherwise exclude
    return false;
  });

  // Initialize progress tracking BEFORE checking if segments are empty
  // This ensures progress exists even if there are no segments to process
  createProgress(documentId, eligibleSegments.length);

  // Declare variables outside try block so they're accessible in catch
  // Smaller batch size = more frequent saves = better preservation on cancellation
  const SAVE_BATCH_SIZE = 5;
  let pendingUpdates: Prisma.PrismaPromise<unknown>[] = [];
  let lastProgressUpdate = 0;
  const responseLog: Array<{
    segmentId: string;
    method: 'tm' | 'ai';
    targetMt: string | null;
    fuzzyScore?: number;
  }> = [];

  if (eligibleSegments.length === 0) {
    // Mark as completed immediately if no segments to process
    completeProgress(documentId);
    return {
      documentId,
      tmApplied: 0,
      aiApplied: 0,
      totalProcessed: 0,
      results: [],
    };
  }

  try {
    const context = await buildAiContext(document.projectId);
    const queuedForAI: {
      segment: typeof eligibleSegments[number];
      previous?: typeof eligibleSegments[number];
      next?: typeof eligibleSegments[number];
    }[] = [];

    // Step 1: Apply 100% TM matches
    for (let i = 0; i < eligibleSegments.length; i += 1) {
      const segment = eligibleSegments[i];
      
      // Update progress less frequently to prevent UI jumping (every 5 segments or on important milestones)
      const shouldUpdateProgress = i === 0 || i === eligibleSegments.length - 1 || (i - lastProgressUpdate) >= 5;
      if (shouldUpdateProgress) {
        updateProgress(documentId, {
          currentSegment: i + 1,
          currentSegmentId: segment.id,
          currentSegmentText: segment.sourceText.substring(0, 100) + (segment.sourceText.length > 100 ? '...' : ''),
        });
        lastProgressUpdate = i;
      }

      // Check for cancellation AFTER updating progress but BEFORE processing
      // This ensures we save any pending updates before stopping
      if (isCancelled(documentId)) {
        // Save any pending updates before cancelling
        if (pendingUpdates.length > 0) {
          await prisma.$transaction(pendingUpdates);
          pendingUpdates = [];
        }
        throw new Error('Pretranslation cancelled by user');
      }

      // eslint-disable-next-line no-await-in-loop
      const tmMatches = await searchTranslationMemory({
        sourceText: segment.sourceText,
        sourceLocale: document.sourceLocale,
        targetLocale: document.targetLocale,
        projectId: document.projectId,
        limit: 1,
        minScore: 100, // Only 100% matches
      });

      const perfectMatch = tmMatches[0];
      if (perfectMatch && perfectMatch.fuzzyScore === 100) {
        // Add to pending updates
        pendingUpdates.push(
          prisma.segment.update({
            where: { id: segment.id },
            data: {
              targetMt: perfectMatch.targetText,
              targetFinal: perfectMatch.targetText,
              fuzzyScore: 100,
              bestTmEntryId: perfectMatch.id && perfectMatch.id !== 'linked-' && !perfectMatch.id.startsWith('linked-') ? perfectMatch.id : null,
              status: 'MT',
            },
          }),
        );
        const result = {
          segmentId: segment.id,
          method: 'tm' as const,
          targetMt: perfectMatch.targetText,
          fuzzyScore: 100,
        };
        responseLog.push(result);
        addResult(documentId, result);

        // Save updates immediately to preserve progress on cancellation
        // Save in small batches to balance performance and safety
        if (pendingUpdates.length >= SAVE_BATCH_SIZE) {
          await prisma.$transaction(pendingUpdates);
          pendingUpdates = [];
        }
        
        // Also check for cancellation after saving to ensure we stop promptly
        if (isCancelled(documentId)) {
          // Save any remaining pending updates before cancelling
          if (pendingUpdates.length > 0) {
            await prisma.$transaction(pendingUpdates);
            pendingUpdates = [];
          }
          throw new Error('Pretranslation cancelled by user');
        }

        // Update progress counters less frequently
        if (responseLog.filter((r) => r.method === 'tm').length % 10 === 0 || i === eligibleSegments.length - 1) {
          updateProgress(documentId, { tmApplied: responseLog.filter((r) => r.method === 'tm').length });
        }
      } else {
        // No 100% match - check if we should queue for AI
        const hasLowMatch = tmMatches.length > 0 && tmMatches[0].fuzzyScore < 100;
        const hasNoMatch = tmMatches.length === 0;
        
        const shouldApplyAI =
          (options?.applyAiToLowMatches && (hasLowMatch || hasNoMatch)) || // Apply to < 100% matches OR empty segments
          (options?.applyAiToEmptyOnly && hasNoMatch); // Apply only to empty segments (no matches)

        if (shouldApplyAI) {
          const neighbors = {
            previous: i > 0 ? eligibleSegments[i - 1] : undefined,
            next: i < eligibleSegments.length - 1 ? eligibleSegments[i + 1] : undefined,
          };
          queuedForAI.push({ segment, previous: neighbors.previous, next: neighbors.next });
        }
      }
    }

    // Save any remaining pending updates from TM matches before AI processing
    // This is critical - ensure all processed segments are saved before proceeding
    if (pendingUpdates.length > 0) {
      await prisma.$transaction(pendingUpdates);
      pendingUpdates = [];
    }
    
    // Final check for cancellation before starting AI translation
    if (isCancelled(documentId)) {
      throw new Error('Pretranslation cancelled by user');
    }

    // Step 2: Apply AI translations if requested
    if (queuedForAI.length > 0 && context.settings) {
      // Process AI translations in batches to allow progress updates
      const batchSize = 10; // Process 10 segments at a time
      for (let i = 0; i < queuedForAI.length; i += batchSize) {
        // Check for cancellation before each batch
        if (isCancelled(documentId)) {
          // Save any pending updates before cancelling
          if (pendingUpdates.length > 0) {
            await prisma.$transaction(pendingUpdates);
            pendingUpdates = [];
          }
          console.log('Pretranslation cancelled - stopping AI translation batch processing');
          break; // Exit loop, updates already saved
        }

        const batch = queuedForAI.slice(i, i + batchSize);
        const orchestratorSegments = batch.map((entry) =>
          buildOrchestratorSegment(entry.segment, entry.previous, entry.next, document.name ?? undefined),
        );
        
        // Update progress for AI batch
        const aiStartIndex = eligibleSegments.findIndex((s) => s.id === batch[0].segment.id);
        if (aiStartIndex >= 0) {
          updateProgress(documentId, {
            currentSegment: aiStartIndex + 1,
            currentSegmentId: batch[0].segment.id,
            currentSegmentText: batch[0].segment.sourceText.substring(0, 100) + (batch[0].segment.sourceText.length > 100 ? '...' : ''),
          });
        }

        // eslint-disable-next-line no-await-in-loop
        const aiResults = await orchestrator.translateSegments({
          provider: context.settings.provider,
          model: context.settings.model,
          apiKey: context.apiKey,
          yandexFolderId: context.yandexFolderId,
          segments: orchestratorSegments,
          glossary: context.glossary,
          guidelines: context.guidelines,
          project: context.projectMeta,
          sourceLocale: document.sourceLocale, // Pass explicit source locale from document
          targetLocale: document.targetLocale, // Pass explicit target locale from document
          temperature: context.settings.temperature ?? 0.2,
          maxTokens: context.settings.maxTokens ?? 1024,
        });

        const resultMap = new Map(aiResults.map((result) => [result.segmentId, result]));

        batch.forEach((entry) => {
          const aiResult = resultMap.get(entry.segment.id);
          const targetText = aiResult?.targetText ?? entry.segment.sourceText;
          // Add to pending updates
          pendingUpdates.push(
            prisma.segment.update({
              where: { id: entry.segment.id },
              data: {
                targetMt: targetText,
                targetFinal: targetText,
                fuzzyScore: aiResult ? Math.round((aiResult.confidence ?? 0.85) * 100) : null,
                bestTmEntryId: null,
                status: 'MT',
              },
            }),
          );
          const result = {
            segmentId: entry.segment.id,
            method: 'ai' as const,
            targetMt: targetText,
            fuzzyScore: aiResult ? Math.round((aiResult.confidence ?? 0.85) * 100) : undefined,
          };
          responseLog.push(result);
          addResult(documentId, result);
        });

        // Save AI updates immediately after each batch to preserve on cancellation
        // This is critical - save before checking cancellation for next batch
        if (pendingUpdates.length > 0) {
          await prisma.$transaction(pendingUpdates);
          pendingUpdates = [];
        }
        
        // Check for cancellation AFTER saving this batch's updates
        if (isCancelled(documentId)) {
          console.log('Pretranslation cancelled - stopping after saving current batch');
          break; // Exit loop, updates already saved
        }

        // Update AI progress less frequently
        if (responseLog.filter((r) => r.method === 'ai').length % 10 === 0 || i + batchSize >= queuedForAI.length) {
          updateProgress(documentId, { aiApplied: responseLog.filter((r) => r.method === 'ai').length });
        }
      }
    }

    // Save any remaining pending updates
    if (pendingUpdates.length > 0) {
      await prisma.$transaction(pendingUpdates);
      pendingUpdates = [];
    }

    const tmApplied = responseLog.filter((r) => r.method === 'tm').length;
    const aiApplied = responseLog.filter((r) => r.method === 'ai').length;

    // Check if cancelled after processing
    if (isCancelled(documentId)) {
      cancelProgress(documentId);
      return {
        documentId,
        tmApplied,
        aiApplied,
        totalProcessed: responseLog.length,
        results: responseLog,
      };
    }

    completeProgress(documentId);

    return {
      documentId,
      tmApplied,
      aiApplied,
      totalProcessed: responseLog.length,
      results: responseLog,
    };
  } catch (error: any) {
    // Updates are already saved incrementally, but ensure any remaining pending updates are saved
    if (pendingUpdates.length > 0) {
      try {
        await prisma.$transaction(pendingUpdates);
        pendingUpdates = [];
      } catch (txError) {
        console.error('Error saving final updates after cancellation:', txError);
      }
    }

    if (error.message === 'Pretranslation cancelled by user' || isCancelled(documentId)) {
      cancelProgress(documentId);
      const tmApplied = responseLog.filter((r) => r.method === 'tm').length;
      const aiApplied = responseLog.filter((r) => r.method === 'ai').length;
      // Final progress update with saved counts
      updateProgress(documentId, {
        tmApplied,
        aiApplied,
        currentSegment: responseLog.length,
      });
      return {
        documentId,
        tmApplied,
        aiApplied,
        totalProcessed: responseLog.length,
        results: responseLog,
      };
    }
    setError(documentId, error.message || 'Unknown error');
    throw error;
  }
};

export const createAIRequest = async (
  documentId: string,
  type: 'TRANSLATION' | 'QA' | 'SUMMARY',
  payload: Record<string, unknown>,
) => {
  const document = await prisma.document.findUnique({ where: { id: documentId } });
  if (!document) {
    throw ApiError.notFound('Document not found');
  }
  return prisma.aIRequest.create({
    data: {
      documentId,
      type,
      status: 'QUEUED',
      payload: payload as any,
    },
  });
};

export const getAIRequest = async (requestId: string) => {
  const request = await prisma.aIRequest.findUnique({
    where: { id: requestId },
    include: { document: true },
  });
  if (!request) {
    throw ApiError.notFound('AI request not found');
  }
  return request;
};

export const listAIRequests = async (documentId?: string) => {
  return prisma.aIRequest.findMany({
    where: documentId ? { documentId } : undefined,
    orderBy: { createdAt: 'desc' },
    include: { document: { select: { id: true, name: true } } },
  });
};

export const updateAIRequestStatus = async (
  requestId: string,
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED',
  result?: Record<string, unknown>,
) => {
  const request = await prisma.aIRequest.findUnique({ where: { id: requestId } });
  if (!request) {
    throw ApiError.notFound('AI request not found');
  }
  return prisma.aIRequest.update({
    where: { id: requestId },
    data: {
      status,
      result: result as any,
      completedAt: status === 'COMPLETED' || status === 'FAILED' ? new Date() : undefined,
    },
  });
};

type DirectTranslationRequest = {
  sourceText: string;
  sourceLocale: string;
  targetLocale: string;
  projectId?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  glossaryMode?: GlossaryMode;
};

export const translateTextDirectly = async (request: DirectTranslationRequest) => {
  const context = request.projectId ? await buildAiContext(request.projectId) : null;
  
  const provider = request.provider ?? context?.settings?.provider;
  const model = request.model ?? context?.settings?.model;
  const apiKey = context?.apiKey; // Use project-specific API key if available
  const temperature = request.temperature ?? context?.settings?.temperature ?? 0.2;
  const maxTokens = request.maxTokens ?? context?.settings?.maxTokens ?? 1024;
  const glossaryMode = request.glossaryMode ?? 'strict_source';
  const glossary = context?.glossary ?? [];
  const guidelines = context?.guidelines ?? [];
  const projectMeta = context?.projectMeta ?? {
    sourceLang: request.sourceLocale,
    targetLang: request.targetLocale,
  };

  // Classic RAG: Retrieve TM examples for AI context
  let tmExamples: TmExample[] = [];
  if (request.projectId) {
    try {
      const exampleMatches = await searchTranslationMemory({
        sourceText: request.sourceText,
        sourceLocale: request.sourceLocale,
        targetLocale: request.targetLocale,
        projectId: request.projectId,
        limit: 5, // Get top 5 examples
        minScore: 50, // Lower threshold for examples
        vectorSimilarity: 60, // Include semantic matches
      });
      
      tmExamples = exampleMatches.map((match) => ({
        sourceText: match.sourceText,
        targetText: match.targetText,
        fuzzyScore: match.fuzzyScore,
        searchMethod: match.searchMethod || 'fuzzy',
      }));

      // Log examples for debugging
      if (tmExamples.length > 0) {
        logger.info({
          sourceText: request.sourceText.substring(0, 50),
          exampleCount: tmExamples.length,
          topExample: tmExamples[0] ? {
            source: tmExamples[0].sourceText.substring(0, 50),
            target: tmExamples[0].targetText.substring(0, 50),
            score: tmExamples[0].fuzzyScore,
            method: tmExamples[0].searchMethod,
          } : null,
        }, 'Retrieved TM examples for Classic RAG (direct translation)');
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to retrieve TM examples for direct translation');
    }
  }

  const segment: OrchestratorSegment = {
    segmentId: 'direct-translation',
    sourceText: request.sourceText,
    previousText: undefined,
    nextText: undefined,
    documentName: undefined,
  };

  const aiResult = await orchestrator.translateSingleSegment(segment, {
    provider,
    model,
    apiKey,
    yandexFolderId: context?.yandexFolderId,
    glossary,
    guidelines,
    tmExamples, // Pass examples for RAG
    project: projectMeta,
    sourceLocale: request.sourceLocale, // Pass explicit source locale
    targetLocale: request.targetLocale, // Pass explicit target locale
    temperature,
    maxTokens,
    glossaryMode, // Pass glossary mode to orchestrator
  });

  return {
    targetText: aiResult.targetText,
    provider: aiResult.provider,
    model: aiResult.model,
    confidence: aiResult.confidence,
    usage: aiResult.usage,
  };
};

// Interactive Critic Workflow - Step 1: Generate Draft
export const generateDraftTranslation = async (request: {
  sourceText: string;
  projectId?: string;
  sourceLocale?: string;
  targetLocale?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
}) => {
  const context = request.projectId ? await buildAiContext(request.projectId) : null;
  
  const provider = request.provider ?? context?.settings?.provider;
  const model = request.model ?? context?.settings?.model;
  const apiKey = request.apiKey ?? context?.apiKey;
  const temperature = request.temperature ?? context?.settings?.temperature ?? 0.2;
  const maxTokens = request.maxTokens ?? context?.settings?.maxTokens ?? 1024;
  const glossary = context?.glossary ?? [];
  const guidelines = context?.guidelines ?? [];
  const projectMeta = context?.projectMeta ?? {
    sourceLang: request.sourceLocale,
    targetLang: request.targetLocale,
  };

  // Get TM examples for RAG (but don't use them as direct matches)
  let tmExamples: TmExample[] = [];
  if (request.projectId && request.sourceLocale && request.targetLocale) {
    try {
      const exampleMatches = await searchTranslationMemory({
        sourceText: request.sourceText,
        sourceLocale: request.sourceLocale,
        targetLocale: request.targetLocale,
        projectId: request.projectId,
        limit: 5,
        minScore: 50,
        vectorSimilarity: 60,
      });
      
      tmExamples = exampleMatches.map((match) => ({
        sourceText: match.sourceText,
        targetText: match.targetText,
        fuzzyScore: match.fuzzyScore,
        searchMethod: match.searchMethod || 'fuzzy',
      }));
    } catch (error) {
      logger.warn({ error }, 'Failed to retrieve TM examples for draft generation');
    }
  }

  const result = await orchestrator.generateDraft(request.sourceText, {
    provider,
    model,
    apiKey,
    yandexFolderId: context?.yandexFolderId,
    glossary,
    guidelines,
    tmExamples,
    project: projectMeta,
    sourceLocale: request.sourceLocale,
    targetLocale: request.targetLocale,
    temperature,
    maxTokens,
  });

  return result;
};

// Interactive Critic Workflow - Step 2: Run Critique
export const runCritiqueCheck = async (request: {
  sourceText: string;
  draftText: string;
  projectId?: string;
  sourceLocale?: string;
  targetLocale?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
}) => {
  const context = request.projectId ? await buildAiContext(request.projectId) : null;
  
  const provider = request.provider ?? context?.settings?.provider;
  const model = request.model ?? context?.settings?.model;
  const apiKey = request.apiKey ?? context?.apiKey;
  
  // Filter glossary by locale if provided
  let glossary = context?.glossary ?? [];
  if (request.sourceLocale && request.targetLocale && glossary.length > 0) {
    // Get filtered glossary entries from database
    const filteredEntries = await prisma.glossaryEntry.findMany({
      where: {
        OR: [
          { projectId: request.projectId ?? null },
          { projectId: null }, // Global entries
        ],
        sourceLocale: request.sourceLocale,
        targetLocale: request.targetLocale,
      },
      select: {
        sourceTerm: true,
        targetTerm: true,
        isForbidden: true,
        notes: true,
      },
    });
    
    glossary = mapGlossaryEntries(filteredEntries);
    
    logger.debug({
      originalGlossaryCount: context?.glossary?.length || 0,
      filteredGlossaryCount: glossary.length,
      sourceLocale: request.sourceLocale,
      targetLocale: request.targetLocale,
    }, 'Filtered glossary by locale for critique');
  }

  logger.info({
    glossaryCount: glossary.length,
    glossarySample: glossary.slice(0, 3).map(g => ({ term: g.term, translation: g.translation })),
    sourceTextLength: request.sourceText.length,
    draftTextLength: request.draftText.length,
    sourceLocale: request.sourceLocale,
    targetLocale: request.targetLocale,
  }, 'Running critique check with glossary');

  const result = await orchestrator.runCritique(
    request.sourceText,
    request.draftText,
    glossary,
    { 
      provider, 
      model, 
      apiKey,
      yandexFolderId: context?.yandexFolderId,
      sourceLocale: request.sourceLocale,
      targetLocale: request.targetLocale,
    },
  );

  return result;
};

// Interactive Critic Workflow - Step 3: Fix Translation
export const fixTranslationWithErrors = async (request: {
  sourceText: string;
  draftText: string;
  errors: Array<{ term: string; expected: string; found: string; severity: string }>;
  projectId?: string;
  sourceLocale?: string;
  targetLocale?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
}) => {
  const context = request.projectId ? await buildAiContext(request.projectId) : null;
  
  const provider = request.provider ?? context?.settings?.provider;
  const model = request.model ?? context?.settings?.model;
  const apiKey = request.apiKey ?? context?.apiKey;
  const temperature = request.temperature ?? context?.settings?.temperature ?? 0.2;
  const maxTokens = request.maxTokens ?? context?.settings?.maxTokens ?? 1024;
  const glossary = context?.glossary ?? [];
  const guidelines = context?.guidelines ?? [];
  const projectMeta = context?.projectMeta ?? {};
  
  // Get locales from request or project context
  const sourceLocale = request.sourceLocale ?? projectMeta.sourceLang ?? 'ru';
  const targetLocale = request.targetLocale ?? projectMeta.targetLang ?? 'en';

  const result = await orchestrator.fixTranslation(
    request.sourceText,
    request.draftText,
    request.errors,
    {
      provider,
      model,
      apiKey,
      yandexFolderId: context?.yandexFolderId,
      temperature,
      maxTokens,
      glossary,
      sourceLocale,
      targetLocale,
    },
  );

  return result;
};

export type PostEditQACheck = {
  segment: string;
  issue: string;
  severity: 'warning' | 'error';
  suggestion: string;
};

export type PostEditQAResult = {
  checks: PostEditQACheck[];
};

type PostEditQARequest = {
  sourceText: string;
  targetText: string;
  sourceLocale: string;
  targetLocale: string;
  projectId?: string;
  provider?: string;
  model?: string;
  glossary?: Array<{ sourceTerm: string; targetTerm: string; isForbidden?: boolean }>;
};

export const runPostEditQA = async (request: PostEditQARequest): Promise<PostEditQAResult> => {
  const context = request.projectId ? await buildAiContext(request.projectId) : null;
  
  const provider = request.provider ?? context?.settings?.provider ?? 'gemini';
  const model = request.model ?? context?.settings?.model;
  const apiKey = context?.apiKey;
  const temperature = 0.1; // Low temperature for consistent QA checks
  const maxTokens = 2048; // Enough for detailed checks

  // Build glossary list for the prompt
  const glossaryEntries = request.glossary ?? (context?.glossary ? context.glossary.map((g) => ({
    sourceTerm: g.term,
    targetTerm: g.translation,
    isForbidden: g.forbidden ?? false,
  })) : []);
  const glossaryText = glossaryEntries.length > 0
    ? glossaryEntries.map((g) => `- "${g.sourceTerm}" → "${g.targetTerm}"${g.isForbidden ? ' (FORBIDDEN)' : ''}`).join('\n')
    : 'No glossary terms provided.';

  // Build the QA prompt
  const qaPrompt = `You are a Post-Edit QA Agent for bilingual translations.

Your task:
Review the translation ("targetText") against the original ("sourceText") and return a structured list of issues.

You MUST:
- Focus on correctness, consistency, terminology, numbers, units, and structure.
- Use the glossary STRICTLY when provided.
- Be concise and technical in descriptions and suggestions.
- Work reliably for Russian ↔ English, but also support other language pairs.

YOUR OUTPUT FORMAT (VERY IMPORTANT):
You MUST respond **only** with a single valid JSON object, with this structure:

{
  "checks": [
    {
      "segment": "<short fragment of the target text or term>",
      "issue": "<what is wrong and why it is wrong>",
      "severity": "warning" or "error",
      "suggestion": "<recommended corrected wording in the target language>"
    }
  ]
}

Rules for JSON:
- Do NOT wrap JSON in markdown code fences. No \`\`\` at all.
- No comments, no trailing commas.
- If there are NO issues, return: { "checks": [] }

Field meanings:
- "segment": a short snippet from the TARGET text where the problem occurs (or the problematic term/phrase).
- "issue": clear, human-readable explanation of the problem, in English. Mention the source term if relevant.
- "severity":
  - "error" = serious error (wrong term, meaning change, mistranslation, wrong number, broken tag, etc.).
  - "warning" = non-critical issue (style, preferred terminology, minor inconsistency).
- "suggestion": provide a concrete corrected version in the TARGET language. If the issue is about a term, include the correct term in context.

WHAT TO CHECK:

1) Glossary and terminology
- If glossary is provided, all glossary terms from sourceText MUST be translated exactly as in the glossary.
- If a different translation is used where a glossary term exists, this is an "error".
- If multiple inconsistent translations of the same term appear, mark them as "warning" and suggest the glossary or dominant consistent form.
- Flag forbidden or undesired variants, if they are explicitly mentioned or obviously conflict with the glossary.

2) Meaning and critical mistranslation
- Check that the core meaning of the source is preserved.
- Flag as "error" any mistranslation that:
  - reverses meaning,
  - omits critical information,
  - adds information not present in the source,
  - misrepresents technical or legal content.
- In "issue", briefly explain what was distorted.
- In "suggestion", provide the corrected translation fragment.

3) Numbers, dates, and units
- Compare all numbers in sourceText and targetText.
- Flag as "error":
  - changed numbers,
  - missing numbers,
  - added numbers that are not justified.
- Check units of measure (kV, MW, kWh, %, km, etc.) and dates.
- Check decimal separators and thousand separators if they obviously conflict with targetLocale norms.

4) Structure, tags, placeholders (if present)
- If the text contains tags, placeholders, or structured markers (e.g. {0}, %s, <tag>…</tag>, XML-like structures):
  - They MUST appear in the targetText and must not be altered.
  - Flag as "error" any:
    - removed tags/placeholders,
    - added tags/placeholders,
    - reordered or malformed tags/placeholders.
- If segments are clearly delimited (e.g. numbered items, bullet points), check that the structure is preserved.

5) Consistency inside the text
- Check that repeated phrases, terms, and names are translated consistently.
- If the same expression appears multiple times with different translations without a clear reason, mark as "warning" and suggest a consistent option.
- Check that naming of entities (companies, departments, projects, equipment) is consistent.

6) Style and register (technical/business)
- Target style should be formal, technical/business-like.
- Flag as "warning":
  - overly colloquial language,
  - inconsistent register (mixing very casual and very formal in one document),
  - obvious style clashes with standard technical/business English.
- Do NOT enforce subjective stylistic preferences; only flag clear deviations from professional formal style.

7) Omissions and additions
- Flag as "error":
  - important sentences or clauses missing in the translation,
  - whole items in lists omitted,
  - critical conditions or restrictions left out.
- Flag as "error" or "warning" (depending on impact) if the translator adds content that significantly changes the meaning or introduces unwarranted assumptions.

HOW TO DECIDE SEVERITY:

Treat as **error**:
- Glossary term is not used when it should be.
- Wrong or misleading technical term.
- Wrong or altered number, unit, or date.
- Broken or missing tags/placeholders (if present).
- Strong mistranslation that changes meaning.
- Omission or serious addition that affects legal/technical content.

Treat as **warning**:
- Inconsistent but still understandable terminology.
- Style issues (too colloquial, slightly awkward).
- Minor redundancies or slightly clumsy phrasing that does not change meaning.

OUTPUT BEHAVIOR EXAMPLES:

If you find a glossary violation:
{
  "checks": [
    {
      "segment": "rehabilitation of the substation",
      "issue": "Glossary term 'реконструкция' must be translated as 'rehabilitation'. The current translation uses a different term.",
      "severity": "error",
      "suggestion": "rehabilitation of the substation"
    }
  ]
}

If there are multiple issues, return them all in the "checks" array.

If NO issues are found:
{
  "checks": []
}

IMPORTANT CONSTRAINTS:
- ALWAYS return ONLY the JSON object as described.
- NO extra text, NO explanations outside of JSON.
- NO markdown fences (no \`\`\`).
- Ensure the JSON is syntactically valid.
- Prefer fewer, clear, high-quality checks over many vague ones.

Source Text (${request.sourceLocale}):
${request.sourceText}

Target Text (${request.targetLocale}):
${request.targetText}

${glossaryText !== 'No glossary terms provided.' ? `Glossary Terms:
${glossaryText}` : 'No glossary terms provided.'}

Analyze the translation and return ONLY the JSON object with all detected issues.`;

  try {
    const aiProvider = getProvider(provider, apiKey, context?.yandexFolderId);
    
    const response = await aiProvider.callModel({
      prompt: qaPrompt,
      model,
      temperature,
      maxTokens,
      segments: [{ segmentId: 'qa-check', sourceText: request.sourceText }],
    });

    // Parse the JSON response
    let outputText = response.outputText.trim();
    
    // Remove markdown code blocks if present
    if (outputText.startsWith('```json')) {
      outputText = outputText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    } else if (outputText.startsWith('```')) {
      outputText = outputText.replace(/^```\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(outputText) as PostEditQAResult;
    
    // Validate structure
    if (!parsed.checks || !Array.isArray(parsed.checks)) {
      logger.warn({ outputText }, 'Invalid QA response structure');
      return { checks: [] };
    }

    // Validate each check
    const validChecks = parsed.checks.filter((check) => {
      return (
        typeof check.segment === 'string' &&
        typeof check.issue === 'string' &&
        (check.severity === 'warning' || check.severity === 'error') &&
        typeof check.suggestion === 'string'
      );
    });

    logger.info(
      {
        sourceText: request.sourceText.substring(0, 50),
        checkCount: validChecks.length,
      },
      'Post-Edit QA completed',
    );

    return { checks: validChecks };
  } catch (error) {
    logger.error({ error, sourceText: request.sourceText.substring(0, 50) }, 'Post-Edit QA failed');
    // Return empty checks on error
    return { checks: [] };
  }
};

export const testAICredentials = async (provider: string, apiKey?: string, yandexFolderId?: string) => {
  const { env } = await import('../utils/env');
  
  try {
    const aiProvider = getProvider(provider, apiKey, yandexFolderId);
    
    // Create a simple test request
    const testRequest = {
      prompt: 'Translate "Hello" to Spanish. Return JSON: [{"segment_id":"test","target_mt":"Hola"}]',
      segments: [{ segmentId: 'test', sourceText: 'Hello' }],
    };
    
    const response = await aiProvider.callModel(testRequest);
    
    // Check if we got a valid response (not a mock)
    const isMock = response.usage?.metadata?.mock === true;
    
    return {
      success: !isMock,
      message: isMock 
        ? 'Credentials are invalid or missing. Using mock response.' 
        : 'Credentials are valid.',
      provider,
      hasApiKey: !!apiKey,
      hasYandexFolderId: !!yandexFolderId,
    };
  } catch (error) {
    logger.error({ error, provider }, 'Failed to test AI credentials');
    return {
      success: false,
      message: `Error testing credentials: ${(error as Error).message}`,
      provider,
      hasApiKey: !!apiKey,
      hasYandexFolderId: !!yandexFolderId,
    };
  }
};
 