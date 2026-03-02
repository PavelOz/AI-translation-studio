# DashboardV2 - Архитектура и связи компонентов

## Визуальная структура

```
┌─────────────────────────────────────────────────────────────────┐
│ ProjectHeader                                                    │
│ ┌──────────────────────┐  ┌──────────────────────────────────┐  │
│ │ Document Name        │  │ Health: 85/100  [Stats]         │  │
│ │ Tags: [KEGOC] [energy]│ │ Validated | Auto-fixed | Review │  │
│ └──────────────────────┘  └──────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ ControlPanel                                                    │
│ [Run Full Cycle] [Tags: +Add] [Synthesis: Model] [Translation] │
└─────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────┬──────────────────────┐
│ ActiveTranslationFeed                    │ DnaSidebar          │
│ ┌────────────────────────────────────┐  │ ┌─────────────────┐ │
│ │ [Filter: All|Validated|Auto|Review] │  │ │ DNA Glossary    │ │
│ ├────────────────────────────────────┤  │ │ [Search...]     │ │
│ │ #1 ✅ Validated                     │  │ ├─────────────────┤ │
│ │ Source: "..."                       │  │ │ проект          │ │
│ │ Target: "..."                       │  │ │ Long: project   │ │
│ │                                     │  │ │ Short: proj     │ │
│ │ #2 🪄 Auto-fixed                    │  │ │                 │ │
│ │ Source: "..."                       │  │ │ энергоэффективн │ │
│ │ Target: "..."                       │  │ │ ...             │ │
│ │ [Auto-corrected] Score: 88/100      │  │ └─────────────────┘ │
│ │                                     │  │                     │
│ │ #3 ⚠️ Requires Review               │  │                     │
│ │ Source: "..."                       │  │                     │
│ │ Target: "..."                       │  │                     │
│ │ Notes: "Quality score 72/100..."    │  │                     │
│ └────────────────────────────────────┘  │                     │
└──────────────────────────────────────────┴──────────────────────┘
```

## Поток данных

### 1. Загрузка данных

```typescript
// DashboardV2.tsx
const { data: document } = useQuery(['documents', documentId], ...);
const { data: segmentsData } = useQuery(['segments', documentId], ...);
const { data: janitorReport } = useQuery(['janitor-report', documentId], ...);
const { data: dna } = useQuery(['document-dna', documentId], ...);
```

### 2. Обогащение сегментов метаданными

```typescript
// Объединение данных из разных источников
const enrichedSegments = segments.map(segment => {
  // Статус из Janitor
  const janitorStatus = segmentStatusMap.get(segment.id);
  
  // Метаданные автокоррекции из mtAnalysis
  const autoCorrected = mtAnalysis.includes('Auto-corrected');
  const qualityScore = extractScore(mtAnalysis);
  
  return {
    ...segment,
    janitorStatus,
    autoCorrected,
    qualityScore,
    requiresReview: segment.status === 'REQUIRES_REVIEW',
  };
});
```

### 3. Интерактивность DnaSidebar → ActiveTranslationFeed

```typescript
// DnaSidebar: клик на термин
onTermSelect('проект') 
  → setSelectedTerm('проект')
  → передается в ActiveTranslationFeed

// ActiveTranslationFeed: подсветка
highlightTerm(segment.sourceText, 'проект')
  → возвращает JSX с <mark> для найденных терминов
  → карточка сегмента получает ring-2 ring-yellow-400
```

## Связь метаданных автокоррекции с визуальными элементами

### Метаданные в БД

```typescript
// segment.mtAnalysis содержит:
"Auto-corrected: 1 attempt(s) | Quality Score: 88/100 | Errors: 0 | Warnings: 2 | Review: Translation improved after correction"

// segment.janitorComment содержит:
"Auto-corrected but quality score 78/100 still below threshold. Requires manual review."

// segment.status:
'REQUIRES_REVIEW' // Если качество все еще низкое после исправления
```

### Визуальное отображение

#### 1. Индикатор статуса

```tsx
// VALIDATED
<div className="flex items-center gap-2 text-green-600">
  <CheckCircle2 className="w-5 h-5" />
  <span>Validated</span>
</div>
<div className="bg-green-50 border-green-200">...</div>

// AUTO_FIXED
<div className="flex items-center gap-2 text-blue-600">
  <Wand2 className="w-5 h-5" />
  <span>Auto-fixed</span>
</div>
<div className="bg-blue-50 border-blue-200">...</div>

// REQUIRES_REVIEW
<div className="flex items-center gap-2 text-red-600">
  <AlertCircle className="w-5 h-5" />
  <span>Requires Review</span>
</div>
<div className="bg-red-50 border-red-200">...</div>
```

#### 2. Бейдж автокоррекции

```tsx
{segment.autoCorrected && (
  <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded">
    Auto-corrected
  </span>
)}
```

#### 3. Балл качества

```tsx
{segment.qualityScore !== undefined && (
  <span className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded">
    Score: {segment.qualityScore}/100
  </span>
)}
```

#### 4. Комментарий Janitor/Critic

```tsx
{(segment.janitorComment || segment.mtAnalysis) && (
  <div className="mt-3 pt-3 border-t border-gray-200">
    <div className="text-xs font-medium text-gray-500 mb-1">Notes</div>
    <div className="text-sm text-gray-700">
      {segment.janitorComment || segment.mtAnalysis}
    </div>
  </div>
)}
```

## Workflow Run Full Cycle

### Шаг 1: DNA Synthesis

```typescript
await documentsApi.analyze(documentId, {
  glossaryMode: 'deep',
  provider: 'deepseek',
  model: 'deepseek-reasoner',
  tags: ['KEGOC', 'energy'], // Используются для Master DNA resolution
});
```

**Результат:**
- Document DNA синтезируется с учетом Master DNA по тегам
- Сохраняется в БД в `DocumentDna`
- `abbreviationLogic` и `validationHints` доступны для следующих стадий

### Шаг 2: Mass Translation

```typescript
await documentsApi.pretranslate(documentId, {
  applyAiToEmptyOnly: false,
  rewriteNonConfirmed: true,
  provider: 'gemini',
  model: 'gemini-2.5-pro',
});
```

**Внутри (через TranslationOrchestrator):**
- `autoCorrect: true` → Self-Correction Loop включен
- Каждый сегмент переводится
- Проверяется через `LlmCriticService`
- Если `score < 85` → выполняется исправление
- Метаданные сохраняются в `segment.mtAnalysis`

**Результат:**
- Сегменты переведены
- Автокорректированные сегменты помечены
- `segment.mtAnalysis` содержит метаданные

### Шаг 3: Universal Audit

```typescript
await janitorApi.auditSegments(documentId, {
  autoFix: true,
  strictMode: true,
  dryRun: false,
});
```

**Результат:**
- Все сегменты проверены через Universal Janitor
- Статусы: VALIDATED, AUTO_FIXED, REQUIRES_REVIEW
- Проблемные сегменты помечены `status: 'REQUIRES_REVIEW'`
- `janitorComment` содержит детали ошибок

## Интеграция с Backend V2

### DNA Synthesis → Translation → Audit

```
┌─────────────────┐
│ DnaSynthesis    │ → Document DNA (abbreviationLogic, validationHints)
└─────────────────┘
         ↓
┌─────────────────┐
│ Translation     │ → TranslationOrchestrator.translateAll()
│ Orchestrator    │   → autoCorrect: true
│                 │   → Self-Correction Loop
│                 │   → LlmCriticService.review()
│                 │   → Метаданные в mtAnalysis
└─────────────────┘
         ↓
┌─────────────────┐
│ Universal       │ → UniversalJanitor.auditSegments()
│ Janitor         │   → Статусы: VALIDATED | AUTO_FIXED | REQUIRES_REVIEW
│                 │   → janitorComment для проблемных сегментов
└─────────────────┘
```

## Примеры использования

### Пример 1: Просмотр автокорректированных сегментов

1. Открыть DashboardV2
2. В фильтре выбрать "Auto Fixed"
3. Увидеть все сегменты, которые были автоматически исправлены
4. Каждый сегмент показывает:
   - Бейдж "Auto-corrected"
   - Балл качества (например, "Score: 88/100")
   - Комментарий с деталями исправления

### Пример 2: Поиск термина в сегментах

1. Открыть DnaSidebar
2. Найти термин "проект"
3. Кликнуть на него
4. В ActiveTranslationFeed все сегменты с этим термином подсвечиваются:
   - Термин в sourceText обернут в `<mark>`
   - Карточка сегмента получает `ring-2 ring-yellow-400`

### Пример 3: Запуск Full Cycle

1. В ControlPanel добавить теги: "KEGOC", "energy"
2. Выбрать модели для каждой стадии
3. Нажать "Run Full Cycle"
4. Наблюдать прогресс через toast-уведомления
5. После завершения:
   - Сегменты обновляются с метаданными
   - Статусы обновляются
   - Document Health пересчитывается

## Технические детали

### Извлечение метаданных из mtAnalysis

```typescript
const mtAnalysis = segment.mtAnalysis || '';
const autoCorrected = mtAnalysis.includes('Auto-corrected');
const qualityScoreMatch = mtAnalysis.match(/Quality Score: (\d+)\/100/);
const qualityScore = qualityScoreMatch ? parseInt(qualityScoreMatch[1]) : undefined;
```

### Вычисление Document Health

```typescript
const avgScore = segmentsWithScore.length > 0
  ? segmentsWithScore.reduce((sum, s) => sum + (s.qualityScore || 0), 0) / segmentsWithScore.length
  : (validated / total) * 100;

let status: 'excellent' | 'good' | 'fair' | 'poor';
if (avgScore >= 90) status = 'excellent';
else if (avgScore >= 75) status = 'good';
else if (avgScore >= 60) status = 'fair';
else status = 'poor';
```

### Подсветка терминов

```typescript
const highlightTerm = (text: string, term: string | null) => {
  if (!term || !text) return text;
  
  const regex = new RegExp(`(${term})`, 'gi');
  const parts = text.split(regex);
  
  return parts.map((part, idx) => {
    if (part.toLowerCase() === term.toLowerCase()) {
      return (
        <mark key={idx} className="bg-yellow-200 px-1 rounded">
          {part}
        </mark>
      );
    }
    return part;
  });
};
```

## Маршрут

```
/documents/:documentId/dashboard-v2
```

## Стилизация

Все компоненты используют:
- **Tailwind CSS** для стилизации
- **Lucide React** для иконок
- **React Query** для управления состоянием
- **React Router** для навигации

Цветовая схема:
- **VALIDATED**: зеленый (`green-50`, `green-600`)
- **AUTO_FIXED**: синий (`blue-50`, `blue-600`)
- **REQUIRES_REVIEW**: красный (`red-50`, `red-600`)
- **Подсветка терминов**: желтый (`yellow-200`, `yellow-400`)
