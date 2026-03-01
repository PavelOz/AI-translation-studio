# TranslationOrchestrator

Массовый перевод с использованием синтезированной DNA.

## Основные возможности

### 1. Contextual DNA Filtering
Метод `getRelevantDna()` анализирует текст сегментов и возвращает только релевантные записи из DNA:

```typescript
const relevantDna = orchestrator.getRelevantDna(segments, fullDna);
// Возвращает только те термины, которые встречаются в сегментах
```

**Алгоритм фильтрации:**
- Проверяет прямое вхождение ключа термина
- Проверяет вхождение отдельных слов ключа (для составных терминов)
- Проверяет shortForm и aliases
- Проверяет longForm

### 2. Agnostic Batch Translation
Использует `ModelCapabilities` для автоматического определения размера батча:

```typescript
const capabilities = provider.getCapabilities(model);
// Gemini 1.5 Pro: maxBatchSize = 50
// GPT-4o: maxBatchSize = 40
// YandexGPT: maxBatchSize = 25
```

Размер батча автоматически корректируется с учетом DNA overhead (~30%).

### 3. DNA-Injected Prompt Template

#### Системный промпт (для моделей с поддержкой systemInstructions):
```
You are a professional technical translator. Translate from ru to en.

CRITICAL REQUIREMENTS:
1. Follow the translation direction: FROM ru TO en
2. Your output MUST be in en only
3. Return translations in strict JSON format: [{"id": "segment_id", "target": "translated_text"}]
4. Preserve technical terminology and formatting
5. Maintain consistency with provided glossary terms

[GLOSSARY]
"ООО "Энерго-Плюс"" → "Energy Plus LLC" (abbr: Energy Plus LLC)
"энергопроизводящая организация" → "energy-producing organization" (abbr: EPO)

[STYLE_RULES]
- "ООО": Always translate as "LLC" (context: company names)
  Example: ООО "Энерго-Плюс" → Energy Plus LLC

[WARNINGS]
- "энергопроизводящая организация": Do not confuse with "power plant"
```

#### Пользовательский промпт:
```
Translate the following segments from ru to en.
Document: Energy Plant Certification Report 2025
Document Summary: Annual certification report for energy-producing organizations

[GLOSSARY]
"ООО "Энерго-Плюс"" → "Energy Plus LLC" (abbr: Energy Plus LLC)
...

Segments to translate:
1. [ID: seg-1] ООО "Энерго-Плюс" является энергопроизводящей организацией
   [Previous: ...]
   [Next: ...]

Return ONLY a JSON array in this exact format:
[
  {"id": "segment_id_1", "target": "translated text 1"},
  {"id": "segment_id_2", "target": "translated text 2"}
]
```

### 4. Model-Specific Optimization

- **Gemini, OpenAI, Yandex, DeepSeek**: DNA отправляется в `systemPrompt` (systemInstructions)
- **Claude и другие**: DNA включается в `userPrompt` как приоритетные инструкции

### 5. Reliability

Интегрирован `callModelWithRetry` с экспоненциальным backoff:
- Автоматические повторы при rate limits
- Защита от временных сбоев API
- Логирование всех попыток

## Использование

### Базовый батч-перевод

```typescript
import { TranslationOrchestrator } from './translationOrchestrator';

const orchestrator = new TranslationOrchestrator();

const result = await orchestrator.translateBatch(segments, {
  provider: 'gemini',
  model: 'gemini-1.5-pro',
  apiKey: process.env.GEMINI_API_KEY,
  sourceLocale: 'ru',
  targetLocale: 'en',
  dna: synthesizedDna,
  documentName: 'Report 2025',
  temperature: 0.2,
});
```

### Массовый перевод с прогрессом

```typescript
const result = await orchestrator.translateAll(segments, {
  provider: 'gemini',
  model: 'gemini-1.5-pro',
  sourceLocale: 'ru',
  targetLocale: 'en',
  dna: synthesizedDna,
  onProgress: (progress) => {
    console.log(`${progress.current}/${progress.total} segments`);
  },
});
```

### Фильтрация DNA

```typescript
const relevantDna = orchestrator.getRelevantDna(segments, fullDna);
// Возвращает только релевантные термины
console.log('Relevant terms:', relevantDna.relevantTerms);
```

## Структура ответа

```typescript
interface BatchTranslationResult {
  segments: TranslatedSegment[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
  errors?: Array<{ segmentId: string; error: string }>;
}

interface TranslatedSegment {
  id: string;
  target: string;
  confidence?: number;
  analysis?: string;
}
```

## Оптимизация производительности

1. **Контекстуальная фильтрация**: Минимизирует размер промпта, отправляя только релевантные термины
2. **Динамический батчинг**: Автоматически определяет оптимальный размер батча для модели
3. **Retry механизм**: Защищает от временных сбоев без ручного вмешательства
4. **Model-specific optimization**: Использует systemInstructions где возможно

## Примеры инъекции DNA в промпт

### Пример 1: Простой термин
```json
{
  "abbreviationLogic": {
    "ООО": {
      "longForm": "Limited Liability Company",
      "shortForm": "LLC"
    }
  }
}
```

**В промпте:**
```
[GLOSSARY]
"ООО" → "Limited Liability Company" (abbr: LLC)
```

### Пример 2: Термин с aliases
```json
{
  "abbreviationLogic": {
    "энергопроизводящая организация": {
      "longForm": "energy-producing organization",
      "shortForm": "EPO",
      "aliases": ["ЭПО", "энергопроизводящая орг."]
    }
  }
}
```

**В промпте:**
```
[GLOSSARY]
"энергопроизводящая организация" → "energy-producing organization" (abbr: EPO) [aliases: ЭПО, энергопроизводящая орг.]
```

### Пример 3: Validation Hints
```json
{
  "validationHints": {
    "rules": [
      {
        "term": "Unit",
        "context": "technical reports",
        "rule": "Always means 'Block' (Блок), not 'Unit' (Единица)",
        "example": "Unit 1 → Block 1"
      }
    ],
    "warnings": [
      {
        "term": "энергопроизводящая организация",
        "message": "Do not confuse with 'power plant' - refers to organization, not facility"
      }
    ]
  }
}
```

**В промпте:**
```
[STYLE_RULES]
- "Unit": Always means 'Block' (Блок), not 'Unit' (Единица) (context: technical reports)
  Example: Unit 1 → Block 1

[WARNINGS]
- "энергопроизводящая организация": Do not confuse with 'power plant' - refers to organization, not facility
```

## Интеграция с DnaSynthesisService

```typescript
import { DnaSynthesisService } from '../services/dnaSynthesis.service';
import { TranslationOrchestrator } from './translationOrchestrator';

// 1. Синтезируем DNA
const synthesisService = new DnaSynthesisService();
const synthesisResult = await synthesisService.synthesize(
  { type: 'document', documentId },
  masterDna,
  documentId,
  { useLLM: true, llmProvider: 'gemini' }
);

// 2. Используем синтезированную DNA для перевода
const orchestrator = new TranslationOrchestrator();
const translationResult = await orchestrator.translateAll(segments, {
  provider: 'gemini',
  model: 'gemini-1.5-pro',
  sourceLocale: 'ru',
  targetLocale: 'en',
  dna: synthesisResult.synthesized, // Используем синтезированную DNA
});
```
