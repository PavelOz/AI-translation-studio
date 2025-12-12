/**
 * Simple stemmer for English and Russian
 * Handles common word variations (plurals, case endings) without external dependencies
 */
export function simpleStem(word: string, locale: string): string {
  const lower = word.toLowerCase().trim();
  if (!lower) return '';
  
  const localeLower = locale.toLowerCase();
  
  // English stemming (basic rules)
  if (localeLower.startsWith('en')) {
    // Remove common English plural/possessive endings
    if (lower.endsWith('ies') && lower.length > 4) {
      return lower.slice(0, -3) + 'y'; // companies -> company
    }
    if (lower.endsWith('es') && lower.length > 3) {
      // Check for words ending in s, x, z, ch, sh
      const beforeEs = lower.slice(0, -2);
      if (beforeEs.endsWith('s') || beforeEs.endsWith('x') || beforeEs.endsWith('z') || 
          beforeEs.endsWith('ch') || beforeEs.endsWith('sh')) {
        return beforeEs; // boxes -> box, churches -> church
      }
      // Check for words ending in consonant + y -> ies
      if (beforeEs.length > 1 && !/[aeiou]/.test(beforeEs[beforeEs.length - 1])) {
        return beforeEs; // tries -> try (already handled above)
      }
    }
    if (lower.endsWith('s') && lower.length > 2 && !lower.endsWith('ss')) {
      return lower.slice(0, -1); // cars -> car, but not "class" -> "clas"
    }
    // Remove common verb endings
    if (lower.endsWith('ing') && lower.length > 4) {
      return lower.slice(0, -3); // running -> run
    }
    if (lower.endsWith('ed') && lower.length > 3) {
      return lower.slice(0, -2); // walked -> walk
    }
  }
  
  // Russian stemming (basic rules for common case endings)
  if (localeLower.startsWith('ru')) {
    // Remove common Russian case endings (simplified)
    // Nominative -> Genitive, Dative, Accusative, Instrumental, Prepositional
    const endings = [
      // Genitive (родительный)
      { pattern: /ов$/, minLength: 4 }, // компаний -> компания
      { pattern: /ев$/, minLength: 4 },
      { pattern: /ей$/, minLength: 3 }, // компаний -> компания (alternative)
      // Accusative (винительный) - often same as nominative for inanimate
      // Dative (дательный)
      { pattern: /ам$/, minLength: 4 }, // компаниям -> компания
      { pattern: /ям$/, minLength: 4 },
      // Instrumental (творительный)
      { pattern: /ами$/, minLength: 5 }, // компаниями -> компания
      { pattern: /ями$/, minLength: 5 },
      // Prepositional (предложный)
      { pattern: /ах$/, minLength: 4 }, // компаниях -> компания
      { pattern: /ях$/, minLength: 4 },
      // Plural nominative
      { pattern: /ы$/, minLength: 3 }, // компании -> компания
      { pattern: /и$/, minLength: 3 }, // компании -> компания
    ];
    
    for (const { pattern, minLength } of endings) {
      if (lower.length >= minLength && pattern.test(lower)) {
        const stemmed = lower.replace(pattern, '');
        // Basic validation: stemmed word should be at least 2 characters
        if (stemmed.length >= 2) {
          return stemmed;
        }
      }
    }
  }
  
  // Return original if no stemming rules applied
  return lower;
}

/**
 * Check if a glossary term matches source text considering word variations
 */
export function matchesWithVariations(
  term: string, 
  sourceText: string, 
  sourceLocale: string
): boolean {
  const sourceLower = sourceText.toLowerCase();
  const termLower = term.toLowerCase();
  
  // Exact match (case-insensitive)
  if (sourceLower.includes(termLower)) {
    return true;
  }
  
  // Try stemming for both term and words in source text
  const termStem = simpleStem(term, sourceLocale);
  
  // Split source text into words and check each
  const sourceWords = sourceLower.split(/\s+/);
  for (const word of sourceWords) {
    const wordStem = simpleStem(word, sourceLocale);
    
    // Check if stems match
    if (wordStem === termStem && termStem.length >= 2) {
      return true;
    }
    
    // Also check if term stem is contained in word stem or vice versa
    if (wordStem.includes(termStem) || termStem.includes(wordStem)) {
      if (Math.min(termStem.length, wordStem.length) >= 3) {
        return true;
      }
    }
  }
  
  return false;
}




