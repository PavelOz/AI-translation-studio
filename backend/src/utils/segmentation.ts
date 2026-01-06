import * as sbd from 'sbd';

/**
 * Strip formatting tags like {{0}}, {{/0}}, {{1}}, {{/1}}, etc.
 * These tags are used by DocxHandler to preserve formatting but should be removed
 * when saving/searching Translation Memory to ensure proper matching.
 * 
 * @param text - The text with formatting tags
 * @returns The text with all formatting tags removed
 */
export function stripFormattingTags(text: string): string {
  if (!text || typeof text !== 'string') {
    return text;
  }
  // Remove all formatting tags: {{0}}, {{/0}}, {{1}}, {{/1}}, etc.
  // Pattern matches: {{ followed by optional /, then digits, then }}
  return text.replace(/\{\{\/?\d+\}\}/g, '').trim();
}

/**
 * Split text into sentences using the sbd library
 * 
 * @param text - The text to split into sentences
 * @param locale - Optional locale string (e.g., 'ru-RU', 'en-US', 'en-GB')
 * @returns Array of sentences (trimmed, non-empty)
 */
export function splitIntoSentences(text: string, locale?: string): string[] {
  // Handle empty/null inputs gracefully
  if (!text || typeof text !== 'string') {
    return [];
  }

  // Trim the input
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    return [];
  }

  // Map locale to sbd language code
  // sbd supports: 'en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'ja', 'zh', 'ar', 'hi'
  // Extract base language from locale (e.g., 'ru-RU' -> 'ru', 'en-US' -> 'en')
  let language: string | undefined;
  if (locale) {
    const baseLang = locale.split('-')[0].toLowerCase();
    // Map common locale codes to sbd language codes
    const langMap: Record<string, string> = {
      'en': 'en',
      'es': 'es',
      'fr': 'fr',
      'de': 'de',
      'it': 'it',
      'pt': 'pt',
      'ru': 'ru',
      'ja': 'ja',
      'zh': 'zh',
      'ar': 'ar',
      'hi': 'hi',
    };
    language = langMap[baseLang];
  }

  // Configure sbd options
  const options: sbd.Options = {
    // Don't split on abbreviations (handled by sbd internally)
    // Preserve whitespace handling
    sanitize: false, // Keep original text formatting
  };

  try {
    // Use sbd to split sentences
    const sentences = sbd.sentences(trimmedText, options);
    
    // Filter out empty sentences and trim
    return sentences
      .map(s => s.trim())
      .filter(s => s.length > 0);
  } catch (error) {
    // If sbd fails, fallback to simple splitting on sentence-ending punctuation
    // This is a safety net for edge cases
    console.warn('sbd sentence splitting failed, using fallback:', error);
    return fallbackSentenceSplit(trimmedText);
  }
}

/**
 * Fallback sentence splitting using regex
 * Used when sbd library fails or for unsupported languages
 */
function fallbackSentenceSplit(text: string): string[] {
  // Split on sentence-ending punctuation followed by space or end of string
  // Pattern: . ! ? followed by space, newline, or end of string
  const sentenceEndings = /[.!?]+(?:\s+|$)/g;
  const sentences: string[] = [];
  let lastIndex = 0;
  let match;

  while ((match = sentenceEndings.exec(text)) !== null) {
    const sentence = text.substring(lastIndex, match.index + match[0].length).trim();
    if (sentence.length > 0) {
      sentences.push(sentence);
    }
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text if any
  if (lastIndex < text.length) {
    const remaining = text.substring(lastIndex).trim();
    if (remaining.length > 0) {
      sentences.push(remaining);
    }
  }

  // If no sentences found, return the whole text as a single sentence
  return sentences.length > 0 ? sentences : [text.trim()];
}




