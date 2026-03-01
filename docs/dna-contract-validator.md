# DNA-Contract-Validator

Модуль Shift-Left валидации для файлов DNA перед началом процесса перевода.

## Цель

Проверка JSON-файла DNA на логическую целостность, полноту и отсутствие конфликтов до начала процесса перевода.

## Реализованные проверки

### 1. Проверка на Логические Петли (Identity Protection)

**Правило:** `shortForm` не должна быть идентична исходному ключу (например, `"ЕЭС": { "shortForm": "ЕЭС" }`).

**Действие:** Если найдено совпадение, валидатор выдает ошибку: «Конфликт в глоссарии: ключ совпадает с аббревиатурой. Это приведет к ошибке 'ERS – ERS'».

**Статус:** `ERROR` (блокирует перевод)

### 2. Проверка на Полноту Технического Словарного Запаса

**Правило:** Каждая сущность в `entityGroups` должна иметь соответствующее правило в `abbreviationLogic`, если она часто встречается в сокращенном виде.

**Действие:** Валидатор сканирует `powerPlants` и проверяет наличие их латинских кодов (GTPP, UKGES и т.д.) в словаре. Если кода нет, он предлагает его добавить, чтобы избежать флагов `SUSPICIOUS_ABBREV`.

**Статус:** `WARNING` (не блокирует перевод)

### 3. Автоматическое Обогащение (Standard Definitions)

**Правило:** В каждом DNA должны присутствовать базовые международные сокращения для выбранного направления.

**Действие:** Проверка наличия «белого списка» для направления RU→EN: MW, JSC, LLP, SN, Pmin, Ramp-up/down rate. Если их нет — автоматическое предложение импортировать базовый технический набор.

**Статус:** `WARNING` (не блокирует перевод)

### 4. Валидация Регулярных Выражений

**Правило:** Проверка того, что все `namingConventions` технически исполнимы программным кодом.

**Действие:** Валидация синтаксиса регулярных выражений в `namingConventions` и проверка на проблематичные символы.

**Статус:** `ERROR` для некорректных regex, `WARNING` для потенциально проблематичных символов

## Использование

### Программный API

```typescript
import { validateDnaContract, formatValidationReport } from '../services/validate-dna';
import { getTranslationDirection } from '../services/dnaPrompts';

const dna = {
  abbreviationLogic: { /* ... */ },
  entityGroups: { /* ... */ },
  namingConventions: { /* ... */ },
  technicalSchema: { /* ... */ },
};

const direction = getTranslationDirection(sourceLocale, targetLocale);
const result = validateDnaContract(dna, direction);

if (result.status === 'ERROR') {
  // Блокировать перевод
  console.error('DNA validation failed:', result.issues);
} else if (result.status === 'WARNING') {
  // Предупреждения, но можно продолжать
  console.warn('DNA validation warnings:', result.issues);
}

// Форматированный отчет
console.log(formatValidationReport(result));
```

### REST API

#### GET `/api/documents/:documentId/dna/validate`

Возвращает результат валидации DNA, включая расширенную валидацию:

```json
{
  "valid": true,
  "errors": [],
  "abbreviationCount": 15,
  "contractValidation": {
    "status": "WARNING",
    "issues": [
      {
        "type": "warning",
        "message": "Отсутствует базовое сокращение \"МВт\" (MW) для направления RU→EN.",
        "suggestion": "Добавьте: \"МВт\": { \"longForm\": \"megawatt\", \"shortForm\": \"MW\" }"
      }
    ],
    "suggestions": ["..."],
    "report": "Статус: WARNING\n\nПРЕДУПРЕЖДЕНИЯ..."
  }
}
```

#### PUT `/api/documents/:documentId/dna`

При сохранении DNA автоматически выполняется валидация. При наличии ошибок (`status === 'ERROR'`) возвращается 400 с деталями.

## Интеграция в процесс перевода

Валидация автоматически выполняется:

1. **При сохранении DNA** (`PUT /api/documents/:documentId/dna`) — блокирует сохранение при ошибках
2. **Перед началом перевода** (`pretranslateDocument`) — блокирует перевод при ошибках, логирует предупреждения

## Тестирование

Запуск тестового скрипта:

```bash
npx tsx backend/scripts/test-dna-validation.ts
```

## Статусы валидации

- **OK** — все проверки пройдены успешно
- **WARNING** — есть рекомендации, но перевод можно продолжать
- **ERROR** — есть критические ошибки, перевод блокируется

## Примеры ошибок

### Identity Protection

```json
{
  "abbreviationLogic": {
    "ЕЭС": { "longForm": "Unified Power System", "shortForm": "ЕЭС" }
  }
}
```

**Ошибка:** `Конфликт в глоссарии: ключ "ЕЭС" совпадает с аббревиатурой "ЕЭС". Это приведет к ошибке 'ЕЭС – ЕЭС'.`

**Решение:** Изменить `shortForm` на уникальное значение, например `"UPS"`.

### Отсутствие стандартных определений

Для направления RU→EN отсутствуют базовые сокращения (MW, JSC, LLP и т.д.).

**Предупреждение:** `Отсутствует базовое сокращение "МВт" (MW) для направления RU→EN.`

**Решение:** Добавить стандартные определения в `abbreviationLogic`.
