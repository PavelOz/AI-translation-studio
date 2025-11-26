/**
 * Translation Rules Configuration
 * 
 * This file contains language-pair-specific translation rules such as:
 * - Address formatting standardization
 * - Number/date formatting
 * - Terminology conventions
 * - Style guidelines
 */

export interface AddressTransformation {
  pattern: string; // Regex pattern or description
  replacement: string; // Replacement pattern or description
  example?: {
    source: string;
    target: string;
  };
}

export interface AddressFormattingRule {
  sourceLocale: string;
  targetLocale: string;
  ruleType: 'address_standardization';
  description: string;
  format: string; // Format template description
  transformations: AddressTransformation[];
  terminology: Record<string, string>; // Term mappings (e.g., "мкр." => "Microdistrict")
  detectionKeywords?: string[]; // Keywords that indicate an address is present
  instructions: string; // Detailed instructions for AI
}

/**
 * Address formatting rules for different language pairs
 */
export const ADDRESS_FORMATTING_RULES: AddressFormattingRule[] = [
  {
    sourceLocale: 'ru',
    targetLocale: 'en',
    ruleType: 'address_standardization',
    description: 'RU→EN Address Standardization',
    format: '[House/Building Number] [Street Name], [Apt/Office], [City], [Zip Code], [Country]',
    transformations: [
      {
        pattern: 'ул\\.\\s*([^,]+),\\s*(?:д\\.|зд\\.)\\s*(\\d+)',
        replacement: '$2 $1 St.',
        example: {
          source: 'ул. Сарайшык, д. 59',
          target: '59 Sarayshyk St.',
        },
      },
      {
        pattern: 'пр\\.\\s*([^,]+),\\s*(?:д\\.|зд\\.)\\s*(\\d+)',
        replacement: '$2 $1 Ave.',
        example: {
          source: 'пр. Тауелсыздык, д. 59',
          target: '59 Tauelsizdik Ave.',
        },
      },
      {
        pattern: 'бул\\.\\s*([^,]+),\\s*(?:д\\.|зд\\.)\\s*(\\d+)',
        replacement: '$2 $1 Blvd.',
        example: {
          source: 'бул. Абая, д. 150',
          target: '150 Abay Blvd.',
        },
      },
      {
        pattern: '(?:ул\\.|пр\\.|бул\\.)\\s*([^,]+),\\s*зд\\.\\s*(\\d+)',
        replacement: '$2 $1',
        example: {
          source: 'пр. Тәуелсіздік, зд. 59',
          target: '59 Tauelsizdik Ave.',
        },
      },
    ],
    terminology: {
      'мкр.': 'Microdistrict',
      'р-н': 'District', // Abbreviation variant of район
      'район': 'District',
      'область': 'Region',
      'г.': '', // City prefix - remove in English
      'д.': '', // Building number prefix - handled by transformation
      'зд.': '', // Building abbreviation (здание) - handled by transformation
      'офис': 'Office',
      'кв.': 'Apt.',
      'квартира': 'Apt.',
    },
    detectionKeywords: [
      'по адресу',
      'адрес',
      'расположен',
      'находится',
      'находится по адресу',
      'контактная информация',
      'адрес офиса',
      'местонахождение',
      'адрес компании',
      'юридический адрес',
      'БИН', // Often precedes address in company info
      'ИНН', // Tax ID often precedes address
    ],
    instructions: `CRITICAL: Address Detection and Standardization (RU → EN)

STEP 1: IDENTIFY ADDRESSES IN THE TEXT
An address typically contains these indicators:
- Location keywords: "по адресу", "адрес", "расположен", "находится", "находится по адресу"
- Geographic elements: country names (Казахстан, Россия), city names (г. Астана, Москва)
- Street indicators: "ул.", "пр.", "бул.", "улица", "проспект", "бульвар"
- Building numbers: "д.", "зд.", "дом", "здание" (NOTE: "зд." = здание = building)
- Office/apartment: "офис", "кв.", "квартира"
- Administrative divisions: "район", "р-н", "область", "мкр."

COMMON ADDRESS PATTERNS TO LOOK FOR:
- "по адресу: [Country], [City], [District], [Street], [Building]"
- "расположен(ный/ая) по адресу: [address]"
- "находится по адресу: [address]"
- "адрес: [address]"
- "[Country], [City], [District], [Street], [Building]" (even without explicit keywords)
- Addresses in parentheses: "(БИН ..., [Country], [City], [District], [Street], [Building], ...)"
- Addresses after company names: "ООО "..." ([Country], [City], [Street], [Building])"

STEP 2: DETECT ADDRESSES IN RUNNING TEXT AND PARENTHESES
Even if an address is embedded in a sentence or inside parentheses with other contact info, you MUST identify and reformat it.

EXAMPLES OF ADDRESSES IN RUNNING TEXT:
1. "Компания расположена по адресу: Казахстан, г. Астана, район Алматы, пр. Тауелсыздык, д. 59, офис 20"
   → Contains full address after "по адресу:"

2. "Офис находится в Казахстане, в городе Астана, в районе Алматы, на проспекте Тауелсыздык, дом 59"
   → Address elements scattered but identifiable

3. "Адрес: Казахстан, Астана, район Алматы, пр. Тауелсыздык, 59"
   → Address after "Адрес:"

4. "Контактная информация: Казахстан, г. Астана, ул. Сарайшык, д. 59"
   → Address in contact information

5. "Для получения документов обращайтесь в Казахстан, г. Астана, ул. Сарайшык, д. 59."
   → Address without explicit keyword but contains geographic sequence

6. NEW: "ООО "Компания" (БИН 123456789, Казахстан, г. Астана, р-н Сарайшық, пр. Тәуелсіздік, зд. 59, тел. ...)"
   → Address inside parentheses with other contact info - extract only the address part

7. NEW: "АО "KEGOC" (Казахстан, г. Астана, р-н Сарайшық, пр. Тәуелсіздік, зд. 59)"
   → Address in parentheses - must be detected and formatted

STEP 3: REFORMAT TO WESTERN STANDARD
Once identified, reformat according to these rules:

FORMATTING RULES:
1. Format: [House/Building Number] [Street Name], [Apt/Office], [City], [Zip Code], [Country]
2. Street Numbers: Move the house/building number to the very beginning of the address line
   - Example: Change "ул. Сарайшык, д. 59" to "59 Sarayshyk St."
   - Example: Change "пр. Тауелсыздык, д. 59" to "59 Tauelsizdik Ave."
   - Example: Change "пр. Тәуелсіздік, зд. 59" to "59 Tauelsizdik Ave." (NOTE: "зд." = building)
3. Reverse the order: from "Country, City, District, Street, Building" to "Building, Street, District, City, Country"
4. Apply formatting even if the address is embedded in the middle of a sentence or inside parentheses
5. When address is in parentheses with other info, extract ONLY the address part (ignore phone, email, website, БИН, etc.)

TERMINOLOGY TRANSLATIONS:
- "мкр." → "Microdistrict"
- "р-н" → "District" (abbreviation of район)
- "район" → "District"
- "область" → "Region" (or "Oblast" if legally specific)
- "офис" → "Office"
- "кв." or "квартира" → "Apt."
- "г." → remove (city prefix not needed in English)
- "д." or "зд." → remove (building number prefix - handled by word order)

DETAILED EXAMPLES:

Example 1 (Standalone address):
Source: "Адрес: Казахстан, г. Астана, район Алматы, пр. Тауелсыздык, д. 59, офис 20"
Target: "Address: Office 20, 59 Tauelsizdik Ave., Almaty District, Astana, Kazakhstan"

Example 2 (Address in running text):
Source: "Компания расположена по адресу: Казахстан, г. Астана, район Алматы, пр. Тауелсыздык, д. 59, офис 20, и работает с 9 до 18 часов."
Target: "The company is located at Office 20, 59 Tauelsizdik Ave., Almaty District, Astana, Kazakhstan, and operates from 9 AM to 6 PM."

Example 3 (Address without explicit keyword):
Source: "Для получения документов обращайтесь в Казахстан, г. Астана, ул. Сарайшык, д. 59."
Target: "To obtain documents, contact us at 59 Sarayshyk St., Astana, Kazakhstan."

Example 4 (Scattered address elements):
Source: "Офис находится в Казахстане, в городе Астана, в районе Алматы, на проспекте Тауелсыздык, дом 59."
Target: "The office is located at 59 Tauelsizdik Ave., Almaty District, Astana, Kazakhstan."

Example 5 (Contact information):
Source: "Контактная информация: Казахстан, г. Астана, район Алматы, ул. Сарайшык, д. 59, офис 20."
Target: "Contact information: Office 20, 59 Sarayshyk St., Almaty District, Astana, Kazakhstan."

Example 6 (NEW - Address in parentheses with contact info):
Source: "АО "KEGOC" (БИН 970740000838, Казахстан, г. Астана, р-н Сарайшық, пр. Тәуелсіздік, зд. 59, тел. ...)"
Target: "JSC "KEGOC" (BIN 970740000838, 59 Tauelsizdik Ave., Sarayshyk District, Astana, Kazakhstan, tel. ...)"

Example 7 (NEW - Address with "зд." abbreviation):
Source: "Казахстан, г. Астана, р-н Сарайшық, пр. Тәуелсіздік, зд. 59"
Target: "59 Tauelsizdik Ave., Sarayshyk District, Astana, Kazakhstan"

Example 8 (NEW - Address with "зд." and "р-н" in parentheses):
Source: "Настоящим Акционерное общество "KEGOC" (БИН 970740000838, Казахстан, г. Астана, р-н Сарайшық, пр. Тәуелсіздік, зд. 59, тел. ...) направляет..."
Target: "By this, Joint Stock Company "KEGOC" (BIN 970740000838, 59 Tauelsizdik Ave., Sarayshyk District, Astana, Kazakhstan, tel. ...) hereby submits..."

KEY POINTS:
- ALWAYS scan for address patterns, even in running text or parentheses
- Look for geographic sequences: Country → City → District → Street → Building
- If you see 3+ geographic/address elements together, it's likely an address
- Always place house/building number BEFORE street name
- Apply formatting even within sentences or parentheses (not just standalone addresses)
- Use proper English address abbreviations (St., Ave., Blvd., etc.)
- Remove Russian prefixes like "г." (city), "д." (дом), and "зд." (здание) - they are handled by word order
- "р-н" is an abbreviation of "район" (district) - translate as "District"
- When address is mixed with contact info in parentheses, extract and format ONLY the address part`,
  },
  // Add more language pairs here as needed
  // {
  //   sourceLocale: 'en',
  //   targetLocale: 'ru',
  //   ruleType: 'address_standardization',
  //   description: 'EN→RU Address Standardization',
  //   format: '[Country], [City], [District], [Street], [Building]',
  //   transformations: [...],
  //   terminology: {...},
  //   instructions: '...',
  // },
];

/**
 * Get address formatting rule for a specific language pair
 */
export function getAddressFormattingRule(
  sourceLocale: string,
  targetLocale: string
): AddressFormattingRule | undefined {
  // Normalize locale codes (handle variations like 'ru', 'ru-RU', 'ru_ru')
  const normalizeLocale = (locale: string): string => {
    const normalized = locale.toLowerCase().replace(/[_-]/g, '-');
    // Extract base language code (e.g., 'ru-RU' -> 'ru')
    return normalized.split('-')[0];
  };

  const normalizedSource = normalizeLocale(sourceLocale);
  const normalizedTarget = normalizeLocale(targetLocale);

  return ADDRESS_FORMATTING_RULES.find(
    (rule) =>
      normalizeLocale(rule.sourceLocale) === normalizedSource &&
      normalizeLocale(rule.targetLocale) === normalizedTarget
  );
}

/**
 * Check if address formatting rules exist for a language pair
 */
export function hasAddressFormattingRule(
  sourceLocale: string,
  targetLocale: string
): boolean {
  return getAddressFormattingRule(sourceLocale, targetLocale) !== undefined;
}

