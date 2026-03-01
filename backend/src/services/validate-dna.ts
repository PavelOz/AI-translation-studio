/**
 * DNA-Contract-Validator: Shift-Left валидация для файлов DNA
 * Проверка логической целостности, полноты и отсутствия конфликтов до начала процесса перевода.
 */

import { normalizeDnaKey } from './dnaKeys';

export type ValidationStatus = 'OK' | 'WARNING' | 'ERROR';

export interface ValidationIssue {
  type: 'error' | 'warning';
  message: string;
  suggestion?: string;
}

export interface DnaValidationResult {
  status: ValidationStatus;
  issues: ValidationIssue[];
  suggestions: string[];
}

type DnaPayload = {
  technicalSchema?: Record<string, unknown> | null;
  namingConventions?: Record<string, unknown> | null;
  abbreviationLogic?: Record<string, unknown> | null;
  entityGroups?: Record<string, unknown> | null;
} | null;

/**
 * Базовые международные сокращения для направления RU→EN
 */
const STANDARD_RU_EN_DEFINITIONS = [
  { key: 'МВт', abbreviation: 'MW', longForm: 'megawatt' },
  { key: 'ОАО', abbreviation: 'JSC', longForm: 'Joint Stock Company' },
  { key: 'ТОО', abbreviation: 'LLP', longForm: 'Limited Liability Partnership' },
  { key: 'СН', abbreviation: 'SN', longForm: 'auxiliary power' },
  { key: 'Pmin', abbreviation: 'Pmin', longForm: 'minimum power' },
  { key: 'Ramp-up/down rate', abbreviation: 'Ramp rate', longForm: 'ramp-up/down rate' },
];

/**
 * Известные коды электростанций (примеры)
 */
const COMMON_POWER_PLANT_CODES = [
  'GTPP', // Gas Turbine Power Plant
  'UKGES', // Усть-Каменогорская ГЭС
  'SHPP', // Small Hydro Power Plant
  'TPP', // Thermal Power Plant
  'NPP', // Nuclear Power Plant
];

/**
 * Извлечение shortForm из значения abbreviationLogic
 */
function getShortForm(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim();
  if (typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (typeof o.shortForm === 'string') return o.shortForm.trim();
  if (typeof o.value === 'string') return o.value.trim();
  return null;
}

/**
 * Извлечение longForm из значения abbreviationLogic
 */
function getLongForm(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim();
  if (typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (typeof o.longForm === 'string') return o.longForm.trim();
  if (typeof o.value === 'string') return o.value.trim();
  return null;
}

/**
 * 1. Проверка на Логические Петли (Identity Protection)
 * Правило: shortForm не должна быть идентична исходному ключу
 */
function checkIdentityProtection(
  abbreviationLogic: Record<string, unknown>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  try {
    for (const [key, value] of Object.entries(abbreviationLogic)) {
      if (!key || /^\s+$/.test(key)) continue;

      try {
        const shortForm = getShortForm(value);
        const keyTrim = key.trim();
        const keyNorm = normalizeDnaKey(key);

        if (shortForm) {
          const shortNorm = normalizeDnaKey(shortForm);
          
          // Проверка точного совпадения
          if (keyTrim === shortForm || (keyNorm && shortNorm && keyNorm === shortNorm)) {
            issues.push({
              type: 'error',
              message: `Конфликт в глоссарии: ключ "${key}" совпадает с аббревиатурой "${shortForm}". Это приведет к ошибке '${key} – ${shortForm}'.`,
              suggestion: `Измените shortForm для ключа "${key}" на уникальное значение, отличное от ключа.`,
            });
          }
        }
      } catch (err) {
        // Пропускаем проблемные записи, но не падаем
        console.warn(`Error checking identity protection for key "${key}":`, err);
      }
    }
  } catch (err) {
    console.error('Error in checkIdentityProtection:', err);
  }

  return issues;
}

/**
 * 2. Проверка на Полноту Технического Словарного Запаса
 * Сканирует entityGroups и проверяет наличие латинских кодов электростанций в abbreviationLogic
 */
function checkTechnicalVocabularyCompleteness(
  entityGroups: Record<string, unknown> | null | undefined,
  abbreviationLogic: Record<string, unknown> | null | undefined,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  try {
    if (!entityGroups || typeof entityGroups !== 'object') {
      return issues;
    }

    if (!abbreviationLogic || typeof abbreviationLogic !== 'object') {
      return issues;
    }

    // Поиск powerPlants в entityGroups
    const powerPlants: string[] = [];
    for (const [groupKey, groupValue] of Object.entries(entityGroups)) {
      try {
        if (typeof groupKey === 'string' && groupKey.toLowerCase().includes('powerplant')) {
          if (Array.isArray(groupValue)) {
            for (const item of groupValue) {
              if (typeof item === 'string') {
                powerPlants.push(item);
              }
            }
          }
        }
      } catch (err) {
        console.warn(`Error processing entityGroup "${groupKey}":`, err);
      }
    }

    // Проверка наличия латинских кодов в abbreviationLogic
    const abbreviationKeys = new Set(Object.keys(abbreviationLogic).map(k => k.toUpperCase()));
    const abbreviationValues = new Set<string>();
    
    for (const value of Object.values(abbreviationLogic)) {
      try {
        const shortForm = getShortForm(value);
        if (shortForm) {
          abbreviationValues.add(shortForm.toUpperCase());
        }
      } catch (err) {
        console.warn('Error processing abbreviationLogic value:', err);
      }
    }

    // Проверка известных кодов электростанций
    for (const code of COMMON_POWER_PLANT_CODES) {
      try {
        const codeUpper = code.toUpperCase();
        if (!abbreviationKeys.has(codeUpper) && !abbreviationValues.has(codeUpper)) {
          // Проверяем, упоминается ли этот код в entityGroups
          const mentionedInGroups = powerPlants.some(plant => {
            try {
              return plant.toUpperCase().includes(codeUpper) || codeUpper.includes(plant.toUpperCase().slice(0, 4));
            } catch {
              return false;
            }
          });

          if (mentionedInGroups || powerPlants.length > 0) {
            issues.push({
              type: 'warning',
              message: `Отсутствует код электростанции "${code}" в словаре abbreviationLogic.`,
              suggestion: `Добавьте "${code}" в abbreviationLogic для избежания флагов SUSPICIOUS_ABBREV.`,
            });
          }
        }
      } catch (err) {
        console.warn(`Error checking power plant code "${code}":`, err);
      }
    }
  } catch (err) {
    console.error('Error in checkTechnicalVocabularyCompleteness:', err);
  }

  return issues;
}

/**
 * 3. Автоматическое Обогащение (Standard Definitions)
 * Проверка наличия базовых международных сокращений для направления RU→EN
 */
function checkStandardDefinitions(
  abbreviationLogic: Record<string, unknown> | null | undefined,
  direction: 'ru-en' | 'en-ru' | 'other' = 'other',
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  try {
    if (direction !== 'ru-en') {
      return issues;
    }

    if (!abbreviationLogic || typeof abbreviationLogic !== 'object') {
      // Если abbreviationLogic пуст, предлагаем импортировать все стандартные определения
      issues.push({
        type: 'warning',
        message: 'Отсутствуют базовые международные сокращения для направления RU→EN.',
        suggestion: `Рекомендуется импортировать базовый технический набор: ${STANDARD_RU_EN_DEFINITIONS.map(d => d.key).join(', ')}`,
      });
      return issues;
    }

    const abbreviationKeys = new Set(Object.keys(abbreviationLogic).map(k => {
      try {
        return normalizeDnaKey(k);
      } catch {
        return k;
      }
    }));

    for (const standard of STANDARD_RU_EN_DEFINITIONS) {
      try {
        const keyNorm = normalizeDnaKey(standard.key);
        const found = Array.from(abbreviationKeys).some(k => {
          try {
            return normalizeDnaKey(k) === keyNorm;
          } catch {
            return false;
          }
        });

        if (!found) {
          issues.push({
            type: 'warning',
            message: `Отсутствует базовое сокращение "${standard.key}" (${standard.abbreviation}) для направления RU→EN.`,
            suggestion: `Добавьте: "${standard.key}": { "longForm": "${standard.longForm}", "shortForm": "${standard.abbreviation}" }`,
          });
        }
      } catch (err) {
        console.warn(`Error checking standard definition "${standard.key}":`, err);
      }
    }
  } catch (err) {
    console.error('Error in checkStandardDefinitions:', err);
  }

  return issues;
}

/**
 * 4. Валидация Регулярных Выражений
 * Проверка того, что все namingConventions технически исполнимы программным кодом
 */
function validateNamingConventions(
  namingConventions: Record<string, unknown> | null | undefined,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  try {
    if (!namingConventions || typeof namingConventions !== 'object') {
      return issues;
    }

    // Проверка регулярных выражений в namingConventions
    for (const [key, value] of Object.entries(namingConventions)) {
      try {
        if (typeof value !== 'string') continue;

        // Поиск паттернов, которые выглядят как регулярные выражения
        const regexPattern = /\/.*\/[gimuy]*/;
        if (regexPattern.test(value)) {
          try {
            // Попытка создать RegExp из строки
            const regexStr = value.match(/\/.*\/[gimuy]*/)?.[0];
            if (regexStr) {
              const pattern = regexStr.slice(1, regexStr.lastIndexOf('/'));
              const flags = regexStr.slice(regexStr.lastIndexOf('/') + 1);
              new RegExp(pattern, flags);
            }
          } catch (err) {
            issues.push({
              type: 'error',
              message: `Некорректное регулярное выражение в namingConventions.${key}: "${value}"`,
              suggestion: `Исправьте синтаксис регулярного выражения или используйте текстовое описание вместо regex.`,
            });
          }
        }

        // Проверка на наличие специальных символов, которые могут быть проблематичными
        if (value.includes('${') || value.includes('`')) {
          issues.push({
            type: 'warning',
            message: `Потенциально проблематичные символы в namingConventions.${key}: "${value}"`,
            suggestion: 'Убедитесь, что шаблонные строки или интерполяция корректно обрабатываются.',
          });
        }
      } catch (err) {
        console.warn(`Error validating naming convention "${key}":`, err);
      }
    }
  } catch (err) {
    console.error('Error in validateNamingConventions:', err);
  }

  return issues;
}

/**
 * Основная функция валидации DNA
 */
export function validateDnaContract(
  dna: DnaPayload,
  direction: 'ru-en' | 'en-ru' | 'other' = 'other',
): DnaValidationResult {
  const issues: ValidationIssue[] = [];
  const suggestions: string[] = [];

  if (!dna) {
    return {
      status: 'OK',
      issues: [],
      suggestions: [],
    };
  }

  try {
    // 1. Проверка на логические петли (Identity Protection)
    if (dna.abbreviationLogic && typeof dna.abbreviationLogic === 'object') {
      try {
        const identityIssues = checkIdentityProtection(dna.abbreviationLogic);
        issues.push(...identityIssues);
      } catch (err) {
        console.error('Error in identity protection check:', err);
      }
    }

    // 2. Проверка полноты технического словарного запаса
    try {
      const vocabularyIssues = checkTechnicalVocabularyCompleteness(
        dna.entityGroups,
        dna.abbreviationLogic,
      );
      issues.push(...vocabularyIssues);
    } catch (err) {
      console.error('Error in vocabulary completeness check:', err);
    }

    // 3. Проверка стандартных определений
    try {
      const standardIssues = checkStandardDefinitions(dna.abbreviationLogic, direction);
      issues.push(...standardIssues);
    } catch (err) {
      console.error('Error in standard definitions check:', err);
    }

    // 4. Валидация регулярных выражений
    try {
      const regexIssues = validateNamingConventions(dna.namingConventions);
      issues.push(...regexIssues);
    } catch (err) {
      console.error('Error in naming conventions validation:', err);
    }
  } catch (err) {
    console.error('Error in validateDnaContract:', err);
    // Возвращаем предупреждение вместо падения
    issues.push({
      type: 'warning',
      message: 'Произошла ошибка при валидации DNA. Некоторые проверки могли быть пропущены.',
      suggestion: 'Проверьте структуру DNA вручную.',
    });
  }

  // Определение статуса
  const hasErrors = issues.some(i => i.type === 'error');
  const hasWarnings = issues.some(i => i.type === 'warning');

  let status: ValidationStatus = 'OK';
  if (hasErrors) {
    status = 'ERROR';
  } else if (hasWarnings) {
    status = 'WARNING';
  }

  // Формирование предложений
  for (const issue of issues) {
    if (issue.suggestion) {
      suggestions.push(issue.suggestion);
    }
  }

  return {
    status,
    issues,
    suggestions,
  };
}

/**
 * Форматирование результата валидации для вывода
 */
export function formatValidationReport(result: DnaValidationResult): string {
  try {
    const lines: string[] = [];
    
    if (!result || !result.status) {
      return 'Ошибка: некорректный результат валидации';
    }
    
    lines.push(`Статус: ${result.status}`);
    lines.push('');

    if (!result.issues || result.issues.length === 0) {
      lines.push('✓ Все проверки пройдены успешно.');
      return lines.join('\n');
    }

    const errors = (result.issues || []).filter(i => i && i.type === 'error');
    const warnings = (result.issues || []).filter(i => i && i.type === 'warning');

  if (errors.length > 0) {
    lines.push('ОШИБКИ (блокируют перевод):');
    for (const error of errors) {
      lines.push(`  ✗ ${error.message}`);
      if (error.suggestion) {
        lines.push(`    → ${error.suggestion}`);
      }
    }
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push('ПРЕДУПРЕЖДЕНИЯ (рекомендуемые правки):');
    for (const warning of warnings) {
      lines.push(`  ⚠ ${warning.message}`);
      if (warning.suggestion) {
        lines.push(`    → ${warning.suggestion}`);
      }
    }
    lines.push('');
  }

    if (result.suggestions && result.suggestions.length > 0) {
      lines.push('РЕКОМЕНДАЦИИ:');
      for (const suggestion of result.suggestions) {
        if (suggestion) {
          lines.push(`  • ${suggestion}`);
        }
      }
    }

    return lines.join('\n');
  } catch (err) {
    console.error('Error formatting validation report:', err);
    return `Ошибка при форматировании отчета: ${err instanceof Error ? err.message : String(err)}`;
  }
}
