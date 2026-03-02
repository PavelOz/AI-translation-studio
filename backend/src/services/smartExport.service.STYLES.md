# SmartExportService - Обработка стилей для сегментов

## Структура сервиса

```
smartExportDocument()
  ├── Загружает документ и сегменты
  ├── Запускает UniversalJanitor.auditSegments()
  ├── Загружает Document DNA
  ├── enrichSegmentsForExport()
  │   ├── Создает мапы статусов и комментариев
  │   ├── Проверяет аббревиатуры (validateAbbreviationsInText)
  │   └── Формирует комментарии (extractReason)
  ├── applySmartFormatting()
  │   ├── Преобразует сегменты в формат экспорта
  │   ├── Добавляет metadata.highlight и metadata.comment
  │   └── Вызывает UniversalFileService.exportDocument()
  └── Возвращает buffer, filename, statistics
```

## Обработка стилей для сегментов, требующих внимания

### 1. Status-Driven Formatting

#### VALIDATED и AUTO_FIXED сегменты

```typescript
{
  index: 0,
  targetText: "Переведенный текст",
  metadata: {
    janitorStatus: 'VALIDATED' | 'AUTO_FIXED',
    shouldHighlight: false,
    comment: undefined,
  }
}
```

**Результат в документе:**
- Обычный текст без выделения
- Без комментариев
- Стандартное форматирование

#### REQUIRES_REVIEW сегменты

```typescript
{
  index: 1,
  targetText: "Проблемный текст",
  metadata: {
    janitorStatus: 'REQUIRES_REVIEW',
    shouldHighlight: true,
    comment: "Missed term from DNA\n\nТермин 'проект' не найден...",
  }
}
```

**Результат в документе:**
- **DOCX**: Желтый фон через `<w:highlight w:val="yellow"/>`
- **XLSX**: Заливка ячейки через стиль с цветом фона
- Комментарий добавлен

### 2. DOCX Formatting (Word)

#### Выделение текста

**XML структура:**
```xml
<w:p>
  <w:r>
    <w:rPr>
      <w:highlight w:val="yellow"/>  <!-- Желтый фон -->
    </w:rPr>
    <w:t>Проблемный текст</w:t>
  </w:r>
</w:p>
```

**Реализация в DocxHandler:**
```typescript
// В replaceTextInParagraph()
if (segmentData.metadata?.highlight) {
  const run = paragraphElement.getElementsByTagName('w:r')[0];
  if (run) {
    let rPr = run.getElementsByTagName('w:rPr')[0];
    if (!rPr) {
      rPr = doc.createElement('w:rPr');
      run.insertBefore(rPr, run.firstChild);
    }
    const highlight = doc.createElement('w:highlight');
    highlight.setAttribute('w:val', metadata.highlightColor || 'yellow');
    rPr.appendChild(highlight);
  }
}
```

#### Комментарии

**XML структура:**
```xml
<!-- В word/document.xml -->
<w:commentRangeStart w:id="1"/>
<w:r>
  <w:t>Проблемный текст</w:t>
</w:r>
<w:commentRangeEnd w:id="1"/>

<!-- В word/comments.xml -->
<w:comment w:id="1" w:author="AI Translation Studio" w:date="2025-01-XX">
  <w:p>
    <w:r>
      <w:t>Missed term from DNA</w:t>
    </w:r>
  </w:p>
  <w:p>
    <w:r>
      <w:t>Термин 'проект' не найден в переводе</w:t>
    </w:r>
  </w:p>
</w:comment>
```

**Реализация:**
```typescript
// 1. Добавляем commentRangeStart и commentRangeEnd в document.xml
const commentStart = doc.createElement('w:commentRangeStart');
commentStart.setAttribute('w:id', commentId);
paragraphElement.insertBefore(commentStart, paragraphElement.firstChild);

const commentEnd = doc.createElement('w:commentRangeEnd');
commentEnd.setAttribute('w:id', commentId);
paragraphElement.appendChild(commentEnd);

// 2. Создаем/обновляем word/comments.xml
const commentsXml = await zip.file('word/comments.xml')?.async('string');
// Парсим и добавляем новый комментарий
```

### 3. XLSX Formatting (Excel)

#### Заливка ячейки

**Структура стилей:**
```xml
<!-- В xl/styles.xml -->
<cellXfs>
  <xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0"/>
</cellXfs>
<fills>
  <fill>
    <patternFill patternType="solid">
      <fgColor rgb="FFFFFF00"/>  <!-- Желтый -->
    </patternFill>
  </fill>
</fills>
```

**Применение к ячейке:**
```xml
<!-- В xl/worksheets/sheet1.xml -->
<c r="A1" s="2">  <!-- s="2" ссылается на стиль с заливкой -->
  <v>Проблемный текст</v>
</c>
```

**Реализация в XlsxHandler:**
```typescript
// 1. Создаем стиль с заливкой (если еще не создан)
const fillId = this.getOrCreateFillStyle(highlightColor);

// 2. Применяем стиль к ячейке
cell['@_s'] = fillId; // Индекс стиля в cellXfs
```

#### Комментарии (Notes)

**XML структура:**
```xml
<!-- В xl/comments1.xml -->
<comments>
  <commentList>
    <comment ref="A1" authorId="0">
      <text>
        <r>
          <rPr>
            <sz val="10"/>
            <color rgb="000000"/>
          </rPr>
          <t>Missed term from DNA</t>
        </r>
        <r>
          <t>Термин 'проект' не найден...</t>
        </r>
      </text>
    </comment>
  </commentList>
</comments>
```

**Реализация:**
```typescript
// 1. Создаем/обновляем xl/comments1.xml
const commentsXml = await zip.file('xl/comments1.xml')?.async('string');
// Парсим и добавляем комментарий

// 2. Добавляем связь в xl/worksheets/_rels/sheet1.xml.rels
// (если comments1.xml еще не связан)
```

### 4. Comment Injection Logic

#### Формирование комментария

```typescript
function extractReason(janitorComment?: string, errors?: Array<{ type: string; message: string }>): string {
  if (janitorComment) {
    // Извлекаем краткую причину
    if (janitorComment.includes('Missed term')) return 'Missed term from DNA';
    if (janitorComment.includes('Wrong term')) return 'Wrong term usage';
    if (janitorComment.includes('Script mixing')) return 'Script mixing detected';
    if (janitorComment.includes('Low quality')) return 'Low quality score';
    if (janitorComment.includes('Constraint')) return 'Constraint violation';
    return janitorComment.substring(0, 100);
  }
  
  if (errors && errors.length > 0) {
    const errorTypes = errors.map(e => e.type).join(', ');
    return `Validation errors: ${errorTypes}`;
  }
  
  return 'Requires manual review';
}
```

#### Формат комментария

```
[Причина]

[Полный janitorComment]
```

**Пример:**
```
Missed term from DNA

Термин 'проект' не найден в переводе. Ожидалось использование 'project' согласно Document DNA.
```

### 5. DNA Abbreviation Handling

#### Проверка аббревиатур

```typescript
function validateAbbreviationsInText(
  text: string,
  abbreviationLogic: DocumentDnaPayload['abbreviationLogic'],
): Array<{ term: string; found: string; expected: string }> {
  const issues = [];
  
  for (const [key, value] of Object.entries(abbreviationLogic)) {
    const longForm = value.longForm || '';
    const shortForm = value.shortForm || '';
    
    const hasShortForm = text.includes(shortForm);
    const hasLongForm = text.includes(longForm);
    
    // Если используется и короткая, и длинная форма одновременно
    if (hasShortForm && hasLongForm && shortForm !== longForm) {
      issues.push({
        term: key,
        found: `${shortForm} and ${longForm}`,
        expected: 'Use either short or long form consistently',
      });
    }
  }
  
  return issues;
}
```

#### Добавление комментария при проблемах

```typescript
if (abbreviationIssues.length > 0) {
  comment = `Abbreviation issues: ${abbreviationIssues.map(i => `${i.term} (${i.found})`).join(', ')}`;
}
```

## Интеграция с handlers

### Текущая реализация

Metadata передается в `ExportOptions`:

```typescript
{
  segments: [
    {
      index: 0,
      targetText: "Текст",
      metadata: {
        highlight: true,  // Флаг для выделения
        comment: "Комментарий...",  // Текст комментария
        highlightColor: 'yellow',  // Цвет выделения
      }
    }
  ],
  metadata: {
    smartExport: true,
    highlightColor: 'yellow',
    includeComments: true,
  }
}
```

### Расширение handlers

**ВАЖНО:** Для полной поддержки нужно обновить:

1. **DocxHandler.replaceTextInParagraph()**
   - Проверять `metadata.highlight`
   - Добавлять `<w:highlight>` в `<w:rPr>`
   - Добавлять комментарии через `<w:commentRangeStart>` и `<w:comment>`

2. **XlsxHandler.export()**
   - Проверять `metadata.highlight`
   - Создавать стиль с заливкой
   - Добавлять комментарии через `<comment>`

**Текущий статус:**
- Metadata передается корректно
- Handlers могут использовать эти данные
- Если handler не поддерживает highlight/comment, они игнорируются (без ошибок)

## Примеры обработки

### Пример 1: VALIDATED сегмент

```typescript
Input:
{
  janitorStatus: 'VALIDATED',
  shouldHighlight: false,
  comment: undefined,
}

Output в DOCX:
<w:p>
  <w:r>
    <w:t>Переведенный текст</w:t>
  </w:r>
</w:p>
```

### Пример 2: REQUIRES_REVIEW сегмент

```typescript
Input:
{
  janitorStatus: 'REQUIRES_REVIEW',
  shouldHighlight: true,
  comment: "Missed term from DNA\n\nТермин 'проект' не найден...",
}

Output в DOCX:
<w:p>
  <w:commentRangeStart w:id="1"/>
  <w:r>
    <w:rPr>
      <w:highlight w:val="yellow"/>
    </w:rPr>
    <w:t>Проблемный текст</w:t>
  </w:r>
  <w:commentRangeEnd w:id="1"/>
</w:p>
<!-- + комментарий в word/comments.xml -->
```

### Пример 3: Сегмент с проблемами аббревиатур

```typescript
Input:
{
  janitorStatus: 'VALIDATED',
  shouldHighlight: false,
  comment: "Abbreviation issues: проект (проект and про.)",
}

Output:
- Обычный текст (без выделения)
- Комментарий добавлен с предупреждением об аббревиатурах
```

## Статистика экспорта

```typescript
{
  totalSegments: 100,
  validated: 60,        // VALIDATED статус
  autoFixed: 25,        // AUTO_FIXED статус
  requiresReview: 15,   // REQUIRES_REVIEW статус
  segmentsWithComments: 15,  // Сегменты с комментариями
}
```

## Расширение в будущем

1. **Поддержка других цветов выделения**
   - Красный для критических ошибок
   - Оранжевый для предупреждений

2. **Множественные комментарии**
   - Разделение по типам ошибок
   - Иерархия комментариев

3. **Интерактивные элементы**
   - Гиперссылки на DNA термины
   - Кнопки быстрого исправления
