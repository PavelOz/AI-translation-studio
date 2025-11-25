import { prisma } from '../db/prisma';
import { ApiError } from '../utils/apiError';
import { getProvider } from '../ai/providers/registry';
import { getDocument } from './document.service';
import { getSegment } from './segment.service';
import { getDocumentSegments } from './segment.service';
import { upsertProjectGuidelines, getProjectAISettings } from './ai.service';
import { getLanguageName } from '../utils/languages';
import type { OrchestratorGlossaryEntry } from '../ai/orchestrator';

export type ChatMessageInput = {
  projectId: string;
  documentId?: string;
  segmentId?: string;
  message: string;
};

export type ChatMessageResponse = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
  metadata?: Record<string, unknown>;
};

export type ChatContext = {
  projectId: string;
  documentId?: string;
  segmentId?: string;
  documentName?: string;
  currentSegment?: {
    index: number;
    sourceText: string;
    targetText?: string;
  };
  previousSegments?: Array<{ sourceText: string; targetText?: string }>;
  nextSegments?: Array<{ sourceText: string; targetText?: string }>;
};

const buildChatContext = async (input: ChatMessageInput): Promise<ChatContext> => {
  const context: ChatContext = {
    projectId: input.projectId,
    documentId: input.documentId,
    segmentId: input.segmentId,
  };

  if (input.documentId) {
    const document = await getDocument(input.documentId);
    if (document) {
      context.documentName = document.name;
    }
  }

  if (input.segmentId) {
    const segment = await getSegment(input.segmentId);
    if (segment) {
      context.currentSegment = {
        index: segment.segmentIndex,
        sourceText: segment.sourceText,
        targetText: segment.targetFinal || segment.targetMt,
      };

      // Get neighboring segments for context
      if (input.documentId) {
        const allSegments = await getDocumentSegments(input.documentId, 1, 1000);
        const segmentIndex = segment.segmentIndex;
        context.previousSegments = allSegments.segments
          .filter((s) => s.segmentIndex < segmentIndex)
          .slice(-3)
          .map((s) => ({
            sourceText: s.sourceText,
            targetText: s.targetFinal || s.targetMt,
          }));
        context.nextSegments = allSegments.segments
          .filter((s) => s.segmentIndex > segmentIndex)
          .slice(0, 3)
          .map((s) => ({
            sourceText: s.sourceText,
            targetText: s.targetFinal || s.targetMt,
          }));
      }
    }
  }

  return context;
};

// Build AI context similar to ai.service.ts but for chat
const buildChatAiContext = async (projectId: string) => {
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

  // Extract API key from project settings config if available
  let apiKey: string | undefined;
  if (settings?.config && typeof settings.config === 'object') {
    const config = settings.config as Record<string, unknown>;
    const providerName = settings.provider?.toLowerCase();
    
    if (providerName && `${providerName}ApiKey` in config) {
      apiKey = config[`${providerName}ApiKey`] as string;
    } else if ('apiKey' in config) {
      apiKey = config.apiKey as string;
    }
  }

  // Normalize guidelines
  const normalizeGuidelines = (rules: any): string[] => {
    if (!rules) return [];
    if (Array.isArray(rules)) {
      return rules.map((rule) => {
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

  // Map glossary entries
  const mapGlossaryEntries = (
    entries: Array<{ sourceTerm: string; targetTerm: string; isForbidden: boolean; notes: string | null }>,
  ): OrchestratorGlossaryEntry[] =>
    entries.map((entry) => ({
      term: entry.sourceTerm,
      translation: entry.targetTerm,
      forbidden: entry.isForbidden,
      notes: entry.notes,
    }));

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
  };
};

const buildChatPrompt = (
  userMessage: string,
  context: ChatContext,
  aiContext: Awaited<ReturnType<typeof buildChatAiContext>>,
  chatHistory: Array<{ role: string; content: string }>,
): string => {
  const sourceLang = getLanguageName(aiContext.projectMeta.sourceLang);
  const targetLang = getLanguageName(aiContext.projectMeta.targetLang);

  const promptParts = [
    'You are an AI translation assistant helping a professional translator work on a document.',
    '',
    '=== PROJECT CONTEXT ===',
    `Project: ${aiContext.projectMeta.name ?? 'Translation Project'}`,
    `Client: ${aiContext.projectMeta.client ?? 'N/A'}`,
    `Domain: ${aiContext.projectMeta.domain ?? 'general'}`,
    `Translation direction: ${sourceLang} → ${targetLang}`,
    '',
  ];

  if (context.documentName) {
    promptParts.push(`Current document: ${context.documentName}`);
  }

  if (context.currentSegment) {
    promptParts.push(
      '',
      '=== CURRENT SEGMENT ===',
      `Segment ${context.currentSegment.index + 1}:`,
      `Source: ${context.currentSegment.sourceText}`,
    );
    if (context.currentSegment.targetText) {
      promptParts.push(`Current translation: ${context.currentSegment.targetText}`);
    }
  }

  if (context.previousSegments && context.previousSegments.length > 0) {
    promptParts.push(
      '',
      '=== PREVIOUS SEGMENTS (for context) ===',
      ...context.previousSegments.map(
        (seg, idx) =>
          `${context.currentSegment!.index - context.previousSegments!.length + idx + 1}. ${seg.sourceText} → ${seg.targetText || '[not translated]'}`,
      ),
    );
  }

  if (context.nextSegments && context.nextSegments.length > 0) {
    promptParts.push(
      '',
      '=== NEXT SEGMENTS (for context) ===',
      ...context.nextSegments.map(
        (seg, idx) =>
          `${context.currentSegment!.index + idx + 2}. ${seg.sourceText} → ${seg.targetText || '[not translated]'}`,
      ),
    );
  }

  if (aiContext.guidelines.length > 0) {
    promptParts.push(
      '',
      '=== PROJECT GUIDELINES ===',
      ...aiContext.guidelines.map((guideline, idx) => `${idx + 1}. ${guideline}`),
    );
  }

  if (aiContext.glossary.length > 0) {
    promptParts.push(
      '',
      '=== GLOSSARY ===',
      ...aiContext.glossary
        .slice(0, 50)
        .map((entry) => `${entry.term} → ${entry.translation}${entry.forbidden ? ' (FORBIDDEN)' : ''}`),
    );
  }

  if (chatHistory.length > 0) {
    promptParts.push(
      '',
      '=== CONVERSATION HISTORY ===',
      ...chatHistory.slice(-10).map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`),
    );
  }

  promptParts.push(
    '',
    '=== USER MESSAGE ===',
    userMessage,
    '',
    'Please respond helpfully. If the user establishes translation rules or preferences, acknowledge them clearly. You can suggest improvements, answer questions about translation choices, or help refine the translation approach.',
  );

  return promptParts.join('\n');
};

const extractRulesFromResponse = (response: string): string[] => {
  const rules: string[] = [];
  
  // Look for patterns like "Remember to...", "Always...", "Use...", "Avoid..."
  const rulePatterns = [
    /(?:remember|always|use|avoid|never|should|must)\s+[^.!?]+[.!?]/gi,
    /(?:rule|guideline|preference|style):\s*([^.!?]+[.!?])/gi,
    /(?:when|if)\s+[^.!?]+(?:then|use|translate)[^.!?]+[.!?]/gi,
  ];

  for (const pattern of rulePatterns) {
    const matches = response.match(pattern);
    if (matches) {
      rules.push(...matches.map((m) => m.trim()));
    }
  }

  return rules;
};

export const sendChatMessage = async (
  input: ChatMessageInput,
  userId: string,
): Promise<ChatMessageResponse> => {
  // Build context
  const context = await buildChatContext(input);
  const aiContext = await buildChatAiContext(input.projectId);

  // Get recent chat history
  const recentMessages = await prisma.chatMessage.findMany({
    where: {
      projectId: input.projectId,
      ...(input.documentId && { documentId: input.documentId }),
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      role: true,
      content: true,
    },
  });

  const chatHistory = recentMessages.reverse().map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));

  // Build prompt
  const prompt = buildChatPrompt(input.message, context, aiContext, chatHistory);

  // Get AI provider
  const provider = getProvider(aiContext.settings?.provider, aiContext.apiKey);
  const model = aiContext.settings?.model ?? provider.defaultModel;

  // Call AI
  const aiResponse = await provider.callModel({
    prompt,
    model,
    temperature: aiContext.settings?.temperature ?? 0.7,
    maxTokens: aiContext.settings?.maxTokens ?? 2048,
  });

  const assistantResponse = aiResponse.outputText.trim();

  // Save user message
  const userMessage = await prisma.chatMessage.create({
    data: {
      projectId: input.projectId,
      documentId: input.documentId,
      segmentId: input.segmentId,
      role: 'user',
      content: input.message,
    },
  });

  // Extract rules from response
  const extractedRules = extractRulesFromResponse(assistantResponse);
  const metadata: Record<string, unknown> = {};
  if (extractedRules.length > 0) {
    metadata.extractedRules = extractedRules;
  }

  // Save assistant response
  const assistantMessage = await prisma.chatMessage.create({
    data: {
      projectId: input.projectId,
      documentId: input.documentId,
      segmentId: input.segmentId,
      role: 'assistant',
      content: assistantResponse,
      metadata: metadata as any,
    },
  });

  // If rules were extracted, offer to save them (but don't auto-save - let user decide)
  if (extractedRules.length > 0) {
    // Rules are stored in metadata, frontend can prompt user to save them
  }

  return {
    id: assistantMessage.id,
    role: 'assistant',
    content: assistantResponse,
    createdAt: assistantMessage.createdAt,
    metadata: extractedRules.length > 0 ? { extractedRules } : undefined,
  };
};

export const getChatHistory = async (
  projectId: string,
  documentId?: string,
  segmentId?: string,
  limit = 50,
): Promise<ChatMessageResponse[]> => {
  const messages = await prisma.chatMessage.findMany({
    where: {
      projectId,
      ...(documentId && { documentId }),
      ...(segmentId && { segmentId }),
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  return messages.map((msg) => ({
    id: msg.id,
    role: msg.role as 'user' | 'assistant',
    content: msg.content,
    createdAt: msg.createdAt,
    metadata: msg.metadata as Record<string, unknown> | undefined,
  }));
};

export const saveExtractedRules = async (
  projectId: string,
  rules: string[],
): Promise<void> => {
  // Get existing guidelines
  const existing = await prisma.projectGuideline.findUnique({
    where: { projectId },
  });

  // Normalize existing rules - handle both string[] and object[] formats
  const normalizeGuidelines = (rules: any): string[] => {
    if (!rules) return [];
    if (Array.isArray(rules)) {
      return rules
        .map((r) => (typeof r === 'string' ? r : r.title || r.instruction || r.description || ''))
        .filter((r): r is string => typeof r === 'string' && r.length > 0);
    }
    return [];
  };

  const existingRules = normalizeGuidelines(existing?.rules);

  // Merge with new rules (avoid duplicates, case-insensitive)
  const allRules = [...existingRules];
  const existingLower = existingRules.map((r) => r.toLowerCase());
  
  for (const rule of rules) {
    const ruleTrimmed = rule.trim();
    if (ruleTrimmed && !existingLower.includes(ruleTrimmed.toLowerCase())) {
      allRules.push(ruleTrimmed);
      existingLower.push(ruleTrimmed.toLowerCase());
    }
  }

  // Save updated guidelines (as strings)
  await upsertProjectGuidelines(projectId, allRules);
};

