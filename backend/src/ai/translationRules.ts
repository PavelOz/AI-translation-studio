/**
 * Translation Rules – address/system instructions from profiles (DB).
 * No hardcoded terminology or rules; all content lives in Profile.instructions (e.g. Technical Default).
 */

import { prisma } from '../db/prisma';

/** Profile name used for base technical/address system instructions. */
const BASE_PROFILE_NAME = 'Technical Default';

/** Normalize locale to base language code (e.g. ru-RU → ru). */
function normalizeLocale(locale: string): string {
  return locale.toLowerCase().replace(/[_-]/g, '-').split('-')[0];
}

/**
 * Rule shape returned when address/system instructions exist for a language pair.
 * Content is taken from Profile.instructions (no terminology/transformations in code).
 */
export interface AddressFormattingRuleSource {
  instructions: string;
}

/**
 * Resolves address formatting rule for a language pair from the base profile.
 * Only (ru → en) is supported via Technical Default profile; other pairs return undefined.
 */
export async function getAddressFormattingRuleAsync(
  sourceLocale: string,
  targetLocale: string,
): Promise<AddressFormattingRuleSource | undefined> {
  const src = normalizeLocale(sourceLocale);
  const tgt = normalizeLocale(targetLocale);
  if (src !== 'ru' || tgt !== 'en') {
    return undefined;
  }
  const profile = await prisma.profile.findFirst({
    where: { name: BASE_PROFILE_NAME },
    select: { instructions: true },
  });
  if (!profile?.instructions?.trim()) {
    return undefined;
  }
  return { instructions: profile.instructions };
}

/**
 * Returns whether address formatting rules exist for the given language pair (from DB).
 */
export async function hasAddressFormattingRuleAsync(
  sourceLocale: string,
  targetLocale: string,
): Promise<boolean> {
  const rule = await getAddressFormattingRuleAsync(sourceLocale, targetLocale);
  return !!rule;
}
