import * as fs from 'fs';
import * as path from 'path';

// Стандартные отраслевые сокращения для RU→EN
const STANDARD_DEFINITIONS = [
  { key: 'МВт', longForm: 'Megawatt', shortForm: 'MW' },
  { key: 'СН', longForm: 'Auxiliary Power', shortForm: 'SN' },
  { key: 'ТОО', longForm: 'Limited Liability Partnership', shortForm: 'LLP' },
  { key: 'АО', longForm: 'Joint Stock Company', shortForm: 'JSC' },
  { key: 'ОАО', longForm: 'Open Joint Stock Company', shortForm: 'JSC' },
  { key: 'Рмин', longForm: 'Minimum Power', shortForm: 'Pmin' },
  { key: 'Скорость набора/сброса нагрузки', longForm: 'Ramp-up/down rate', shortForm: 'Ramp-up/down rate' },
];

// Известные коды электростанций (из типичных данных)
const POWER_PLANT_CODES = [
  { key: 'УКГЭС', longForm: 'Ust-Kamenogorsk Hydroelectric Power Plant', shortForm: 'UKGES' },
  { key: 'ШарГЭС', longForm: 'Shardara Hydroelectric Power Plant', shortForm: 'SHPP' },
  { key: 'ГТЭС', longForm: 'Gas Turbine Power Plant', shortForm: 'GTPP' },
  { key: 'ТЭС', longForm: 'Thermal Power Plant', shortForm: 'TPP' },
  { key: 'ГЭС', longForm: 'Hydroelectric Power Plant', shortForm: 'HPP' },
  { key: 'АЭС', longForm: 'Nuclear Power Plant', shortForm: 'NPP' },
  { key: 'ВЭС', longForm: 'Wind Power Plant', shortForm: 'WPP' },
  { key: 'СЭС', longForm: 'Solar Power Plant', shortForm: 'SPP' },
];

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

function hasIdentityConflict(key: string, shortForm: string): boolean {
  return normalizeKey(key) === normalizeKey(shortForm);
}

function enrichAbbreviationLogic(
  currentLogic: Record<string, { longForm: string; shortForm: string }>,
): Record<string, { longForm: string; shortForm: string }> {
  const enriched: Record<string, { longForm: string; shortForm: string }> = { ...currentLogic };
  const existingKeys = new Set(Object.keys(enriched).map(normalizeKey));

  // Добавляем стандартные определения
  for (const def of STANDARD_DEFINITIONS) {
    const normalizedKey = normalizeKey(def.key);
    if (!existingKeys.has(normalizedKey)) {
      // Проверяем на конфликт identity
      if (!hasIdentityConflict(def.key, def.shortForm)) {
        enriched[def.key] = {
          longForm: def.longForm,
          shortForm: def.shortForm,
        };
        existingKeys.add(normalizedKey);
      }
    }
  }

  // Добавляем коды электростанций
  for (const code of POWER_PLANT_CODES) {
    const normalizedKey = normalizeKey(code.key);
    if (!existingKeys.has(normalizedKey)) {
      // Проверяем на конфликт identity
      if (!hasIdentityConflict(code.key, code.shortForm)) {
        enriched[code.key] = {
          longForm: code.longForm,
          shortForm: code.shortForm,
        };
        existingKeys.add(normalizedKey);
      }
    }
  }

  return enriched;
}

// Читаем текущий файл DNA
const dnaFilePath = path.join(__dirname, '..', '..', 'document-dna-en-ru-adapted.json');
const dnaContent = fs.readFileSync(dnaFilePath, 'utf-8');
const dna = JSON.parse(dnaContent);

// Обогащаем abbreviationLogic
const currentAbbreviationLogic = (dna.abbreviationLogic || {}) as Record<string, { longForm: string; shortForm: string }>;
const enrichedAbbreviationLogic = enrichAbbreviationLogic(currentAbbreviationLogic);

// Выводим только обновленный блок abbreviationLogic
console.log(JSON.stringify(enrichedAbbreviationLogic, null, 2));
