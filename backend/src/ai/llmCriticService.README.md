# LlmCriticService

Сервис для оценки качества переводов с использованием LLM и Document DNA.

## Описание

`LlmCriticService` выполняет строгую проверку качества переводов, используя:
- **Document DNA Glossary** (`abbreviationLogic`) для проверки терминов
- **Validation Hints** для проверки стиля
- **LLM-анализ** для поиска типичных ошибок (пропуски, неверные единицы измерения, форматирование)

## Основные возможности

1. **Интеграция с DNA**: Автоматически использует `abbreviationLogic` и `validationHints` из Document DNA
2. **Модель-агностичность**: Работает с любым провайдером из Registry (Gemini Pro по умолчанию)
3. **Строгая проверка**: Находит критические ошибки в терминологии и стиле
4. **Детальная отчетность**: Возвращает структурированный отчет с ошибками, предупреждениями и оценкой

## Использование

```typescript
import { LlmCriticService } from './llmCriticService';

const criticService = new LlmCriticService();

const review = await criticService.review(
  sourceText,      // Исходный текст
  targetText,      // Переведенный текст
  {
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    apiKey: '...',
    sourceLocale: 'ru',
    targetLocale: 'en',
    dna: {
      abbreviationLogic: {
        'проект': { longForm: 'project', shortForm: 'proj' },
        // ...
      },
      validationHints: {
        rules: [
          {
            term: 'проект',
            context: 'technical',
            rule: 'Always use "project" not "projekt"',
            example: 'проект → project'
          }
        ],
        warnings: [
          {
            term: 'энергоэффективность',
            message: 'Check spelling: "energy efficiency" not "energoefficiency"'
          }
        ]
      }
    }
  }
);

// review содержит:
// - errors: массив ошибок с типом, severity, message
// - warnings: массив предупреждений
// - score: оценка 0-100
// - reasoning: объяснение оценки
```

## Интерфейсы

### CriticReview

```typescript
interface CriticReview {
  errors: CriticError[];
  warnings: CriticWarning[];
  score: number; // 0-100
  reasoning: string;
  modelUsed: string;
  usage?: ProviderUsage;
}
```

### CriticError

```typescript
interface CriticError {
  type: 'glossary' | 'style' | 'formatting' | 'omission' | 'unit' | 'other';
  term?: string;        // Термин из source
  expected?: string;    // Ожидаемый термин
  found?: string;       // Найденный термин
  context?: string;     // Контекст ошибки
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  suggestion?: string;  // Предложение по исправлению
}
```

## Интеграция с TranslationOrchestrator

Типичный workflow:

```typescript
// 1. Перевести через TranslationOrchestrator
const translationOrchestrator = new TranslationOrchestrator();
const result = await translationOrchestrator.translateBatch(segments, options);
const translatedText = result.segments[0].target;

// 2. Проверить через LlmCriticService
const criticService = new LlmCriticService();
const review = await criticService.review(
  sourceText,
  translatedText,
  {
    ...options,
    dna: {
      abbreviationLogic: documentDna.abbreviationLogic,
      validationHints: documentDna.validationHints,
    }
  }
);

// 3. Обработать результаты
if (review.errors.length > 0) {
  // Есть ошибки - можно исправить или пометить для ревью
  const criticalErrors = review.errors.filter(e => 
    e.severity === 'critical' || e.severity === 'high'
  );
  // ...
}
```

## Системный промпт

Критик использует детальный системный промпт, который включает:

1. **DNA Glossary Section**: Все термины из `abbreviationLogic` с их переводами
2. **Style Rules Section**: Правила из `validationHints.rules` и `validationHints.warnings`
3. **Common Error Patterns**: Типичные ошибки (пропуски цифр, неверные единицы, форматирование)
4. **Output Format**: Строгий JSON формат для структурированного ответа

## Модель-агностичность

Сервис автоматически:
- Использует Registry для получения провайдера
- Переключает Gemini Flash модели на более стабильные для критики
- Поддерживает все провайдеры: Gemini, OpenAI, Yandex, DeepSeek, Claude

## Оценка качества

Score рассчитывается на основе:
- **100**: Идеальный перевод, нет ошибок
- **90-99**: Отличный перевод, только предупреждения
- **70-89**: Хороший перевод, есть незначительные ошибки
- **50-69**: Приемлемый перевод, есть ошибки средней тяжести
- **0-49**: Плохой перевод, много критических ошибок

## Примеры ошибок

### Glossary Error
```json
{
  "type": "glossary",
  "term": "проект",
  "expected": "project",
  "found": "projekt",
  "severity": "critical",
  "message": "Glossary requires 'project' but found 'projekt'"
}
```

### Style Error
```json
{
  "type": "style",
  "term": "энергоэффективность",
  "expected": "energy efficiency",
  "found": "energoefficiency",
  "severity": "high",
  "message": "Style rule violation: compound word should be split"
}
```

### Formatting Error
```json
{
  "type": "formatting",
  "severity": "medium",
  "message": "Missing number: source has '2025' but target is missing it"
}
```
