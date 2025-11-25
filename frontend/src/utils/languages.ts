/**
 * Centralized language and locale definitions for the application
 * This ensures consistent language designations across the entire app
 */

export interface Language {
  code: string; // ISO 639-1 or ISO 639-2 code (e.g., 'en', 'kk', 'zh')
  name: string; // Full language name (e.g., 'English', 'Kazakh', 'Chinese')
  nativeName?: string; // Native name of the language
}

/**
 * Comprehensive list of supported languages with fixed designations
 * Includes Kazakh and other commonly used languages
 */
export const SUPPORTED_LANGUAGES: Language[] = [
  // Major European languages
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska' },
  { code: 'da', name: 'Danish', nativeName: 'Dansk' },
  { code: 'fi', name: 'Finnish', nativeName: 'Suomi' },
  { code: 'no', name: 'Norwegian', nativeName: 'Norsk' },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština' },
  { code: 'hu', name: 'Hungarian', nativeName: 'Magyar' },
  { code: 'ro', name: 'Romanian', nativeName: 'Română' },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська' },
  { code: 'el', name: 'Greek', nativeName: 'Ελληνικά' },
  { code: 'he', name: 'Hebrew', nativeName: 'עברית' },
  { code: 'bg', name: 'Bulgarian', nativeName: 'Български' },
  { code: 'hr', name: 'Croatian', nativeName: 'Hrvatski' },
  { code: 'sr', name: 'Serbian', nativeName: 'Српски' },
  { code: 'sk', name: 'Slovak', nativeName: 'Slovenčina' },
  { code: 'sl', name: 'Slovenian', nativeName: 'Slovenščina' },
  
  // Central Asian languages
  { code: 'kk', name: 'Kazakh', nativeName: 'Қазақша' },
  { code: 'uz', name: 'Uzbek', nativeName: 'Oʻzbek' },
  { code: 'ky', name: 'Kyrgyz', nativeName: 'Кыргызча' },
  { code: 'tk', name: 'Turkmen', nativeName: 'Türkmen' },
  { code: 'tg', name: 'Tajik', nativeName: 'Тоҷикӣ' },
  { code: 'mn', name: 'Mongolian', nativeName: 'Монгол' },
  
  // Asian languages
  { code: 'zh', name: 'Chinese', nativeName: '中文' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'ko', name: 'Korean', nativeName: '한국어' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
  { code: 'th', name: 'Thai', nativeName: 'ไทย' },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
  { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu' },
  { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்' },
  { code: 'te', name: 'Telugu', nativeName: 'తెలుగు' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা' },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو' },
  { code: 'fa', name: 'Persian', nativeName: 'فارسی' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية' },
  
  // Other languages
  { code: 'sw', name: 'Swahili', nativeName: 'Kiswahili' },
  { code: 'af', name: 'Afrikaans', nativeName: 'Afrikaans' },
  { code: 'az', name: 'Azerbaijani', nativeName: 'Azərbaycan' },
  { code: 'be', name: 'Belarusian', nativeName: 'Беларуская' },
  { code: 'et', name: 'Estonian', nativeName: 'Eesti' },
  { code: 'lv', name: 'Latvian', nativeName: 'Latviešu' },
  { code: 'lt', name: 'Lithuanian', nativeName: 'Lietuvių' },
  { code: 'mk', name: 'Macedonian', nativeName: 'Македонски' },
  { code: 'sq', name: 'Albanian', nativeName: 'Shqip' },
  { code: 'is', name: 'Icelandic', nativeName: 'Íslenska' },
  { code: 'ga', name: 'Irish', nativeName: 'Gaeilge' },
  { code: 'mt', name: 'Maltese', nativeName: 'Malti' },
];

/**
 * Locale variants (e.g., en-US, es-ES, pt-BR)
 */
export const LOCALE_VARIANTS: Record<string, Language> = {
  'en-US': { code: 'en-US', name: 'English (US)', nativeName: 'English (US)' },
  'en-GB': { code: 'en-GB', name: 'English (UK)', nativeName: 'English (UK)' },
  'en-CA': { code: 'en-CA', name: 'English (Canada)', nativeName: 'English (Canada)' },
  'en-AU': { code: 'en-AU', name: 'English (Australia)', nativeName: 'English (Australia)' },
  'es-ES': { code: 'es-ES', name: 'Spanish (Spain)', nativeName: 'Español (España)' },
  'es-MX': { code: 'es-MX', name: 'Spanish (Mexico)', nativeName: 'Español (México)' },
  'es-AR': { code: 'es-AR', name: 'Spanish (Argentina)', nativeName: 'Español (Argentina)' },
  'pt-BR': { code: 'pt-BR', name: 'Portuguese (Brazil)', nativeName: 'Português (Brasil)' },
  'pt-PT': { code: 'pt-PT', name: 'Portuguese (Portugal)', nativeName: 'Português (Portugal)' },
  'zh-CN': { code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '中文 (简体)' },
  'zh-TW': { code: 'zh-TW', name: 'Chinese (Traditional)', nativeName: '中文 (繁體)' },
  'fr-CA': { code: 'fr-CA', name: 'French (Canada)', nativeName: 'Français (Canada)' },
  'fr-FR': { code: 'fr-FR', name: 'French (France)', nativeName: 'Français (France)' },
  'de-DE': { code: 'de-DE', name: 'German (Germany)', nativeName: 'Deutsch (Deutschland)' },
  'de-AT': { code: 'de-AT', name: 'German (Austria)', nativeName: 'Deutsch (Österreich)' },
  'de-CH': { code: 'de-CH', name: 'German (Switzerland)', nativeName: 'Deutsch (Schweiz)' },
  'ru-RU': { code: 'ru-RU', name: 'Russian (Russia)', nativeName: 'Русский (Россия)' },
  'kk-KZ': { code: 'kk-KZ', name: 'Kazakh (Kazakhstan)', nativeName: 'Қазақша (Қазақстан)' },
};

/**
 * Get language by code (supports both base codes and locale variants)
 */
export function getLanguageByCode(code: string | null | undefined): Language | null {
  if (!code) return null;
  
  // Check locale variants first
  if (LOCALE_VARIANTS[code]) {
    return LOCALE_VARIANTS[code];
  }
  
  // Check base language codes
  const language = SUPPORTED_LANGUAGES.find(
    (lang) => lang.code.toLowerCase() === code.toLowerCase()
  );
  
  if (language) return language;
  
  // Try to extract base code from locale (e.g., "en-US" -> "en")
  const baseCode = code.split('-')[0].toLowerCase();
  return SUPPORTED_LANGUAGES.find(
    (lang) => lang.code.toLowerCase() === baseCode
  ) || null;
}

/**
 * Get language name by code (returns code if not found)
 */
export function getLanguageName(code: string | null | undefined): string {
  const language = getLanguageByCode(code);
  return language ? language.name : code || 'Unknown';
}

/**
 * Get all available language codes
 */
export function getAllLanguageCodes(): string[] {
  return SUPPORTED_LANGUAGES.map((lang) => lang.code);
}

/**
 * Check if a language code is supported
 */
export function isLanguageSupported(code: string): boolean {
  return getLanguageByCode(code) !== null;
}

/**
 * Sort languages alphabetically by name
 */
export function getSortedLanguages(): Language[] {
  return [...SUPPORTED_LANGUAGES].sort((a, b) => a.name.localeCompare(b.name));
}



