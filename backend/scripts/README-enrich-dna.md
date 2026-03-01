# DNA Abbreviation Logic Enrichment Script

## Описание

Скрипт для автоматического обогащения блока `abbreviationLogic` в файле Document DNA данными из CSV файла с перечнем энергопроизводящих организаций.

## Использование

### Базовый запуск

```bash
cd backend
npx ts-node scripts/enrich-dna-streaming.ts [DNA_FILE] [CSV_FILE]
```

### Параметры

- `DNA_FILE` (опционально) - путь к файлу DNA. По умолчанию: `../../document-dna-en-ru-adapted.json`
- `CSV_FILE` (опционально) - путь к CSV файлу. По умолчанию: `../../Перечень аттестованных ЭПО 2025.xlsx - Лист1.csv`
- `--no-llm` - отключить использование LLM для перевода (использовать только данные из CSV)
- `--provider=gemini|openai|yandex|deepseek` - выбрать провайдера LLM (по умолчанию: gemini)
- `--output=PATH` - путь для сохранения обновленного DNA файла (по умолчанию: перезаписывает исходный файл)

### Примеры

```bash
# Базовое использование
npx ts-node scripts/enrich-dna-streaming.ts

# С указанием файлов
npx ts-node scripts/enrich-dna-streaming.ts document-dna.json data.csv

# Без LLM (только данные из CSV)
npx ts-node scripts/enrich-dna-streaming.ts --no-llm

# С выбором провайдера
npx ts-node scripts/enrich-dna-streaming.ts --provider=openai

# С указанием выходного файла
npx ts-node scripts/enrich-dna-streaming.ts --output=enriched-dna.json
```

## Требования к CSV файлу

CSV файл должен содержать следующие колонки:

- **Наименование энергопроизводящей организации** (обязательно) - русское название организации (используется как ключ)
- **Сокращенное наименование** (обязательно) - английская аббревиатура (используется как shortForm)
- **Наименование на английском** (опционально) - полное английское название (используется как longForm, если отсутствует - переводится через LLM)

## Логика работы

1. **Парсинг CSV**: Извлекает данные из указанных колонок
2. **Conflict Resolution**:
   - Пропускает записи, где `key === shortForm` (Identity Protection)
   - Не перезаписывает существующие ключи (защита экспертных правок)
3. **Auto-Mapping**:
   - Если есть колонка "Наименование на английском" - использует её как `longForm`
   - Если колонки нет и включен LLM - переводит через AI провайдер
   - Если LLM отключен - использует русское название как `longForm`
4. **Batch Injection**: Добавляет все валидные пары в `abbreviationLogic`
5. **Output**: Выводит обновленный JSON блок `abbreviationLogic` и сохраняет файл DNA

## Структура выходных данных

```json
{
  "RU_TERM": {
    "longForm": "English Full Name",
    "shortForm": "EN_ABBR"
  }
}
```

## Статистика

Скрипт выводит статистику:
- `totalBefore` - количество записей до обогащения
- `totalAfter` - количество записей после обогащения
- `added` - количество добавленных записей
- `skipped` - количество пропущенных записей (дубликаты, конфликты)
- `conflicts` - количество записей с identity конфликтами

## Обработка ошибок

- Если CSV файл не найден - выводит текущий `abbreviationLogic` без изменений
- Если CSV пуст - выводит текущий `abbreviationLogic` без изменений
- Если LLM перевод не удался - использует русское название как fallback
- Все ошибки логируются через logger

## Зависимости

- `csv-parse` - для парсинга CSV файлов
- AI провайдеры (gemini/openai/yandex/deepseek) - для перевода терминов
