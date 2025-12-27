# Руководство по защите от регрессий

Этот документ описывает систему защиты от регрессий, реализованную в проекте, и как её использовать при разработке новых функций.

## Обзор системы

Система защиты от регрессий включает:

1. **Feature Flags** - управление новыми функциями через environment variables
2. **Улучшенное логирование** - структурированные логи для отладки
3. **Unit-тесты** - автоматизированное тестирование утилит
4. **Code Review Checklist** - чеклист для проверки PR
5. **Changelog** - ведение истории изменений

## 1. Feature Flags

### Что это?

Feature Flags позволяют включать/выключать новые функции без изменения кода и деплоя. Это особенно полезно для:
- Постепенного rollout новых функций
- Быстрого отката при проблемах
- A/B тестирования
- Разделения функций для разных окружений

### Как использовать

#### Добавление нового feature flag

1. **Добавьте флаг в `backend/src/utils/featureFlags.ts`:**

```typescript
export const featureFlags = {
  // ... существующие флаги
  myNewFeature: process.env.ENABLE_MY_NEW_FEATURE === 'true',
} as const;
```

2. **Используйте флаг в коде:**

```typescript
import { featureFlags } from '../utils/featureFlags';

if (featureFlags.myNewFeature) {
  // Новая функциональность
  useNewImplementation();
} else {
  // Старая функциональность (fallback)
  useOldImplementation();
}
```

3. **Добавьте в `.env` для включения:**

```env
ENABLE_MY_NEW_FEATURE=true
```

#### Доступные Feature Flags

Добавьте следующие переменные в ваш `.env` файл для управления функциями:

```env
# Feature Flags
# Enable new analysis UI with improved stage indicators
ENABLE_NEW_ANALYSIS_UI=false

# Enable enhanced DOCX export with better formatting preservation
ENABLE_ENHANCED_DOCX=false

# Enable detailed logging for debugging (default: true in development)
ENABLE_DETAILED_LOGGING=false

# Enable experimental features (use with caution)
ENABLE_EXPERIMENTAL=false
```

**Примечание:** По умолчанию все флаги выключены (`false`) для безопасности. Включайте их только когда функция готова к использованию.

#### Типизированные флаги

Используйте helper функции для type-safe проверок:

```typescript
import { isFeatureEnabled, FeatureFlagName } from '../utils/featureFlags';

if (isFeatureEnabled('myNewFeature')) {
  // TypeScript знает, что это валидный флаг
}
```

#### Получение списка включенных флагов

Для отладки и логирования:

```typescript
import { getEnabledFlags } from '../utils/featureFlags';

const enabled = getEnabledFlags();
console.log('Enabled features:', enabled);
```

### Best Practices

- ✅ Всегда предоставляйте fallback на старую функциональность
- ✅ Документируйте флаг в комментариях
- ✅ Используйте понятные имена (ENABLE_*)
- ✅ По умолчанию флаги должны быть `false` (безопасность)
- ✅ Удаляйте флаги после полного rollout (через несколько релизов)

### Примеры использования

#### В сервисах

```typescript
// backend/src/services/analysis.service.ts
import { featureFlags } from '../utils/featureFlags';

export const extractGlossary = async (documentId: string) => {
  if (featureFlags.newAnalysisUI) {
    // Используем новый алгоритм анализа
    return await extractGlossaryV2(documentId);
  } else {
    // Используем старый проверенный алгоритм
    return await extractGlossaryV1(documentId);
  }
};
```

#### Во frontend

```typescript
// frontend/src/components/AnalysisSidebar.tsx
// Feature flags можно передавать через API или использовать условный рендеринг
const useNewUI = apiResponse.featureFlags?.newAnalysisUI ?? false;

return useNewUI ? <NewAnalysisUI /> : <OldAnalysisUI />;
```

## 2. Улучшенное логирование

### Helper функции

Система предоставляет несколько helper функций для структурированного логирования:

#### logOperationStart

Логирует начало операции:

```typescript
import { logOperationStart } from '../utils/logger';

logOperationStart('document-analysis', {
  documentId: '123',
  userId: '456',
});
```

#### logOperationEnd

Логирует завершение операции с временем выполнения:

```typescript
import { logOperationEnd } from '../utils/logger';

const startTime = Date.now();
// ... выполнение операции ...
const duration = Date.now() - startTime;

logOperationEnd('document-analysis', { documentId: '123' }, duration, true);
```

#### logErrorWithContext

Логирует ошибки с полным контекстом:

```typescript
import { logErrorWithContext } from '../utils/logger';

try {
  // ... код ...
} catch (error) {
  logErrorWithContext(error, {
    documentId: '123',
    operation: 'document-analysis',
  }, 'extractGlossary');
}
```

#### logProgress

Логирует прогресс длительных операций:

```typescript
import { logProgress } from '../utils/logger';

logProgress('document-analysis', 'parsing-glossary', 45, {
  documentId: '123',
  termsFound: 150,
});
```

### Best Practices

- ✅ Всегда включайте контекст (documentId, userId, operation)
- ✅ Логируйте начало и конец критических операций
- ✅ Используйте правильный уровень логирования (info, debug, error)
- ✅ Не логируйте чувствительные данные (пароли, токены)
- ✅ Используйте структурированные данные (объекты) вместо строк

## 3. Unit-тесты

### Настройка

Тесты используют Jest и ts-jest. Конфигурация находится в:
- `backend/jest.config.js` - конфигурация Jest
- `backend/tsconfig.test.json` - настройки TypeScript для тестов

### Запуск тестов

```bash
cd backend
npm test              # Запустить все тесты
npm run test:watch    # Запустить в watch режиме
npm run test:coverage # С покрытием кода
```

### Структура тестов

Тесты находятся в `__tests__` директориях рядом с исходными файлами:

```
backend/src/utils/
  ├── env.ts
  ├── __tests__/
  │   └── env.test.ts
  ├── logger.ts
  ├── __tests__/
  │   └── logger.test.ts
```

### Написание тестов

#### Пример простого теста

```typescript
// backend/src/utils/__tests__/myUtil.test.ts
import { myFunction } from '../myUtil';

describe('myFunction', () => {
  it('should return correct value for valid input', () => {
    expect(myFunction('input')).toBe('expected');
  });

  it('should handle edge cases', () => {
    expect(myFunction('')).toBe('');
    expect(myFunction(null)).toBe(null);
  });
});
```

#### Тестирование с моками

```typescript
jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
  },
}));
```

### Best Practices

- ✅ Начинайте с простых pure functions (без зависимостей)
- ✅ Тестируйте граничные случаи (null, undefined, пустые строки)
- ✅ Тестируйте обработку ошибок
- ✅ Используйте описательные имена тестов
- ✅ Группируйте связанные тесты в `describe` блоки

## 4. Code Review Checklist

Перед мерджем PR проверьте:

- [ ] Код не ломает существующую функциональность
- [ ] Добавлены тесты для новых функций
- [ ] Обработка ошибок корректна
- [ ] Логирование добавлено где нужно
- [ ] Используются feature flags для новых функций
- [ ] Обновлен CHANGELOG.md

Полный чеклист: [CODE_REVIEW_CHECKLIST.md](./CODE_REVIEW_CHECKLIST.md)

## 5. Changelog

### Формат

Changelog следует формату [Keep a Changelog](https://keepachangelog.com/):

```markdown
## [Unreleased]

### Added
- Новая функция X

### Changed
- Улучшена функция Y

### Fixed
- Исправлен баг Z
```

### Типы изменений

- **Added** - новые функции
- **Changed** - изменения в существующих функциях
- **Deprecated** - функции, которые будут удалены
- **Removed** - удаленные функции
- **Fixed** - исправления багов
- **Security** - исправления уязвимостей

### Когда обновлять

- При добавлении новой пользовательской функции
- При исправлении критических багов
- При изменении API
- При удалении функций

## Процесс разработки с защитой от регрессий

### 1. Планирование

- Определите, нужен ли feature flag для новой функции
- Подумайте о fallback на старую функциональность
- Определите, какие тесты нужны

### 2. Разработка

- Используйте feature flags для новых функций
- Добавляйте структурированное логирование
- Пишите тесты параллельно с кодом
- Обновляйте документацию

### 3. Code Review

- Используйте [CODE_REVIEW_CHECKLIST.md](./CODE_REVIEW_CHECKLIST.md)
- Проверьте влияние на существующие функции
- Убедитесь, что тесты покрывают новый код

### 4. Деплой

- Включите feature flag в production постепенно
- Мониторьте логи на наличие ошибок
- Будьте готовы к быстрому откату через feature flag

### 5. После деплоя

- Мониторьте метрики и ошибки
- Собирайте обратную связь
- Через несколько релизов удалите feature flag и старый код

## Примеры использования

### Пример 1: Новая функция анализа

```typescript
// 1. Добавить feature flag
export const featureFlags = {
  newAnalysisAlgorithm: process.env.ENABLE_NEW_ANALYSIS_ALGORITHM === 'true',
};

// 2. Использовать в коде
export const extractGlossary = async (documentId: string) => {
  logOperationStart('extract-glossary', { documentId });
  const startTime = Date.now();

  try {
    let result;
    if (featureFlags.newAnalysisAlgorithm) {
      result = await extractGlossaryV2(documentId);
    } else {
      result = await extractGlossaryV1(documentId);
    }

    const duration = Date.now() - startTime;
    logOperationEnd('extract-glossary', { documentId }, duration, true);
    return result;
  } catch (error) {
    logErrorWithContext(error, { documentId }, 'extractGlossary');
    throw error;
  }
};
```

### Пример 2: Тестирование утилиты

```typescript
// backend/src/utils/__tests__/myUtil.test.ts
import { myUtilFunction } from '../myUtil';

describe('myUtilFunction', () => {
  it('should handle normal case', () => {
    expect(myUtilFunction('input')).toBe('expected');
  });

  it('should handle edge cases', () => {
    expect(myUtilFunction('')).toBe('');
    expect(myUtilFunction(null)).toBe(null);
  });
});
```

## Ресурсы

- [Feature Flags документация](./featureFlags.ts)
- [Code Review Checklist](./CODE_REVIEW_CHECKLIST.md)
- [Changelog](../CHANGELOG.md)
- [Jest документация](https://jestjs.io/docs/getting-started)

## Вопросы?

Если у вас есть вопросы по использованию системы защиты от регрессий, обратитесь к команде разработки или создайте issue в репозитории.










