import type { OrchestratorGlossaryEntry } from '../ai/orchestrator';
import { logger } from '../utils/logger';

type ValidateAndRepairResult = {
  finalText: string;
  wasRepaired: boolean;
  missingTerms: string[]; // before repair
  forbiddenFound: string[]; // before repair
  repairSucceeded: boolean; // true if after repair no violations remain
  flagForReview: boolean; // true if repair failed or was not attempted (when violations existed)
};

function includesCi(haystack: string, needle: string): boolean {
  if (!needle) return true;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function computeMissingAndForbidden(
  translatedText: string,
  glossaryEntries: OrchestratorGlossaryEntry[],
): { missingTerms: string[]; forbiddenFound: string[] } {
  const text = translatedText ?? '';

  const required = glossaryEntries
    .filter((e) => !e.forbidden)
    .map((e) => (e.translation ?? '').trim())
    .filter(Boolean);

  const forbidden = glossaryEntries
    .filter((e) => !!e.forbidden)
    .map((e) => (e.translation ?? '').trim())
    .filter(Boolean);

  const missingTerms = required.filter((t) => !includesCi(text, t));
  const forbiddenFound = forbidden.filter((t) => includesCi(text, t));

  return { missingTerms, forbiddenFound };
}

export async function validateAndRepairGlossaryCompliance(args: {
  translatedText: string;
  sourceText: string;
  glossaryEntries: OrchestratorGlossaryEntry[];
  sourceLocale: string;
  targetLocale: string;
  repairFn: (prompt: string) => Promise<string>;
  segmentId?: string;
}): Promise<ValidateAndRepairResult> {
  const {
    translatedText,
    sourceText,
    glossaryEntries,
    sourceLocale,
    targetLocale,
    repairFn,
    segmentId,
  } = args;

  const initial = computeMissingAndForbidden(translatedText, glossaryEntries);
  const needsRepair = initial.missingTerms.length > 0 || initial.forbiddenFound.length > 0;

  let finalText = translatedText;
  let wasRepaired = false;
  let repairSucceeded = false;

  if (needsRepair) {
    const requiredList = initial.missingTerms.length > 0 ? initial.missingTerms.join(', ') : '(none)';
    const forbiddenList = initial.forbiddenFound.length > 0 ? initial.forbiddenFound.join(', ') : '(none)';

    const prompt = [
      `Rewrite the following translation so that it includes these required terms: ${requiredList} and does not use these forbidden terms: ${forbiddenList}.`,
      'Change nothing else.',
      `Source (${sourceLocale}): ${sourceText}`,
      `Current translation (${targetLocale}): ${translatedText}`,
    ].join('\n');

    try {
      const repaired = await repairFn(prompt);
      if (repaired && repaired.trim()) {
        finalText = repaired;
        wasRepaired = true;
      }
    } catch {
      // Swallow repair exceptions; we still return diagnostics + flagForReview.
    }

    const after = computeMissingAndForbidden(finalText, glossaryEntries);
    repairSucceeded = after.missingTerms.length === 0 && after.forbiddenFound.length === 0;
  }

  const flagForReview = needsRepair && (!wasRepaired || !repairSucceeded);

  logger.debug(
    {
      segmentId,
      sourceLocale,
      targetLocale,
      glossaryCount: glossaryEntries.length,
      missingTermsCount: initial.missingTerms.length,
      forbiddenFoundCount: initial.forbiddenFound.length,
      wasRepaired,
      repairSucceeded,
      flagForReview,
    },
    'Glossary compliance validation/repair',
  );

  return {
    finalText,
    wasRepaired,
    missingTerms: initial.missingTerms,
    forbiddenFound: initial.forbiddenFound,
    repairSucceeded,
    flagForReview,
  };
}

