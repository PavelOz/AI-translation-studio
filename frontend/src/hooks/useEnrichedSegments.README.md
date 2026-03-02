# useEnrichedSegments Hook

## Обзор

Хук `useEnrichedSegments` объединяет данные из разных источников и обогащает сегменты метаданными для отображения в DashboardV2.

## Источники данных

1. **prisma.segment** (через `segmentsApi.list`)
   - Базовая информация о сегментах
   - `mtAnalysis` - строка с метаданными автокоррекции

2. **JanitorReport** (через `janitorApi.getReport`)
   - Статусы сегментов (VALIDATED, AUTO_FIXED, REQUIRES_REVIEW)
   - Комментарии Janitor

## Парсинг mtAnalysis

### Примеры строк mtAnalysis

#### 1. Автокорректированный сегмент с хорошим качеством

```
Auto-corrected: 1 attempt(s) | Quality Score: 88/100 | Errors: 0 | Warnings: 2
```

**Результат парсинга:**
```typescript
{
  autoCorrected: true,
  qualityScore: 88,
  correctionAttempts: 1,
  errors: 0,
  warnings: 2,
  requiresReview: false, // 88 >= 85
}
```

#### 2. Сегмент с низким качеством, требующий ревью

```
Quality Score: 72/100 | Errors: 1 | Warnings: 0 | Review: Translation quality below threshold
```

**Результат парсинга:**
```typescript
{
  autoCorrected: false,
  qualityScore: 72,
  errors: 1,
  warnings: 0,
  requiresReview: true, // 72 < 85
  reasoning: "Translation quality below threshold",
}
```

#### 3. Автокорректированный, но все еще требующий ревью

```
Auto-corrected but quality score 78/100 still below threshold. Requires manual review.
```

**Результат парсинга:**
```typescript
{
  autoCorrected: true,
  qualityScore: 78,
  requiresReview: true,
  reasoning: "Requires manual review.",
}
```

#### 4. Сложная строка с множеством метаданных

```
Auto-corrected: 2 attempt(s) | 
Quality Score: 85/100 | 
Errors: 0 | 
Warnings: 3 | 
Review: Translation improved after correction. Some minor style issues remain.
```

**Результат парсинга:**
```typescript
{
  autoCorrected: true,
  qualityScore: 85,
  correctionAttempts: 2,
  errors: 0,
  warnings: 3,
  requiresReview: false, // 85 >= 85
  reasoning: "Translation improved after correction. Some minor style issues remain.",
}
```

## Вычисление Document Health

### Алгоритм

1. **Средний балл качества:**
   ```typescript
   const segmentsWithScore = enrichedSegments.filter(s => s.qualityScore !== undefined);
   const avgScore = segmentsWithScore.length > 0
     ? segmentsWithScore.reduce((sum, s) => sum + (s.qualityScore || 0), 0) / segmentsWithScore.length
     : (validated / total) * 100;
   ```

2. **Статус здоровья:**
   ```typescript
   if (avgScore >= 90) status = 'excellent';
   else if (avgScore >= 75) status = 'good';
   else if (avgScore >= 60) status = 'fair';
   else status = 'poor';
   ```

### Пример вычисления

**Данные:**
- Всего сегментов: 100
- Validated: 60
- Auto-fixed: 25
- Requires Review: 15

**Сегменты с баллами:**
- Сегмент 1: 95/100
- Сегмент 2: 88/100
- Сегмент 3: 72/100
- Сегмент 4: 90/100
- Сегмент 5: 85/100

**Вычисление:**
```typescript
avgScore = (95 + 88 + 72 + 90 + 85) / 5 = 86
status = 'good' // 86 >= 75 && 86 < 90
```

**Если нет сегментов с баллами:**
```typescript
avgScore = (validated / total) * 100 = (60 / 100) * 100 = 60
status = 'fair' // 60 >= 60 && 60 < 75
```

## Status Mapper

### Приоритеты определения статуса

1. **Приоритет 1: Явный статус из Janitor**
   ```typescript
   if (janitorStatus) return janitorStatus;
   ```

2. **Приоритет 2: Статус из БД**
   ```typescript
   if (segment.status === 'REQUIRES_REVIEW') return 'REQUIRES_REVIEW';
   ```

3. **Приоритет 3: Статус на основе метаданных**
   ```typescript
   if (parsedMetadata?.requiresReview) return 'REQUIRES_REVIEW';
   ```

4. **Приоритет 4: Автокорректированный с хорошим качеством**
   ```typescript
   if (parsedMetadata?.autoCorrected && qualityScore >= 85) return 'AUTO_FIXED';
   ```

5. **Приоритет 5: Отличное качество**
   ```typescript
   if (qualityScore >= 90) return 'VALIDATED';
   ```

### Примеры маппинга

#### Пример 1: Janitor статус имеет приоритет
```typescript
segment.status = 'REQUIRES_REVIEW'
janitorStatus = 'VALIDATED'
metadata = { qualityScore: 50 }

→ Result: 'VALIDATED' (приоритет Janitor)
```

#### Пример 2: Статус из БД
```typescript
segment.status = 'REQUIRES_REVIEW'
janitorStatus = undefined
metadata = { qualityScore: 88 }

→ Result: 'REQUIRES_REVIEW' (приоритет БД)
```

#### Пример 3: Статус из метаданных
```typescript
segment.status = 'MT'
janitorStatus = undefined
metadata = { qualityScore: 72, requiresReview: true }

→ Result: 'REQUIRES_REVIEW' (приоритет метаданных)
```

#### Пример 4: Автокорректированный
```typescript
segment.status = 'MT'
janitorStatus = undefined
metadata = { autoCorrected: true, qualityScore: 88 }

→ Result: 'AUTO_FIXED' (автокорректированный с хорошим качеством)
```

#### Пример 5: Отличное качество
```typescript
segment.status = 'MT'
janitorStatus = undefined
metadata = { qualityScore: 95 }

→ Result: 'VALIDATED' (отличное качество)
```

## Использование

```typescript
const {
  segments,
  isLoading,
  error,
  documentHealth,
  statistics,
} = useEnrichedSegments({
  documentId: 'doc-123',
  enabled: true,
  page: 1,
  pageSize: 1000,
});

// segments - массив обогащенных сегментов
// documentHealth - здоровье документа
// statistics - дополнительная статистика
```

## Статистика

Хук возвращает дополнительную статистику:

```typescript
{
  totalSegments: 100,
  segmentsWithScore: 85, // Сегменты с баллом качества
  averageScore: 87.5,
  autoCorrectedCount: 25,
  correctionAttemptsTotal: 30,
  totalErrors: 5,
  totalWarnings: 15,
}
```

## Интеграция с DashboardV2

```typescript
// В DashboardV2.tsx
const {
  segments: enrichedSegments,
  isLoading: isLoadingSegments,
  documentHealth,
  statistics,
} = useEnrichedSegments({
  documentId: documentId!,
  enabled: !!documentId,
  page: 1,
  pageSize: 1000,
});

// documentHealth используется в ProjectHeader
<ProjectHeader health={documentHealth} />

// enrichedSegments используются в ActiveTranslationFeed
<ActiveTranslationFeed segments={filteredSegments} />
```

## Обработка сложных случаев

### Случай 1: Множественные форматы mtAnalysis

Парсер поддерживает различные форматы:
- `Quality Score: 88/100`
- `quality score 88/100`
- `Score: 88/100`
- `88/100` (fallback)

### Случай 2: Отсутствие данных

Если `mtAnalysis` пуст или null:
```typescript
{
  autoCorrected: false,
  requiresReview: false,
}
```

### Случай 3: Некорректные данные

Если балл вне диапазона 0-100, парсер игнорирует его и пробует следующий паттерн.

### Случай 4: Отсутствие Janitor отчета

Если Janitor отчет не загружен, статус определяется только из метаданных сегмента.
