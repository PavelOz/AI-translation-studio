# DashboardV2 - Новый интерфейс управления переводом

## Обзор

DashboardV2 - это современный интерфейс для управления процессом перевода с интеграцией Document DNA, Self-Correction Loop и Universal Janitor.

## Структура компонентов

```
DashboardV2.tsx (главный компонент)
├── ProjectHeader.tsx          # Заголовок с названием, тегами и статус-баром здоровья
├── ControlPanel.tsx           # Панель управления с кнопкой Run Full Cycle
├── ActiveTranslationFeed.tsx  # Поток сегментов с индикаторами статусов
└── DnaSidebar.tsx            # Интерактивная панель с abbreviationLogic
```

## Компоненты

### 1. ProjectHeader

**Расположение:** Верхняя панель

**Функции:**
- Отображает название документа
- Показывает теги документа (tags)
- Статус-бар "Document Health" на основе баллов критика
- Статистика: Validated, Auto-fixed, Requires Review, Total

**Данные:**
- `document`: Document из API
- `health`: Вычисляется из enrichedSegments
  ```typescript
  {
    score: number;        // Средний балл качества (0-100)
    status: 'excellent' | 'good' | 'fair' | 'poor';
    validated: number;
    autoFixed: number;
    requiresReview: number;
    total: number;
  }
  ```

### 2. DnaSidebar

**Расположение:** Правая боковая панель (фиксированная, 320px)

**Функции:**
- Отображает abbreviationLogic из Document DNA
- Поиск по терминам
- Интерактивность: клик на термин → подсветка в сегментах
- Показывает longForm, shortForm, aliases для каждого термина

**Интерактивность:**
```typescript
// При клике на термин
onTermSelect(term: string | null)

// В ActiveTranslationFeed термины подсвечиваются
highlightTerm(text: string, term: string | null)
// → Возвращает JSX с <mark> для найденных терминов
```

### 3. ActiveTranslationFeed

**Расположение:** Основная область (центр)

**Функции:**
- Поток сегментов с индикаторами статусов
- Фильтрация по статусам (ALL, VALIDATED, AUTO_FIXED, REQUIRES_REVIEW)
- Подсветка выбранного термина из DnaSidebar
- Отображение метаданных автокоррекции

**Индикаторы статусов:**

1. **VALIDATED** (зеленый):
   ```tsx
   <CheckCircle2 className="w-5 h-5 text-green-600" />
   <span>Validated</span>
   ```
   - Фон: `bg-green-50 border-green-200`

2. **AUTO_FIXED** (синий):
   ```tsx
   <Wand2 className="w-5 h-5 text-blue-600" />
   <span>Auto-fixed</span>
   ```
   - Фон: `bg-blue-50 border-blue-200`
   - Бейдж: "Auto-corrected"

3. **REQUIRES_REVIEW** (красный):
   ```tsx
   <AlertCircle className="w-5 h-5 text-red-600" />
   <span>Requires Review</span>
   ```
   - Фон: `bg-red-50 border-red-200`
   - Показывает `janitorComment` или `mtAnalysis`

**Метаданные автокоррекции:**

Сегменты обогащаются данными из:
- `segment.mtAnalysis` - анализ от критика (парсится для извлечения метаданных)
- `janitorReport.segments` - данные от Universal Janitor

```typescript
interface EnrichedSegment extends Segment {
  janitorStatus?: JanitorStatus;      // VALIDATED | AUTO_FIXED | REQUIRES_REVIEW
  janitorComment?: string;            // Комментарий от Janitor
  autoCorrected?: boolean;            // Был ли сегмент автокорректирован
  qualityScore?: number;              // Балл качества (0-100)
  requiresReview?: boolean;           // Требуется ли ревью
}
```

**Извлечение метаданных из mtAnalysis:**

```typescript
const mtAnalysis = segment.mtAnalysis || '';
const autoCorrected = mtAnalysis.includes('Auto-corrected');
const qualityScoreMatch = mtAnalysis.match(/Quality Score: (\d+)\/100/);
const qualityScore = qualityScoreMatch ? parseInt(qualityScoreMatch[1]) : undefined;
```

### 4. ControlPanel

**Расположение:** Под ProjectHeader

**Функции:**
- Кнопка "Run Full Cycle" (Synthesis + Translation + Audit)
- Выбор моделей для каждой стадии:
  - Synthesis: DeepSeek Reasoner / Gemini 2.5 Pro / GPT-4
  - Translation: Gemini 2.5 Pro / GPT-4 / DeepSeek Chat
  - Audit: Gemini 2.5 Pro / GPT-4

**Workflow Run Full Cycle:**

```typescript
1. DNA Synthesis
   → documentsApi.analyze(documentId, {
       glossaryMode: 'deep',
       provider: synthesisModel.provider,
       model: synthesisModel.model,
       tags: [],
     })

2. Mass Translation
   → documentsApi.pretranslate(documentId, {
       applyAiToEmptyOnly: false,
       rewriteNonConfirmed: true,
       provider: translationModel.provider,
       model: translationModel.model,
     })

3. Universal Audit
   → janitorApi.auditSegments(documentId, {
       autoFix: true,
       strictMode: true,
       dryRun: false,
     })
```

## Связь метаданных автокоррекции с визуальными элементами

### 1. Статус сегмента

Статус определяется из:
- `segment.status` (из БД: 'REQUIRES_REVIEW')
- `janitorReport.segments[].status` (VALIDATED | AUTO_FIXED | REQUIRES_REVIEW)

```typescript
const janitorStatus = segmentStatusMap.get(segment.id);
const status = janitorStatus || (segment.requiresReview ? 'REQUIRES_REVIEW' : undefined);
```

### 2. Индикатор автокоррекции

```tsx
{segment.autoCorrected && (
  <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded">
    Auto-corrected
  </span>
)}
```

### 3. Балл качества

```tsx
{segment.qualityScore !== undefined && (
  <span className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded">
    Score: {segment.qualityScore}/100
  </span>
)}
```

### 4. Комментарий Janitor/Critic

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

### 5. Цветовая схема

```typescript
const getSegmentBgColor = (segment: EnrichedSegment) => {
  const status = segment.janitorStatus || (segment.requiresReview ? 'REQUIRES_REVIEW' : undefined);
  
  switch (status) {
    case 'VALIDATED': return 'bg-green-50 border-green-200';
    case 'AUTO_FIXED': return 'bg-blue-50 border-blue-200';
    case 'REQUIRES_REVIEW': return 'bg-red-50 border-red-200';
    default: return 'bg-white border-gray-200';
  }
};
```

## Интерактивность DnaSidebar → ActiveTranslationFeed

### Подсветка терминов

1. Пользователь кликает на термин в DnaSidebar
2. `selectedTerm` обновляется в DashboardV2
3. `selectedTerm` передается в ActiveTranslationFeed
4. В каждом сегменте вызывается `highlightTerm(sourceText, selectedTerm)`
5. Найденные термины оборачиваются в `<mark className="bg-yellow-200">`

### Визуальная обратная связь

```tsx
<div
  className={`border rounded-lg p-4 ${
    selectedTerm && segment.sourceText.toLowerCase().includes(selectedTerm.toLowerCase())
      ? 'ring-2 ring-yellow-400 shadow-lg'  // Подсветка карточки
      : ''
  }`}
>
  {/* Сегмент */}
</div>
```

## Маршрут

```tsx
<Route
  path="/documents/:documentId/dashboard-v2"
  element={
    <PrivateRoute>
      <DashboardV2 />
    </PrivateRoute>
  }
/>
```

## Использование

1. Перейти на `/documents/{documentId}/dashboard-v2`
2. Увидеть общее здоровье документа в ProjectHeader
3. Открыть DnaSidebar для просмотра glossary
4. Кликнуть на термин → увидеть подсветку в сегментах
5. Фильтровать сегменты по статусам
6. Запустить Full Cycle через ControlPanel

## Интеграция с Backend V2

DashboardV2 использует:
- `DnaSynthesisService` (через `documentsApi.analyze`)
- `TranslationOrchestrator` (через `documentsApi.pretranslate` с `autoCorrect: true`)
- `UniversalJanitor` (через `janitorApi.auditSegments`)

Все метаданные автокоррекции сохраняются в:
- `segment.mtAnalysis` - анализ от критика
- `segment.janitorComment` - комментарий от Janitor
- `segment.status` - REQUIRES_REVIEW для проблемных сегментов
