# Self-Correction Loop в TranslationOrchestrator

## Описание

Self-Correction Loop - это механизм автоматического улучшения качества переводов через обратную связь от `LlmCriticService`. После первоначального перевода каждый сегмент проверяется критиком, и если качество ниже порога - выполняется одна попытка исправления.

## Логика работы

### 1. Первоначальный перевод

```typescript
const translationResult = await translationOrchestrator.translateAll(segments, {
  // ... options
  autoCorrect: true,        // Включить автокоррекцию
  minQualityScore: 85,     // Минимальный порог качества (0-100)
});
```

### 2. Проверка качества через LlmCriticService

После перевода каждого сегмента:

```typescript
const criticReview = await criticService.review(
  sourceText,
  translatedText,
  {
    provider: 'gemini',
    dna: {
      abbreviationLogic: relevantDna.abbreviationLogic,
      validationHints: relevantDna.validationHints,
    }
  }
);
```

### 3. Условия для исправления

Исправление выполняется если:
- `criticReview.score < minQualityScore` (по умолчанию 85)
- ИЛИ есть критические ошибки (`severity === 'critical' || 'high'`)

### 4. Попытка исправления

Если качество низкое, формируется специальный промпт:

```
Your previous translation was reviewed and found to have quality issues.

=== ORIGINAL SOURCE TEXT ===
"..."

=== YOUR PREVIOUS TRANSLATION ===
"..."

=== QUALITY SCORE ===
Score: 72/100
Reasoning: Found 3 glossary violations

=== ERRORS FOUND ===
- Glossary violation: term "проект" expected "project", found "projekt"
- Style error: compound word should be split
...

=== YOUR TASK ===
Translate the source text again, but this time:
1. Fix ALL the errors listed above
2. Address the warnings if possible
3. Ensure you use the correct glossary terms from DNA
4. Follow all style rules from validation hints
5. Maintain the same meaning and tone
```

### 5. Повторная проверка

После исправления перевод снова проверяется критиком:

```typescript
const secondReview = await criticService.review(
  sourceText,
  correctedText,
  { ... }
);
```

### 6. Финальный статус

- Если `secondReview.score >= minQualityScore` и нет критических ошибок → **MT** (Machine Translation)
- Если `secondReview.score < minQualityScore` или есть критические ошибки → **REQUIRES_REVIEW**

## Метаданные

Каждый сегмент получает метаданные:

```typescript
interface TranslatedSegment {
  id: string;
  target: string;
  autoCorrected?: boolean;           // Был ли сегмент исправлен
  correctionAttempts?: number;        // Количество попыток (0 или 1)
  finalCriticScore?: number;          // Финальный балл качества (0-100)
  requiresReview?: boolean;           // Требуется ли ревью Janitor'ом
  criticReview?: {
    errors: number;
    warnings: number;
    reasoning?: string;
  };
}
```

## Сохранение в БД

Метаданные сохраняются в сегментах:

```typescript
await prisma.segment.update({
  where: { id: segmentId },
  data: {
    targetMt: correctedText,
    status: requiresReview ? 'REQUIRES_REVIEW' : 'MT',
    mtAnalysis: `Auto-corrected: 1 attempt(s) | Quality Score: 88/100 | ...`,
    janitorComment: requiresReview 
      ? `Auto-corrected but quality score ${finalScore}/100 still below threshold. Requires manual review.`
      : undefined,
  },
});
```

## Пример использования

```typescript
// В pretranslateDocument
const translationOrchestrator = new TranslationOrchestrator();
const result = await translationOrchestrator.translateAll(segments, {
  provider: 'gemini',
  model: 'gemini-2.5-pro',
  autoCorrect: true,           // ✅ Включить автокоррекцию
  minQualityScore: 85,         // Порог качества
  dna: documentDna,            // DNA для проверки
  sourceLocale: 'ru',
  targetLocale: 'en',
});

// Результаты содержат метаданные
result.results.forEach(segment => {
  if (segment.autoCorrected) {
    console.log(`Segment ${segment.id} was auto-corrected`);
    console.log(`Initial score: unknown, Final score: ${segment.finalCriticScore}`);
  }
  
  if (segment.requiresReview) {
    console.log(`Segment ${segment.id} requires manual review`);
  }
});
```

## Логирование

Self-Correction Loop логирует:

```
[INFO] Starting self-correction loop: segmentsCount=10, minQualityScore=85
[INFO] Translation quality below threshold, attempting correction: segmentId=seg_123, initialScore=72, errors=3
[INFO] Translation improved after correction: segmentId=seg_123, initialScore=72, finalScore=88
[WARN] Translation still requires review after correction: segmentId=seg_456, finalScore=78, errors=2
[INFO] Self-correction loop completed: totalSegments=10, corrected=3, requiresReview=1
```

## Интеграция с Janitor

Сегменты со статусом `REQUIRES_REVIEW` автоматически попадают в Janitor для финальной проверки:

```typescript
// UniversalJanitor автоматически находит сегменты со статусом REQUIRES_REVIEW
const janitorReport = await universalJanitor.auditSegments(documentId, {
  autoFix: false,
  strictMode: true,
});
```

## Настройка

Параметры автокоррекции:

- `autoCorrect: boolean` - включить/выключить автокоррекцию (по умолчанию `false`)
- `minQualityScore: number` - минимальный порог качества 0-100 (по умолчанию `85`)

Рекомендации:
- Для строгих требований: `minQualityScore: 90`
- Для обычных проектов: `minQualityScore: 85`
- Для быстрого перевода: `autoCorrect: false`
