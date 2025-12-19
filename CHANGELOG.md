# Changelog

Все значимые изменения в проекте будут документированы в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.0.0/),
и этот проект придерживается [Semantic Versioning](https://semver.org/lang/ru/).

## [Unreleased]

### Added
- **Feature Flags система** для управления новыми функциями через environment variables (`backend/src/utils/featureFlags.ts`)
- **Улучшенные helper функции для логирования**: `logOperationStart`, `logOperationEnd`, `logErrorWithContext`, `logProgress`
- **Code Review Checklist** (`docs/CODE_REVIEW_CHECKLIST.md`) для предотвращения регрессий
- **Unit-тесты инфраструктура**: Jest настроен, созданы первые тесты для утилит
- **Руководство по защите от регрессий** (`docs/REGRESSION_PREVENTION.md`)
- Индикатор ожидания AI API в AnalysisSidebar (желтый фон с иконкой ⏳)
- Перечеркивание завершенных стадий анализа в UI

### Changed
- Улучшена логика определения завершенных стадий анализа с учетом параллельного выполнения glossary и style rules
- AnalysisSidebar теперь использует флаги `glossaryExtracted` и `styleRulesExtracted` для точного определения завершенных стадий

### Changed
- Улучшена логика определения завершенных стадий анализа с учетом параллельного выполнения glossary и style rules
- AnalysisSidebar теперь использует флаги `glossaryExtracted` и `styleRulesExtracted` для точного определения завершенных стадий

### Fixed
- Исправлена проблема с пустым экраном во время анализа (добавлены null-safety проверки)
- Улучшена обработка ошибок в AnalysisSidebar для предотвращения крашей

## [2.3.0] - 2025-01-XX

### Added
- Документ анализ с извлечением глоссария и правил стиля
- Прогресс-бар и индикаторы стадий для процесса анализа
- Поддержка параллельного выполнения glossary и style rules extraction

### Changed
- Улучшена обработка ошибок в процессе анализа (Promise.allSettled вместо Promise.all)
- Frontend продолжает опрос статуса даже после ошибок для отслеживания фонового процесса

## [2.2.0] - 2024-12-XX

### Added
- DOM-based XML манипуляции для DOCX экспорта
- Сохранение смешанного форматирования при экспорте

### Fixed
- Исправлена потеря переводов при экспорте DOCX
- Исправлена потеря форматирования при экспорте DOCX

---

## Типы изменений

- `Added` - для новых функций
- `Changed` - для изменений в существующей функциональности
- `Deprecated` - для функций, которые скоро будут удалены
- `Removed` - для удаленных функций
- `Fixed` - для исправления багов
- `Security` - для исправлений уязвимостей







