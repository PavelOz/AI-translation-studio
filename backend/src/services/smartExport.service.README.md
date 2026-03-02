# SmartExportService - Экспорт документов с метаданными аудита

## Обзор

SmartExportService генерирует финальный документ на основе обогащенных данных аудита, применяя форматирование и комментарии для сегментов, требующих внимания.

## Возможности

### 1. Status-Driven Formatting

**VALIDATED и AUTO_FIXED сегменты:**
- Вставляются как обычный текст без выделения
- Не требуют дополнительного форматирования

**REQUIRES_REVIEW сегменты:**
- Выделяются в документе (желтый фон в DOCX, заливка ячейки в XLSX)
- Визуально отличаются от валидированных сегментов

### 2. Comment Injection

Для всех сегментов `REQUIRES_REVIEW` добавляется комментарий:
- **DOCX**: Comment (Word Comments)
- **XLSX**: Note (Cell Notes)

**Формат комментария:**
```
[Причина]

[janitorComment]
```

**Примеры причин:**
- "Missed term from DNA"
- "Wrong term usage"
- "Script mixing detected"
- "Low quality score"
- "Constraint violation"

### 3. DNA Abbreviation Handling

Проверяет соответствие аббревиатур из `abbreviationLogic`:
- Обнаруживает одновременное использование короткой и длинной формы
- Добавляет комментарий при обнаружении проблем

### 4. UI Integration

Кнопка "Export Smart Version" в ControlPanel:
- Запускает экспорт с метаданными
- Скачивает файл с суффиксом `_DNA_REVIEWED`

## Структура сервиса

```typescript
smartExportDocument(options: SmartExportOptions): Promise<SmartExportResult>
  ├── Загружает документ и сегменты
  ├── Запускает UniversalJanitor.auditSegments()
  ├── Загружает Document DNA (если validateAbbreviations = true)
  ├── enrichSegmentsForExport() - обогащает сегменты метаданными
  ├── applySmartFormatting() - применяет форматирование и комментарии
  └── Возвращает buffer и статистику
```

## Обработка стилей для сегментов, требующих внимания

### DOCX (Word)

**Выделение текста:**
```xml
<w:r>
  <w:rPr>
    <w:highlight w:val="yellow"/>  <!-- Желтый фон -->
  </w:rPr>
  <w:t>Текст сегмента</w:t>
</w:r>
```

**Комментарий:**
```xml
<w:commentRangeStart w:id="1"/>
<w:r>
  <w:t>Текст сегмента</w:t>
</w:r>
<w:commentRangeEnd w:id="1"/>
<w:comment w:id="1" w:author="AI Translation Studio" w:date="2025-01-XX">
  <w:p>
    <w:r>
      <w:t>Missed term from DNA</w:t>
    </w:r>
  </w:p>
  <w:p>
    <w:r>
      <w:t>Detailed janitor comment...</w:t>
    </w:r>
  </w:p>
</w:comment>
```

### XLSX (Excel)

**Заливка ячейки:**
```xml
<c r="A1" s="highlightStyle">
  <v>Текст сегмента</v>
</c>
```

**Note (комментарий):**
```xml
<comment ref="A1" author="AI Translation Studio">
  <text>
    <r>
      <t>Missed term from DNA</t>
    </r>
    <r>
      <t>Detailed janitor comment...</t>
    </r>
  </text>
</comment>
```

## API Endpoint

```
GET /documents/:documentId/smart-export
```

**Query параметры:**
- `highlightColor` (string, default: 'yellow') - Цвет выделения
- `includeComments` (boolean, default: true) - Включать комментарии
- `validateAbbreviations` (boolean, default: true) - Проверять аббревиатуры

**Response:**
- Content-Type: `application/octet-stream`
- Content-Disposition: `attachment; filename="document_DNA_REVIEWED.docx"`
- Body: Buffer файла

## Использование

### Backend

```typescript
import { smartExportDocument } from './services/smartExport.service';

const result = await smartExportDocument({
  documentId: 'doc-123',
  highlightColor: 'yellow',
  includeComments: true,
  validateAbbreviations: true,
});

// result.buffer - Buffer файла
// result.filename - Имя файла с суффиксом _DNA_REVIEWED
// result.statistics - Статистика экспорта
```

### Frontend

```typescript
// В ControlPanel.tsx
const smartExportMutation = useMutation({
  mutationFn: async () => {
    const response = await apiClient.get(
      `/documents/${documentId}/smart-export`,
      {
        params: {
          highlightColor: 'yellow',
          includeComments: true,
          validateAbbreviations: true,
        },
        responseType: 'blob',
      },
    );

    const blob = response.data;
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'document_DNA_REVIEWED.docx';
    a.click();
    window.URL.revokeObjectURL(url);
  },
});
```

## Статистика экспорта

```typescript
{
  totalSegments: 100,
  validated: 60,
  autoFixed: 25,
  requiresReview: 15,
  segmentsWithComments: 15,
}
```

## Интеграция с handlers

**ВАЖНО:** Обработчики файлов (DocxHandler, XlsxHandler) должны поддерживать:
- `metadata.highlight` - флаг для выделения
- `metadata.comment` - текст комментария

**Текущая реализация:**
- Metadata передается в `ExportOptions`
- Handlers могут использовать эти данные для форматирования
- Если handler не поддерживает highlight/comment, они игнорируются

## Расширение handlers

Для полной поддержки форматирования нужно обновить:

1. **DocxHandler.replaceTextInParagraph()**
   - Проверять `metadata.highlight`
   - Добавлять `<w:highlight w:val="yellow"/>` в `<w:rPr>`
   - Добавлять комментарии через `<w:commentRangeStart>` и `<w:comment>`

2. **XlsxHandler.export()**
   - Проверять `metadata.highlight`
   - Создавать стиль с заливкой ячейки
   - Добавлять комментарии через `<comment>`

## Примеры

### Пример 1: Сегмент VALIDATED

```typescript
{
  index: 0,
  targetText: "Переведенный текст",
  metadata: {
    janitorStatus: 'VALIDATED',
    shouldHighlight: false,
    comment: undefined,
  }
}
```

**Результат:** Обычный текст без выделения и комментариев

### Пример 2: Сегмент REQUIRES_REVIEW

```typescript
{
  index: 1,
  targetText: "Проблемный текст",
  metadata: {
    janitorStatus: 'REQUIRES_REVIEW',
    shouldHighlight: true,
    comment: "Missed term from DNA\n\nТермин 'проект' не найден в переводе",
  }
}
```

**Результат:** 
- Текст выделен желтым фоном
- Добавлен комментарий с причиной и деталями

### Пример 3: Сегмент с проблемами аббревиатур

```typescript
{
  index: 2,
  targetText: "Используется проект и про.",
  metadata: {
    janitorStatus: 'VALIDATED',
    shouldHighlight: false,
    comment: "Abbreviation issues: проект (проект and про.)",
  }
}
```

**Результат:** Добавлен комментарий о проблемах с аббревиатурами
