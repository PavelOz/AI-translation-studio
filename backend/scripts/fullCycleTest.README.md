# Full Cycle Test

Сквозной интеграционный тест всей системы AI Translation Studio V2.

## Описание

Тест выполняет полный цикл работы системы:
1. **DNA Synthesis** - синтез DNA из документа
2. **Massive Translation** - массовый перевод с использованием DNA
3. **Universal Audit** - проверка перевода через UniversalJanitor

## Использование

### Базовый запуск

```bash
npx ts-node backend/scripts/fullCycleTest.ts <documentId>
```

### С опциями

```bash
npx ts-node backend/scripts/fullCycleTest.ts <documentId> \
  --tags energy,KEGOC,power-plant \
  --synthesis-provider gemini \
  --synthesis-model gemini-1.5-pro \
  --translation-provider gemini \
  --translation-model gemini-1.5-flash \
  --max-segments 100 \
  --strict-mode \
  --dry-run
```

### Опции

- `--tags <tag1,tag2,...>` - Теги документа для автоматического подбора Master DNA (по умолчанию: `energy,KEGOC`)
- `--synthesis-provider <p>` - Провайдер для синтеза DNA (по умолчанию: `gemini`)
- `--synthesis-model <m>` - Модель для синтеза DNA (по умолчанию: `gemini-1.5-pro`)
- `--translation-provider <p>` - Провайдер для перевода (по умолчанию: `gemini`)
- `--translation-model <m>` - Модель для перевода (по умолчанию: `gemini-1.5-flash`)
- `--max-segments <n>` - Максимальное количество сегментов для обработки (по умолчанию: 1000)
- `--no-auto-fix` - Отключить автоматическое исправление в аудите
- `--strict-mode` - Включить строгий режим в аудите
- `--dry-run` - Не сохранять изменения в БД

## Пример структуры логов

```
[2025-01-15 10:30:00] INFO: 🚀 Starting Full Cycle Test
  documentId: "abc123-def456-..."
  tags: ["energy", "KEGOC"]
  synthesisProvider: "gemini"
  translationProvider: "gemini"

[2025-01-15 10:30:01] INFO: 📄 Document loaded
  documentName: "Energy Plant Certification Report 2025"
  direction: "ru → en"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1: DNA SYNTHESIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[2025-01-15 10:30:02] INFO: Resolving Master DNA by tags: energy, KEGOC...
[2025-01-15 10:30:03] INFO: Master DNA resolved from 3 documents
[2025-01-15 10:30:05] INFO: Indexed 45 master DNA terms
[2025-01-15 10:30:10] INFO: Extracted 12 terms
[2025-01-15 10:30:15] INFO: Merged 15 terms, resolved 3 conflicts
[2025-01-15 10:30:20] INFO: Enriching batch 1/2 (35 terms)...
[2025-01-15 10:30:25] INFO: Enriched 8 terms with LLM (batch mode)
[2025-01-15 10:30:30] INFO: ✅ DNA Synthesis completed
  totalTerms: 23
  validationRules: 5
  extracted: 12
  fromMaster: 45
  llmEnriched: 8

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2: MASSIVE TRANSLATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[2025-01-15 10:30:35] INFO: 📝 Segments loaded for translation
  segmentsCount: 50

[2025-01-15 10:30:36] INFO: Batch translation configuration
  provider: "gemini"
  model: "gemini-1.5-flash"
  maxBatchSize: 30
  optimalBatchSize: 21
  totalSegments: 50
  hasDna: true

[2025-01-15 10:30:37] INFO: DNA filtered by relevance
  totalTerms: 23
  relevantTerms: 8
  segmentsCount: 21

[2025-01-15 10:30:40] INFO: 🔄 Translation progress
  current: 21
  total: 50
  batch: "1/3"

[2025-01-15 10:30:45] INFO: 🔄 Translation progress
  current: 42
  total: 50
  batch: "2/3"

[2025-01-15 10:30:50] INFO: 🔄 Translation progress
  current: 50
  total: 50
  batch: "3/3"

[2025-01-15 10:30:51] INFO: ✅ Translation completed
  translated: 50
  totalBatches: 3
  errors: 0

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3: UNIVERSAL AUDIT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[2025-01-15 10:30:55] INFO: DNA term index built
  totalKeys: 23
  totalShortForms: 18
  totalAliases: 12

[2025-01-15 10:31:00] INFO: ✅ Audit completed
  validated: 42
  autoFixed: 5
  requiresReview: 3
  totalErrors: 8

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 FINAL REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

╔═══════════════════════════════════════════════════════════════════════════════╗
║                    AI TRANSLATION STUDIO V2 - FULL CYCLE TEST                ║
╚═══════════════════════════════════════════════════════════════════════════════╝

📄 Document Information:
   Name: Energy Plant Certification Report 2025
   Direction: ru → en
   Document ID: abc123-def456-...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1: DNA SYNTHESIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ✅ Status: COMPLETED
   📚 Total DNA Terms: 23
   📋 Validation Rules: 5

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2: MASSIVE TRANSLATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ✅ Status: COMPLETED
   📝 Total Segments: 50
   ✅ Translated: 50
   📦 Batches: 3
   ❌ Errors: 0

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3: UNIVERSAL AUDIT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ✅ Status: COMPLETED
   ✅ Validated: 42
   🔧 Auto-fixed: 5
   ⚠️  Requires Review: 3
   ❌ Total Errors: 8

   Error Breakdown:
      - MISSED_TERM: 3
      - WRONG_TERM: 2
      - CONSTRAINT_VIOLATION: 2
      - SCRIPT_MIXING: 1

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 FINAL STATISTICS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   📚 DNA Terms Used: 23
   📝 Segments Processed: 50
   ✅ Segments Validated: 42
   ⚠️  Segments Requiring Review: 3
   🎯 Overall Quality: GOOD
   ⏱️  Total Duration: 61.23s

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  SEGMENTS REQUIRING REVIEW (Sample)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   Segment #15:
   Comment: Missed terms: 'Pinst'. Constraint violations: 'Unit' should be 'Block'.
   Errors: 2
      - Missed term: 'Pinst' (expected: 'installed capacity' or 'Pinst')
      - Constraint violation: 'Unit' - Always means 'Block' (Блок), not 'Unit' (Единица)

   Segment #28:
   Comment: Wrong term usage: 'ООО' (expected: 'LLC', found: 'Ltd').
   Errors: 1
      - Wrong term usage: 'ООО' should use shortForm 'LLC' but found 'Ltd'

   Segment #42:
   Comment: Script mixing detected: Cyrillic script detected in English translation: 'Энерго-Плюс'.
   Errors: 1
      - Cyrillic script detected in English translation: 'Энерго-Плюс'

╔═══════════════════════════════════════════════════════════════════════════════╗
║                              TEST COMPLETED                                   ║
╚═══════════════════════════════════════════════════════════════════════════════╝

[2025-01-15 10:31:01] INFO: 📄 Test results saved to file
  outputPath: "/path/to/full-cycle-test-abc123-1705312261000.json"
```

## Структура JSON отчета

Результаты теста сохраняются в JSON файл:

```json
{
  "documentId": "abc123-def456-...",
  "documentName": "Energy Plant Certification Report 2025",
  "direction": "ru → en",
  "synthesis": {
    "completed": true,
    "totalTerms": 23,
    "validationRules": 5
  },
  "translation": {
    "completed": true,
    "totalSegments": 50,
    "translated": 50,
    "batches": 3,
    "errors": 0
  },
  "audit": {
    "completed": true,
    "validated": 42,
    "autoFixed": 5,
    "requiresReview": 3,
    "totalErrors": 8,
    "errorsByType": {
      "MISSED_TERM": 3,
      "WRONG_TERM": 2,
      "CONSTRAINT_VIOLATION": 2,
      "SCRIPT_MIXING": 1
    }
  },
  "finalStats": {
    "dnaTermsUsed": 23,
    "segmentsProcessed": 50,
    "segmentsValidated": 42,
    "segmentsRequiringReview": 3,
    "overallQuality": "good"
  },
  "timestamp": "2025-01-15T10:31:01.000Z",
  "duration": 61230
}
```

## Интерпретация результатов

### Overall Quality

- **EXCELLENT** (≥95% validated): Почти все сегменты прошли проверку
- **GOOD** (≥85% validated): Большинство сегментов в порядке, есть несколько для проверки
- **NEEDS_REVIEW** (≥70% validated): Значительное количество сегментов требует проверки
- **POOR** (<70% validated): Много ошибок, требуется серьезная доработка

### Типы ошибок

- **MISSED_TERM**: Термин из DNA пропущен в переводе - требует проверки
- **WRONG_TERM**: Термин переведен неправильно - требует исправления
- **CONSTRAINT_VIOLATION**: Нарушение правил из validationHints - критично
- **SCRIPT_MIXING**: Смешение алфавитов - критично

## Требования

- Node.js 18+
- Настроенные API ключи в `.env`:
  - `GEMINI_API_KEY` (для синтеза и перевода)
  - Или другие ключи в зависимости от выбранных провайдеров
- База данных с документом и сегментами

## Примеры использования

### Тест с ограниченным количеством сегментов

```bash
npx ts-node backend/scripts/fullCycleTest.ts <documentId> --max-segments 20
```

### Тест в dry-run режиме (без сохранения)

```bash
npx ts-node backend/scripts/fullCycleTest.ts <documentId> --dry-run
```

### Тест со строгим режимом

```bash
npx ts-node backend/scripts/fullCycleTest.ts <documentId> --strict-mode
```

### Тест с кастомными тегами

```bash
npx ts-node backend/scripts/fullCycleTest.ts <documentId> --tags energy,power-plant,certification
```
