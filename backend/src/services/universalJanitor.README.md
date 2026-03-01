# UniversalJanitor

DNA-Driven Audit с концепцией Human-in-the-loop для проверки переведенных сегментов.

## Основные возможности

### 1. DNA-Driven Audit
Сопоставляет переведенные сегменты с `DocumentDnaPayload`:
- Проверяет соответствие терминов из `abbreviationLogic`
- Применяет правила из `validationHints.rules`
- Использует эффективный индекс для быстрого поиска

### 2. Flagging Logic (HITL)
Система статусов для сегментов:

- **VALIDATED**: Все правила DNA соблюдены, перевод корректен
- **AUTO_FIXED**: Были мелкие несоответствия (регистр, пробелы), исправлены автоматически
- **REQUIRES_REVIEW**: Обнаружены серьезные расхождения, требуется проверка человеком

### 3. Validation Suite

#### Glossary Integrity
Проверяет, что ключевые термины из DNA переведены правильно:
- Если термин есть в исходном тексте, проверяет наличие в переводе
- Проверяет использование `longForm` vs `shortForm`
- Обнаруживает пропущенные термины

**Пример:**
```
Source: "Наименование энергопроизводящей организации: ООО 'Энерго-Плюс'"
Target: "Name of energy-producing organization: Energy Plus"

Error: MISSED_TERM
Message: "Missed term: 'ООО 'Энерго-Плюс'' (expected: 'Energy Plus LLC' or 'Energy Plus LLC')"
```

#### Script Integrity
Детекция смешения алфавитов на основе направления перевода:
- RU → EN: не должно быть кириллицы
- EN → RU: проверка на смешение в одном слове

**Пример:**
```
Target: "Energy Plus LLC (Энерго-Плюс)"

Error: SCRIPT_MIXING
Message: "Cyrillic script detected in English translation: 'Энерго-Плюс'"
```

#### Constraint Check
Проверка специфичных правил из `validationHints.rules`:

**Пример правила:**
```json
{
  "term": "Unit",
  "context": "technical reports",
  "rule": "Always means 'Block' (Блок), not 'Unit' (Единица)",
  "example": "Unit 1 → Block 1"
}
```

**Проверка:**
```
Source: "Unit 1 работает"
Target: "Unit 1 is operating"

Error: CONSTRAINT_VIOLATION
Message: "Constraint violation: 'Unit' - Always means 'Block' (Блок), not 'Unit' (Единица)"
```

### 4. Reason Reporting
Для каждого сегмента со статусом `REQUIRES_REVIEW` генерируется понятное описание:

**Пример комментария:**
```
"Missed terms: 'Pinst', 'Net tie-line flow'. Wrong term usage: 'ООО' (expected: 'LLC', found: 'Ltd'). Constraint violations: 'Unit' should be 'Block'."
```

### 5. Batch Processing
Эффективная проверка массива сегментов:
- **Без LLM**: вся логика алгоритмическая
- **Индексация**: быстрый поиск терминов через `DnaTermIndex`
- **Параллелизация**: можно обрабатывать сегменты параллельно

## Использование

### Базовый аудит

```typescript
import { UniversalJanitor } from './universalJanitor';

const janitor = new UniversalJanitor();

const report = await janitor.auditSegments('document-id', {
  autoFix: true,      // Автоматически исправлять мелкие ошибки
  strictMode: false,  // Не строгий режим
  dryRun: false,      // Сохранять изменения в БД
});

console.log(`Validated: ${report.statistics.validated}`);
console.log(`Auto-fixed: ${report.statistics.autoFixed}`);
console.log(`Requires review: ${report.statistics.requiresReview}`);
```

### Dry-run режим

```typescript
const report = await janitor.auditSegments('document-id', {
  autoFix: true,
  strictMode: true,
  dryRun: true, // Не сохранять изменения
});

// Анализируем результаты перед применением
if (report.statistics.requiresReview < 10) {
  // Применяем изменения
  await janitor.auditSegments('document-id', { dryRun: false });
}
```

### Анализ ошибок

```typescript
const report = await janitor.auditSegments('document-id', {
  autoFix: false, // Не исправлять, чтобы увидеть все ошибки
});

// Сегменты с пропущенными терминами
const missedTermSegments = report.segments.filter(s =>
  s.errors.some(e => e.type === 'MISSED_TERM')
);

for (const segment of missedTermSegments) {
  console.log(`Segment ${segment.segmentIndex}: ${segment.janitorComment}`);
}
```

## Структура отчета

```typescript
interface JanitorReport {
  documentId: string;
  documentName?: string;
  direction: string; // "ru → en"
  statistics: {
    totalSegments: number;
    validated: number;
    autoFixed: number;
    requiresReview: number;
    totalErrors: number;
    totalWarnings: number;
    errorsByType: {
      MISSED_TERM: number;
      WRONG_TERM: number;
      SCRIPT_MIXING: number;
      CONSTRAINT_VIOLATION: number;
      // ...
    };
  };
  segments: Array<{
    segmentId: string;
    segmentIndex: number;
    status: 'VALIDATED' | 'AUTO_FIXED' | 'REQUIRES_REVIEW';
    originalText: string;
    fixedText?: string;
    errors: ValidationError[];
    warnings: ValidationWarning[];
    janitorComment?: string;
  }>;
  dnaUsed: {
    totalTerms: number;
    termsChecked: number;
    validationRules: number;
  };
  timestamp: Date;
}
```

## Типы ошибок

- **MISSED_TERM**: Термин из DNA пропущен в переводе
- **WRONG_TERM**: Термин переведен неправильно (например, использован longForm вместо shortForm)
- **SCRIPT_MIXING**: Смешение алфавитов (кириллица/латиница)
- **CONSTRAINT_VIOLATION**: Нарушение правил из validationHints
- **CASE_MISMATCH**: Неправильный регистр (автоисправляется)
- **SPACING_ISSUE**: Проблемы с пробелами (автоисправляется)
- **FORMAT_ISSUE**: Проблемы с форматированием

## Автоматическое исправление

При `autoFix: true` автоматически исправляются:
- Регистр (CASE_MISMATCH)
- Пробелы (SPACING_ISSUE)
- Простые проблемы форматирования (FORMAT_ISSUE)

**Критические ошибки не исправляются автоматически:**
- MISSED_TERM
- WRONG_TERM
- SCRIPT_MIXING
- CONSTRAINT_VIOLATION

## Интеграция с DnaSynthesisService

```typescript
import { DnaSynthesisService } from './dnaSynthesis.service';
import { UniversalJanitor } from './universalJanitor';

// 1. Синтезируем DNA
const synthesisService = new DnaSynthesisService();
const synthesisResult = await synthesisService.synthesize(
  { type: 'document', documentId },
  masterDna,
  documentId,
  { useLLM: true }
);

// 2. Выполняем перевод (используя TranslationOrchestrator)
// ...

// 3. Проверяем перевод с помощью UniversalJanitor
const janitor = new UniversalJanitor();
const auditReport = await janitor.auditSegments(documentId, {
  autoFix: true,
  strictMode: false,
});

// 4. Обрабатываем результаты
const requiresReview = auditReport.segments.filter(
  s => s.status === 'REQUIRES_REVIEW'
);

// Отправляем на проверку человеку
for (const segment of requiresReview) {
  console.log(`Segment ${segment.segmentIndex} requires review: ${segment.janitorComment}`);
}
```

## Производительность

- **Без LLM**: вся логика алгоритмическая, быстрая
- **Индексация**: O(1) поиск терминов через Map
- **Batch processing**: обрабатывает все сегменты за один проход
- **Параллелизация**: можно обрабатывать сегменты параллельно

## Сохранение результатов

Результаты сохраняются в БД:
- `AUTO_FIXED`: обновляется `targetMt` с исправленным текстом
- `REQUIRES_REVIEW`: сохраняется `janitorComment` в `mtAnalysis` (временное решение)

**TODO**: Добавить поле `janitorComment` в схему `Segment` для постоянного хранения.
