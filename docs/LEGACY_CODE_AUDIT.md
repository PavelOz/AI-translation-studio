# Аудит Legacy-кода для перехода на Digital DNA Architecture

**Дата:** 2025-02-XX  
**Версия:** 1.0  
**Статус:** Draft

---

## Исполнительное резюме

Проведен аудит кодовой базы для выявления legacy-компонентов, которые должны быть удалены или заменены при окончательном переходе на архитектуру **Digital DNA**. Выявлено **5 основных категорий legacy-кода** с детальным анализом каждого компонента.

---

## 1. Категории Legacy-кода

### 1.1. Валидация и Quality Control

#### 🔴 **КРИТИЧНО: validatorJanitor.ts → universalJanitor.ts**

**Старый компонент:**
- `backend/src/services/validatorJanitor.ts` (303 строки)
- `backend/src/scripts/validator-janitor.ts`
- API: `POST /documents/:documentId/validator-janitor`

**Новый компонент:**
- `backend/src/services/universalJanitor.ts` (748 строк)
- API: `POST /documents/:documentId/janitor/audit`

**Использование:**
- ✅ Используется в `QualityControlPage.tsx`
- ✅ Используется в `AdminQualityControlPage.tsx`
- ✅ Используется в `documents.routes.ts` (строка 265)
- ✅ Используется в `documents.api.ts` (типы `ValidatorJanitorReport`)

**Критерии отбора:**
- ❌ **УДАЛИТЬ** `validatorJanitor.ts` после миграции всех вызовов на `universalJanitor`
- ❌ **УДАЛИТЬ** API endpoint `/validator-janitor`
- ❌ **ЗАМЕНИТЬ** типы `ValidatorJanitorReport` на `JanitorReport` из `universalJanitor`
- ⚠️ **МИГРИРОВАТЬ** `QualityControlPage.tsx` на использование `janitorApi` вместо `runValidatorJanitor`

**Приоритет:** 🔴 **ВЫСОКИЙ** - дублирование функциональности

---

### 1.2. Оркестрация переводов

#### 🟡 **СРЕДНИЙ: AIOrchestrator → TranslationOrchestrator**

**Старый компонент:**
- `backend/src/ai/orchestrator.ts` (2460 строк)
- Класс `AIOrchestrator`
- Используется в: `ai.service.ts`, `documentAnalyzer.ts`

**Новый компонент:**
- `backend/src/ai/translationOrchestrator.ts` (634 строки)
- Класс `TranslationOrchestrator`
- Используется в: `fullCycleTest.ts` (только в тестах)

**Использование:**
- ✅ `AIOrchestrator` активно используется в `ai.service.ts`:
  - `runDocumentMachineTranslation()`
  - `pretranslateDocument()`
  - `patchTranslate()`
- ❌ `TranslationOrchestrator` используется только в тестах

**Критерии отбора:**
- ⚠️ **ПОСТЕПЕННАЯ МИГРАЦИЯ** - `TranslationOrchestrator` более современный, но требует полной замены логики
- ⚠️ **СОХРАНИТЬ** `AIOrchestrator` до полной миграции всех вызовов
- ✅ **ПЛАН:** Мигрировать `pretranslateDocument` и `patchTranslate` на `TranslationOrchestrator`
- ❌ **УДАЛИТЬ** `AIOrchestrator` после полной миграции

**Приоритет:** 🟡 **СРЕДНИЙ** - требует аккуратной миграции

---

### 1.3. Извлечение глоссария

#### 🟡 **СРЕДНИЙ: extractGlossary → dnaSynthesis**

**Старый компонент:**
- `backend/src/services/analysis.service.ts` - функция `extractGlossary()` (строка 2474)
- API: `POST /documents/:documentId/analyze` (с параметром `glossaryMode`)
- Используется в: `runFullAnalysis()`

**Новый компонент:**
- `backend/src/services/dnaSynthesis.service.ts` (1158 строк)
- Класс `DnaSynthesisService`
- API: через `POST /documents/:documentId/analyze` (опционально)

**Использование:**
- ✅ `extractGlossary` используется в `runFullAnalysis()`
- ✅ `dnaSynthesis` используется в `fullCycleTest.ts`
- ⚠️ Оба могут работать параллельно

**Критерии отбора:**
- ⚠️ **ПОСТЕПЕННАЯ МИГРАЦИЯ** - `extractGlossary` извлекает только глоссарий, `dnaSynthesis` делает полный синтез DNA
- ✅ **СОХРАНИТЬ** `extractGlossary` как fallback для быстрого режима
- ⚠️ **РЕКОМЕНДАЦИЯ:** Использовать `dnaSynthesis` как основной метод, `extractGlossary` - только для legacy режима
- ❌ **УДАЛИТЬ** `extractGlossary` после полной миграции на `dnaSynthesis`

**Приоритет:** 🟡 **СРЕДНИЙ** - функциональность частично пересекается

---

### 1.4. UI компоненты: Глоссарий vs DNA

#### 🟢 **НИЗКИЙ: DocumentGlossary → DocumentDnaEditor**

**Старый компонент:**
- `frontend/src/components/DocumentGlossary.tsx` (130 строк)
- `frontend/src/hooks/useDocumentGlossary.ts`
- API: `GET /documents/:documentId/glossary`

**Новый компонент:**
- `frontend/src/components/DocumentDnaEditor.tsx` (389 строк)
- API: `GET /documents/:documentId/dna`

**Использование:**
- ✅ `DocumentGlossary` используется в:
  - `AnalysisSidebar.tsx` (строка ~400)
  - `SidebarTabs.tsx`
- ✅ `DocumentDnaEditor` используется в:
  - `AnalysisSidebar.tsx` (строка ~600)
  - Отдельные страницы редактирования DNA

**Критерии отбора:**
- ⚠️ **СОХРАНИТЬ ОБА** - `DocumentGlossary` показывает извлеченный глоссарий (read-only), `DocumentDnaEditor` редактирует DNA
- ✅ **РЕКОМЕНДАЦИЯ:** `DocumentGlossary` можно оставить для просмотра, но основной функционал - через `DocumentDnaEditor`
- ❌ **УДАЛИТЬ** `DocumentGlossary` только если полностью переходим на DNA-редактор

**Приоритет:** 🟢 **НИЗКИЙ** - компоненты дополняют друг друга

---

### 1.5. API Endpoints: Glossary vs DNA

#### 🟡 **СРЕДНИЙ: Glossary API → DNA API**

**Старые endpoints:**
- `GET /documents/:documentId/glossary` - список извлеченных терминов
- `PATCH /documents/:documentId/glossary/:entryId` - обновление статуса термина
- `POST /documents/:documentId/analyze` - извлечение глоссария

**Новые endpoints:**
- `GET /documents/:documentId/dna` - получение DNA
- `PUT /documents/:documentId/dna` - обновление DNA
- `POST /documents/:documentId/dna/enrich` - обогащение DNA

**Использование:**
- ✅ Старые endpoints используются в:
  - `glossary.api.ts` - `getGlossary()`, `updateDocumentGlossaryEntry()`
  - `AnalysisSidebar.tsx` - для отображения извлеченного глоссария
- ✅ Новые endpoints используются в:
  - `analysis.api.ts` - `getDocumentDna()`, `updateDocumentDna()`
  - `DocumentDnaEditor.tsx`

**Критерии отбора:**
- ⚠️ **СОХРАНИТЬ ОБА** - старые endpoints для просмотра извлеченного глоссария, новые для работы с DNA
- ✅ **РЕКОМЕНДАЦИЯ:** Старые endpoints можно оставить как read-only для обратной совместимости
- ❌ **УДАЛИТЬ** старые endpoints только после полной миграции на DNA

**Приоритет:** 🟡 **СРЕДНИЙ** - API частично пересекаются

---

## 2. Детальный анализ компонентов

### 2.1. validatorJanitor.ts

**Файл:** `backend/src/services/validatorJanitor.ts`

**Функциональность:**
- Batch verification и исправление переводов
- Проверка forbidden scripts (Cyrillic/Latin)
- Проверка legal keywords
- Identity Protection (расширение аббревиатур)
- Удаление дубликатов (brackets, spaces)

**Отличия от universalJanitor:**
- ❌ Нет концепции HITL (Human-in-the-loop)
- ❌ Нет статусов VALIDATED/AUTO_FIXED/REQUIRES_REVIEW
- ❌ Нет детальных ValidationError с типами
- ❌ Нет ValidationHints из DNA
- ✅ Более простая логика (только базовые проверки)

**Зависимости:**
- `translation.service.ts` - `runJanitorCleaner()`
- `analysis.service.ts` - `getDocumentDna()`

**План миграции:**
1. Заменить вызовы `runValidatorJanitor()` на `UniversalJanitor.auditSegments()`
2. Обновить типы в `documents.api.ts`
3. Обновить `QualityControlPage.tsx` для использования `janitorApi`
4. Удалить `validatorJanitor.ts` и связанные типы

---

### 2.2. AIOrchestrator

**Файл:** `backend/src/ai/orchestrator.ts`

**Функциональность:**
- Массовый перевод сегментов
- Управление батчами
- Фильтрация glossary по контексту
- Применение DNA (abbreviationLogic)
- Session state (expandedTerms)

**Отличия от TranslationOrchestrator:**
- ❌ Нет contextual DNA filtering (отправляет весь DNA)
- ❌ Нет динамического определения batch size по ModelCapabilities
- ❌ Нет поддержки validationHints
- ❌ Более сложная логика session state
- ✅ Более зрелый код (2460 строк vs 634)

**Зависимости:**
- `ai.service.ts` - основной сервис переводов
- `translation.service.ts` - применение DNA

**План миграции:**
1. Постепенная миграция: начать с `pretranslateDocument()`
2. Протестировать на малых документах
3. Мигрировать `patchTranslate()`
4. Удалить `AIOrchestrator` после полной миграции

---

### 2.3. extractGlossary()

**Файл:** `backend/src/services/analysis.service.ts` (строка 2474)

**Функциональность:**
- Извлечение терминов из документа
- Режимы: 'fast' (частотный анализ) и 'deep' (AI-фильтрация)
- Сохранение в `DocumentAnalysis.glossaryEntries`

**Отличия от dnaSynthesis:**
- ❌ Извлекает только глоссарий (abbreviationLogic)
- ❌ Нет поддержки Master DNA
- ❌ Нет conflict resolution
- ❌ Нет LLM-обогащения
- ❌ Нет validationHints
- ✅ Быстрее (только извлечение, без синтеза)

**Зависимости:**
- `runFullAnalysis()` - основной pipeline анализа

**План миграции:**
1. Использовать `dnaSynthesis` как основной метод
2. Оставить `extractGlossary` как fallback для быстрого режима
3. Постепенно мигрировать все вызовы на `dnaSynthesis`
4. Удалить `extractGlossary` после полной миграции

---

## 3. Критерии отбора для удаления

### 3.1. Критерии "УДАЛИТЬ НЕМЕДЛЕННО"

✅ **Применяется, если:**
- Компонент полностью заменен новым
- Новый компонент покрывает 100% функциональности
- Нет активного использования в production
- Все тесты мигрированы на новый компонент

**Примеры:**
- ❌ `validatorJanitor.ts` → после миграции на `universalJanitor`

---

### 3.2. Критерии "МИГРИРОВАТЬ ПОСТЕПЕННО"

✅ **Применяется, если:**
- Компонент активно используется
- Новый компонент не покрывает 100% функциональности
- Требуется аккуратная миграция без breaking changes
- Есть зависимости от других legacy-компонентов

**Примеры:**
- ⚠️ `AIOrchestrator` → `TranslationOrchestrator`
- ⚠️ `extractGlossary` → `dnaSynthesis`

---

### 3.3. Критерии "СОХРАНИТЬ КАК LEGACY"

✅ **Применяется, если:**
- Компонент используется для обратной совместимости
- Новый компонент решает другую задачу
- Компонент может быть полезен в будущем
- Удаление требует значительных изменений

**Примеры:**
- ✅ `DocumentGlossary` - для просмотра извлеченного глоссария
- ✅ Старые Glossary API endpoints - для обратной совместимости

---

## 4. План действий

### Фаза 1: Критичные замены (1-2 недели)

1. **validatorJanitor → universalJanitor**
   - [ ] Обновить `QualityControlPage.tsx`
   - [ ] Обновить `AdminQualityControlPage.tsx`
   - [ ] Обновить типы в `documents.api.ts`
   - [ ] Удалить `validatorJanitor.ts`
   - [ ] Удалить API endpoint `/validator-janitor`

### Фаза 2: Постепенная миграция (2-4 недели)

2. **AIOrchestrator → TranslationOrchestrator**
   - [ ] Мигрировать `pretranslateDocument()` на `TranslationOrchestrator`
   - [ ] Протестировать на малых документах
   - [ ] Мигрировать `patchTranslate()` на `TranslationOrchestrator`
   - [ ] Удалить `AIOrchestrator` после полной миграции

3. **extractGlossary → dnaSynthesis**
   - [ ] Использовать `dnaSynthesis` как основной метод в `runFullAnalysis()`
   - [ ] Оставить `extractGlossary` как fallback
   - [ ] Постепенно мигрировать все вызовы
   - [ ] Удалить `extractGlossary` после полной миграции

### Фаза 3: Очистка UI (1 неделя)

4. **UI компоненты**
   - [ ] Оценить необходимость `DocumentGlossary` vs `DocumentDnaEditor`
   - [ ] Обновить `AnalysisSidebar.tsx` для использования только DNA-компонентов
   - [ ] Удалить неиспользуемые UI компоненты

### Фаза 4: Финальная очистка (1 неделя)

5. **API endpoints**
   - [ ] Оценить необходимость старых Glossary endpoints
   - [ ] Добавить deprecation warnings
   - [ ] Удалить неиспользуемые endpoints

---

## 5. Метрики успеха

### До миграции:
- ❌ 2 системы валидации (validatorJanitor + universalJanitor)
- ❌ 2 системы оркестрации (AIOrchestrator + TranslationOrchestrator)
- ❌ 2 системы извлечения (extractGlossary + dnaSynthesis)
- ❌ Дублирование UI компонентов

### После миграции:
- ✅ 1 система валидации (universalJanitor)
- ✅ 1 система оркестрации (TranslationOrchestrator)
- ✅ 1 система синтеза (dnaSynthesis)
- ✅ Единый UI для работы с DNA

---

## 6. Риски и митигация

### Риск 1: Breaking changes при миграции
**Митигация:** Постепенная миграция с сохранением старых компонентов до полного перехода

### Риск 2: Потеря функциональности
**Митигация:** Детальное тестирование перед удалением legacy-кода

### Риск 3: Регрессии в production
**Митигация:** Feature flags для переключения между старым и новым кодом

---

## 7. Рекомендации

1. **Начать с validatorJanitor** - самый простой случай, полная замена
2. **Аккуратно мигрировать AIOrchestrator** - критичный компонент, требует тестирования
3. **Постепенно переходить на dnaSynthesis** - более мощный, но требует времени
4. **Сохранить UI компоненты** - могут быть полезны для разных сценариев
5. **Добавить deprecation warnings** - предупредить пользователей о будущих изменениях

---

## 8. Приложения

### Приложение A: Список файлов для удаления

**Backend:**
- `backend/src/services/validatorJanitor.ts`
- `backend/src/scripts/validator-janitor.ts`
- `backend/src/ai/orchestrator.ts` (после миграции)

**Frontend:**
- `frontend/src/components/DocumentGlossary.tsx` (опционально)
- `frontend/src/hooks/useDocumentGlossary.ts` (опционально)

### Приложение B: Список API endpoints для удаления

- `POST /documents/:documentId/validator-janitor`
- `GET /documents/:documentId/glossary` (опционально)
- `PATCH /documents/:documentId/glossary/:entryId` (опционально)

---

## 9. Детальная матрица сравнения

### validatorJanitor vs universalJanitor

| Функция | validatorJanitor | universalJanitor |
|---------|------------------|------------------|
| Batch verification | ✅ | ✅ |
| Script checking | ✅ | ✅ |
| Identity Protection | ✅ | ✅ |
| HITL статусы | ❌ | ✅ |
| ValidationHints | ❌ | ✅ |
| Детальные ошибки | ❌ | ✅ |
| Auto-fix | ✅ | ✅ |
| Reason reporting | ❌ | ✅ |

### AIOrchestrator vs TranslationOrchestrator

| Функция | AIOrchestrator | TranslationOrchestrator |
|---------|----------------|-------------------------|
| Batch translation | ✅ | ✅ |
| DNA injection | ✅ | ✅ |
| Contextual filtering | ❌ | ✅ |
| Model capabilities | ❌ | ✅ |
| ValidationHints | ❌ | ✅ |
| Session state | ✅ | ❌ |
| Retry logic | ❌ | ✅ |

### extractGlossary vs dnaSynthesis

| Функция | extractGlossary | dnaSynthesis |
|---------|-----------------|--------------|
| Извлечение терминов | ✅ | ✅ |
| Fast mode | ✅ | ❌ |
| Deep mode | ✅ | ✅ |
| Master DNA | ❌ | ✅ |
| Conflict resolution | ❌ | ✅ |
| LLM enrichment | ❌ | ✅ |
| ValidationHints | ❌ | ✅ |
| Tag-based resolution | ❌ | ✅ |

---

**Конец отчета**
