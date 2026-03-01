# JanitorReviewScreen

Экран просмотра результатов UniversalJanitor с концепцией Human-in-the-loop.

## Описание

Компонент предоставляет интерфейс для:
- Просмотра результатов аудита сегментов
- Фильтрации и поиска сегментов по статусу
- Просмотра DNA глоссария в боковой панели
- Подтверждения исправлений (Approve)
- Ручного редактирования сегментов (Edit)

## Дизайн

**Стиль:** Data Science Dashboard
- Чистый, информативный интерфейс
- Минимум визуального шума
- Максимум информативности
- Светлая тема с акцентами

## Компоненты

### Status Header Cards
Карточки со статистикой:
- **Total Segments** - общее количество сегментов
- **Requires Review** - сегменты, требующие проверки
- **Auto-fixed** - автоматически исправленные
- **Validated** - проверенные и валидные

### Segment List
Список сегментов с:
- Подсветкой статуса (цветной фон)
- Отображением оригинального и исправленного текста
- Комментариями Janitor (janitorComment)
- Списком ошибок валидации
- Кнопками действий (Approve, Edit)

### DNA Inspector Panel
Боковая панель с:
- Глоссарием документа (abbreviationLogic)
- Правилами валидации (validationHints.rules)
- Статистикой использования DNA
- Возможностью сворачивания

### HITL Actions
- **Approve** - подтверждение исправлений
- **Edit** - ручное редактирование текста
- **Bulk Approve** - массовое подтверждение

## Использование

### Базовое использование

```tsx
import JanitorReviewScreen from './components/JanitorReviewScreen';

function App() {
  return <JanitorReviewScreen documentId="document-id" />;
}
```

### В роутере

```tsx
import { Route } from 'react-router-dom';
import JanitorReviewScreen from './components/JanitorReviewScreen';

<Route path="/documents/:documentId/janitor" element={<JanitorReviewScreen />} />
```

## API Endpoints

Компонент использует следующие API:

- `POST /documents/:documentId/janitor/audit` - запуск аудита
- `GET /documents/:documentId/janitor/report` - получение отчета
- `POST /segments/:segmentId/janitor/approve` - подтверждение сегмента
- `POST /segments/janitor/bulk-approve` - массовое подтверждение

## Фильтрация

- **По статусу:** ALL, VALIDATED, AUTO_FIXED, REQUIRES_REVIEW
- **Поиск:** по тексту сегмента, комментариям, ошибкам

## Пример структуры данных

```typescript
interface JanitorReport {
  documentId: string;
  documentName: string;
  direction: string;
  statistics: {
    totalSegments: number;
    validated: number;
    autoFixed: number;
    requiresReview: number;
    totalErrors: number;
    errorsByType: {
      MISSED_TERM: number;
      WRONG_TERM: number;
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
    janitorComment?: string;
  }>;
}
```

## Визуальные состояния

### VALIDATED
- Фон: `bg-green-50`
- Бордер: `border-green-200`
- Бейдж: зеленый

### AUTO_FIXED
- Фон: `bg-amber-50`
- Бордер: `border-amber-200`
- Бейдж: янтарный

### REQUIRES_REVIEW
- Фон: `bg-red-50`
- Бордер: `border-red-200`
- Бейдж: красный
- Показываются кнопки Approve и Edit

## Интеграция с роутингом

Добавьте роут в `App.tsx` или `router.tsx`:

```tsx
import { Route } from 'react-router-dom';
import JanitorReviewScreen from './components/JanitorReviewScreen';

<Route 
  path="/documents/:documentId/janitor" 
  element={<JanitorReviewScreen />} 
/>
```

## Зависимости

- `react-query` - для data fetching
- `react-router-dom` - для роутинга
- `react-hot-toast` - для уведомлений
- Tailwind CSS - для стилизации
