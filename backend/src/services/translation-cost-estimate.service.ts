import { prisma } from '../db/prisma';
import { ApiError } from '../utils/apiError';
import { searchTranslationMemory } from './tm.service';
import { applyTmMatchWithNumberSubstitution } from './segment.service';
import { computeCostUsd, getBillingTodayForUser } from './billing-manager.service';
import { getBillingConfig } from './billing-config.service';
import { buildAiContext, buildTranslationUnits, type QueuedEntry } from './ai.service';

const ESTIMATE_PROMPT_OVERHEAD_TOKENS = 2600;
const CRITIC_ROUNDS = 3;

export type TranslationCostEstimateResult = {
  billingEnabled: boolean;
  workflow: 'pretranslate' | 'batch';
  eligibleSegmentCount: number;
  segmentsQueuedForAi: number;
  tmResolvedWithoutAi: number;
  translationUnitCount: number;
  aiApiCallCount: number;
  provider: string;
  model: string;
  useCritic: boolean;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  dailyCapUsd: number;
  spentTodayUsd: number;
  remainingTodayUsd: number;
  remainingAfterEstimateUsd: number;
  mayExceedCap: boolean;
  disclaimer: string;
};

type EligibleSeg = QueuedEntry['segment'];

function estimateTokensFromCharLength(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

async function buildPretranslateAiQueueDryRun(
  doc: { sourceLocale: string; targetLocale: string; projectId: string },
  eligibleSegments: EligibleSeg[],
  options?: {
    applyAiToLowMatches?: boolean;
    applyAiToEmptyOnly?: boolean;
    skipTm?: boolean;
  },
): Promise<{ queuedForAI: QueuedEntry[]; tmResolvedWithoutAi: number }> {
  const queuedForAI: QueuedEntry[] = [];
  let tmResolvedWithoutAi = 0;

  if (!options?.skipTm) {
    for (let i = 0; i < eligibleSegments.length; i += 1) {
      const segment = eligibleSegments[i];
      const tmMatches = await searchTranslationMemory({
        sourceText: segment.sourceText,
        sourceLocale: doc.sourceLocale,
        targetLocale: doc.targetLocale,
        projectId: doc.projectId,
        limit: 1,
        minScore: 100,
      });

      const perfectMatch = tmMatches[0];
      if (perfectMatch && perfectMatch.fuzzyScore === 100) {
        tmResolvedWithoutAi += 1;
        continue;
      }

      let usedHighFuzzySubstitution = false;
      const highFuzzyMatches = await searchTranslationMemory({
        sourceText: segment.sourceText,
        sourceLocale: doc.sourceLocale,
        targetLocale: doc.targetLocale,
        projectId: doc.projectId,
        limit: 1,
        minScore: 90,
      });
      const highMatch = highFuzzyMatches[0];
      if (highMatch && highMatch.fuzzyScore >= 90) {
        const substituted = applyTmMatchWithNumberSubstitution(
          highMatch.targetText,
          highMatch.sourceText,
          segment.sourceText,
          doc.targetLocale,
        );
        if (substituted.applied) {
          usedHighFuzzySubstitution = true;
          tmResolvedWithoutAi += 1;
        }
      }
      if (!usedHighFuzzySubstitution) {
        const hasLowMatch = tmMatches.length > 0 && tmMatches[0].fuzzyScore < 100;
        const hasNoMatch = tmMatches.length === 0;
        const shouldApplyAI =
          (options?.applyAiToLowMatches && (hasLowMatch || hasNoMatch)) ||
          ((options?.applyAiToEmptyOnly ?? true) && (hasNoMatch || hasLowMatch));
        if (shouldApplyAI) {
          queuedForAI.push({
            segment,
            previous: i > 0 ? eligibleSegments[i - 1] : undefined,
            next: i < eligibleSegments.length - 1 ? eligibleSegments[i + 1] : undefined,
          });
        }
      }
    }
  } else {
    for (let i = 0; i < eligibleSegments.length; i += 1) {
      const segment = eligibleSegments[i];
      queuedForAI.push({
        segment,
        previous: i > 0 ? eligibleSegments[i - 1] : undefined,
        next: i < eligibleSegments.length - 1 ? eligibleSegments[i + 1] : undefined,
      });
    }
  }

  return { queuedForAI, tmResolvedWithoutAi };
}

function estimateAiTokenCallsForQueue(queuedForAI: QueuedEntry[], useCritic: boolean): Array<{ inputTokens: number; outputTokens: number }> {
  const calls: Array<{ inputTokens: number; outputTokens: number }> = [];
  if (queuedForAI.length === 0) return calls;

  if (useCritic) {
    for (const entry of queuedForAI) {
      const st = entry.segment.sourceText ?? '';
      const baseIn = estimateTokensFromCharLength(st.length + 8000);
      const baseOut = estimateTokensFromCharLength(Math.ceil(st.length * 1.1));
      for (let r = 0; r < CRITIC_ROUNDS; r += 1) {
        calls.push({ inputTokens: baseIn, outputTokens: baseOut });
      }
    }
    return calls;
  }

  const units = buildTranslationUnits(queuedForAI);
  const overheadChars = ESTIMATE_PROMPT_OVERHEAD_TOKENS * 4;
  for (const unit of units) {
    const joined = unit.map((e) => e.segment.sourceText ?? '').join('\n');
    const inTok = estimateTokensFromCharLength(joined.length + overheadChars);
    const outTok = estimateTokensFromCharLength(Math.ceil(joined.length * 1.15));
    calls.push({ inputTokens: inTok, outputTokens: outTok });
  }
  return calls;
}

function sumUsdForTokenCalls(
  provider: string,
  model: string,
  calls: Array<{ inputTokens: number; outputTokens: number }>,
): { inputTokens: number; outputTokens: number; costUsd: number } {
  let inSum = 0;
  let outSum = 0;
  let costUsd = 0;
  for (const c of calls) {
    inSum += c.inputTokens;
    outSum += c.outputTokens;
    costUsd += computeCostUsd(provider, model, { inputTokens: c.inputTokens, outputTokens: c.outputTokens });
  }
  return { inputTokens: inSum, outputTokens: outSum, costUsd };
}

function assembleEstimate(args: {
  workflow: 'pretranslate' | 'batch';
  userId: string;
  eligibleSegmentCount: number;
  queuedForAI: QueuedEntry[];
  tmResolvedWithoutAi: number;
  provider: string;
  model: string;
  useCritic: boolean;
}): TranslationCostEstimateResult {
  const cfg = getBillingConfig();
  const today = getBillingTodayForUser(args.userId);
  const billingEnabled = cfg.enabled;

  const calls = estimateAiTokenCallsForQueue(args.queuedForAI, args.useCritic);
  const unitCount = args.useCritic ? args.queuedForAI.length : buildTranslationUnits(args.queuedForAI).length;

  const provider = args.provider || 'gemini';
  const model = args.model || 'gemini-pro';
  const { inputTokens, outputTokens, costUsd } = sumUsdForTokenCalls(provider, model, calls);

  const remainingAfter = today.remainingUsd - costUsd;
  const disclaimer =
    'Estimate only: real usage varies with prompts, retries, and provider meters. TM phase mirrors pretranslate/batch; overhead per API call is approximate.';

  return {
    billingEnabled,
    workflow: args.workflow,
    eligibleSegmentCount: args.eligibleSegmentCount,
    segmentsQueuedForAi: args.queuedForAI.length,
    tmResolvedWithoutAi: args.tmResolvedWithoutAi,
    translationUnitCount: unitCount,
    aiApiCallCount: calls.length,
    provider,
    model,
    useCritic: args.useCritic,
    estimatedInputTokens: inputTokens,
    estimatedOutputTokens: outputTokens,
    estimatedCostUsd: Math.round(costUsd * 1e6) / 1e6,
    dailyCapUsd: today.capUsd,
    spentTodayUsd: today.spentUsd,
    remainingTodayUsd: today.remainingUsd,
    remainingAfterEstimateUsd: Math.round(Math.max(-1e9, remainingAfter) * 1e6) / 1e6,
    mayExceedCap: billingEnabled && today.spentUsd + costUsd > today.capUsd + 1e-9,
    disclaimer,
  };
}

export async function estimatePretranslateTranslationCost(
  documentId: string,
  userId: string,
  options?: {
    applyAiToLowMatches?: boolean;
    applyAiToEmptyOnly?: boolean;
    rewriteConfirmed?: boolean;
    rewriteNonConfirmed?: boolean;
    useCritic?: boolean;
    provider?: string;
    model?: string;
    skipTm?: boolean;
  },
): Promise<TranslationCostEstimateResult> {
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

  const eligibleSegments = document.segments.filter((segment) => {
    const isEmpty = !segment.targetFinal && !segment.targetMt;
    const isConfirmed = segment.status === 'CONFIRMED';
    const isNonConfirmedButNotEmpty = !isEmpty && !isConfirmed;
    if (isEmpty) return true;
    if (isConfirmed && options?.rewriteConfirmed) return true;
    if (isNonConfirmedButNotEmpty && options?.rewriteNonConfirmed) return true;
    return false;
  });

  const context = await buildAiContext(document.projectId, document.sourceLocale, document.targetLocale);
  const effectiveProvider = options?.provider || context.settings?.provider || 'gemini';
  const effectiveModel = options?.model || context.settings?.model || 'gemini-pro';

  const { queuedForAI, tmResolvedWithoutAi } = await buildPretranslateAiQueueDryRun(
    document,
    eligibleSegments,
    {
      applyAiToLowMatches: options?.applyAiToLowMatches,
      applyAiToEmptyOnly: options?.applyAiToEmptyOnly,
      skipTm: options?.skipTm,
    },
  );

  return assembleEstimate({
    workflow: 'pretranslate',
    userId,
    eligibleSegmentCount: eligibleSegments.length,
    queuedForAI,
    tmResolvedWithoutAi,
    provider: effectiveProvider,
    model: effectiveModel,
    useCritic: options?.useCritic ?? false,
  });
}

export async function estimateBatchTranslationCost(
  documentId: string,
  userId: string,
  mode: 'translate_all' | 'pre_translate',
  options?: {
    applyTm?: boolean;
    minScore?: number;
    mtOnlyEmpty?: boolean;
    mtOnlyNonEmpty?: boolean;
    rewriteNonConfirmed?: boolean;
    useCritic?: boolean;
    glossaryMode?: string;
  },
): Promise<TranslationCostEstimateResult> {
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

  const isSegmentEmpty = (segment: { targetMt: string | null; targetFinal: string | null; status: string }): boolean => {
    const targetText = segment.targetFinal || segment.targetMt;
    if (!targetText) return true;
    if (targetText.trim() === '') return true;
    return false;
  };

  const eligibleSegments = document.segments.filter((segment) => {
    if (mode === 'translate_all') return true;
    if (options?.rewriteNonConfirmed) return segment.status !== 'CONFIRMED';
    if (options?.mtOnlyEmpty) return isSegmentEmpty(segment);
    if (options?.mtOnlyNonEmpty) return !isSegmentEmpty(segment);
    return isSegmentEmpty(segment);
  });

  const context = await buildAiContext(document.projectId, document.sourceLocale, document.targetLocale);
  const effectiveProvider = context.settings?.provider || 'gemini';
  const effectiveModel = context.settings?.model || 'gemini-pro';

  const queuedForAI: QueuedEntry[] = [];
  let tmResolvedWithoutAi = 0;
  const tmAllowed = options?.applyTm ?? true;
  const minScore = options?.minScore ?? 70;

  for (let i = 0; i < eligibleSegments.length; i += 1) {
    const segment = eligibleSegments[i];
    const neighbors = {
      previous: i > 0 ? eligibleSegments[i - 1] : undefined,
      next: i < eligibleSegments.length - 1 ? eligibleSegments[i + 1] : undefined,
    };
    const shouldSkipTmForRetranslate = mode === 'pre_translate' && options?.mtOnlyEmpty;

    if (tmAllowed && !shouldSkipTmForRetranslate) {
      const tmMatches = await searchTranslationMemory({
        sourceText: segment.sourceText,
        sourceLocale: document.sourceLocale,
        targetLocale: document.targetLocale,
        projectId: document.projectId,
        limit: 1,
        minScore,
      });
      if (tmMatches[0]) {
        tmResolvedWithoutAi += 1;
        continue;
      }
    }
    queuedForAI.push({ segment, previous: neighbors.previous, next: neighbors.next });
  }

  return assembleEstimate({
    workflow: 'batch',
    userId,
    eligibleSegmentCount: eligibleSegments.length,
    queuedForAI,
    tmResolvedWithoutAi,
    provider: effectiveProvider,
    model: effectiveModel,
    useCritic: options?.useCritic ?? false,
  });
}
