/**
 * Тестовый скрипт для проверки DNA-Contract-Validator
 * Использование: npx tsx backend/scripts/test-dna-validation.ts
 */

import { validateDnaContract, formatValidationReport } from '../src/services/validate-dna';

// Тестовые данные
const testDnaWithIdentityIssue = {
  abbreviationLogic: {
    'ЕЭС': { longForm: 'Unified Power System', shortForm: 'ЕЭС' }, // Ошибка: shortForm совпадает с ключом
    'СЭР': { longForm: 'Energy Regime Service', shortForm: 'ERS' },
  },
  entityGroups: {
    powerPlants: ['ГТЭС', 'Усть-Каменогорская ГЭС'],
  },
  namingConventions: {
    dateNotation: 'Даты: ДД Месяц ГГГГ',
  },
};

const testDnaWithMissingStandards = {
  abbreviationLogic: {
    'СЭР': { longForm: 'Energy Regime Service', shortForm: 'ERS' },
  },
  entityGroups: null,
  namingConventions: null,
};

const testDnaValid = {
  abbreviationLogic: {
    'ЕЭС': { longForm: 'Unified Power System', shortForm: 'UPS' },
    'СЭР': { longForm: 'Energy Regime Service', shortForm: 'ERS' },
    'МВт': { longForm: 'megawatt', shortForm: 'MW' },
    'ОАО': { longForm: 'Joint Stock Company', shortForm: 'JSC' },
    'ТОО': { longForm: 'Limited Liability Partnership', shortForm: 'LLP' },
    'СН': { longForm: 'auxiliary power', shortForm: 'SN' },
  },
  entityGroups: {
    powerPlants: ['GTPP', 'UKGES'],
  },
  namingConventions: {
    dateNotation: 'Даты: ДД Месяц ГГГГ',
    phaseLetters: 'Фазы: только латинские буквы (A, B, C)',
  },
};

console.log('=== Тест 1: Identity Protection (Ошибка) ===\n');
const result1 = validateDnaContract(testDnaWithIdentityIssue, 'ru-en');
console.log(formatValidationReport(result1));
console.log('\n');

console.log('=== Тест 2: Отсутствие стандартных определений (Предупреждение) ===\n');
const result2 = validateDnaContract(testDnaWithMissingStandards, 'ru-en');
console.log(formatValidationReport(result2));
console.log('\n');

console.log('=== Тест 3: Валидный DNA (OK) ===\n');
const result3 = validateDnaContract(testDnaValid, 'ru-en');
console.log(formatValidationReport(result3));
console.log('\n');
