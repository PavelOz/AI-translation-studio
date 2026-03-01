# DNA Enrichment Diagnostic Report

## 🔍 Диагностика завершена

### 1. Анализ строки 110 (АО "Астана - РЭК")

**Результат:** ❌ **MISSING from DNA** (не Identity Conflict)

- **RU Name:** "АО 'Астана - РЭК'"
- **Short Form:** "Астана - РЭК"
- **Status:** Entry отсутствует в DNA
- **Identity Conflict:** НЕТ (нормализованные ключи не совпадают)

**Вывод:** Строка 110 была пропущена НЕ из-за Identity Protection, а потому что:
- Либо процесс обогащения остановился раньше (API ошибка, timeout)
- Либо запись уже существовала и была пропущена по правилу "expert edit protection"
- Либо была ошибка при обработке этой конкретной строки

**Рекомендация:** Проверить логи обогащения на наличие ошибок API или timeout на строке 110.

---

### 2. Анализ SUSPICIOUS_ABBREV (176 ошибок)

**Проблема:** Все 12 базовых токенов отсутствуют в `abbreviationLogic`:

| Токен | В Keys? | В ShortForms? | Будет помечен? |
|-------|---------|---------------|----------------|
| JSC   | ❌      | ❌            | ⚠️  YES        |
| LLP   | ❌      | ❌            | ⚠️  YES        |
| MW    | ❌      | ❌            | ⚠️  YES        |
| SN    | ❌      | ❌            | ⚠️  YES        |
| Pmin  | ❌      | ❌            | ⚠️  YES        |
| GTPP  | ❌      | ❌            | ⚠️  YES        |
| UKGES | ❌      | ❌            | ⚠️  YES        |
| HPP   | ❌      | ❌            | ⚠️  YES        |
| NPP   | ❌      | ❌            | ⚠️  YES        |
| TPP   | ❌      | ❌            | ⚠️  YES        |
| WPP   | ❌      | ❌            | ⚠️  YES        |
| SPP   | ❌      | ❌            | ⚠️  YES        |

**Почему это происходит:**

Функция `findSuspiciousAbbrevs` в `validatorJanitor.ts` проверяет:
1. `knownKeys.has(t)` - является ли токен **ключом** в abbreviationLogic?
2. `knownShortForms.has(t)` - является ли токен **shortForm** в abbreviationLogic?
3. `whitelist` (common English words)

**Проблема:** Если токен "JSC" встречается в тексте как отдельное слово, но он не является ключом в abbreviationLogic (только shortForm для "АО"), то он может быть помечен как SUSPICIOUS_ABBREV.

**Решение:** ✅ **ДА, нужно добавить базовые токены как отдельные записи**

---

### 3. Рекомендуемые записи для abbreviationLogic

```json
{
  "АО": {
    "longForm": "Joint Stock Company",
    "shortForm": "JSC"
  },
  "ТОО": {
    "longForm": "Limited Liability Partnership",
    "shortForm": "LLP"
  },
  "МВт": {
    "longForm": "Megawatt",
    "shortForm": "MW"
  },
  "СН": {
    "longForm": "Auxiliary Power",
    "shortForm": "SN"
  },
  "Рмин": {
    "longForm": "Minimum Power",
    "shortForm": "Pmin"
  },
  "ГТЭС": {
    "longForm": "Gas Turbine Power Plant",
    "shortForm": "GTPP"
  },
  "УКГЭС": {
    "longForm": "Ust-Kamenogorsk Hydroelectric Power Plant",
    "shortForm": "UKGES"
  },
  "ГЭС": {
    "longForm": "Hydroelectric Power Plant",
    "shortForm": "HPP"
  },
  "АЭС": {
    "longForm": "Nuclear Power Plant",
    "shortForm": "NPP"
  },
  "ТЭС": {
    "longForm": "Thermal Power Plant",
    "shortForm": "TPP"
  },
  "ВЭС": {
    "longForm": "Wind Power Plant",
    "shortForm": "WPP"
  },
  "СЭС": {
    "longForm": "Solar Power Plant",
    "shortForm": "SPP"
  }
}
```

**Ожидаемый эффект:** Снижение количества SUSPICIOUS_ABBREV флагов на ~120-240 (в зависимости от частоты использования этих токенов в тексте).

---

### 4. Identity Conflicts в текущем DNA

⚠️ **Найдено 3 конфликта:**

1. `"EPC" → "EPC"` - ключ совпадает с shortForm
2. `"ESHS" → "ESHS"` - ключ совпадает с shortForm  
3. `"GIIP" → "GIIP"` - ключ совпадает с shortForm

**Рекомендация:** Исправить эти записи, изменив shortForm на уникальное значение.

---

### 5. Статистика CSV → DNA

Для полной статистики необходимо запустить диагностику с CSV файлом:

```bash
npx ts-node scripts/diagnose-dna-enrichment.ts [DNA_FILE] [CSV_FILE]
```

**Текущий DNA:** 25 записей в abbreviationLogic

---

## 📋 Итоговые рекомендации

1. ✅ **Добавить 12 базовых токенов** в abbreviationLogic для снижения SUSPICIOUS_ABBREV флагов
2. ⚠️ **Исправить 3 Identity Conflicts** в текущем DNA (EPC, ESHS, GIIP)
3. 🔍 **Проверить логи обогащения** для выяснения причины остановки на строке 110
4. 📊 **Запустить полную диагностику** с CSV файлом для подсчета реально отсутствующих записей

---

## 🛠️ Следующие шаги

1. Использовать скрипт `enrich-dna-streaming.ts` с флагом `--no-llm` для быстрого добавления базовых токенов
2. Или добавить базовые токены вручную через UI (Edit DNA → Add entries)
3. Проверить логи сервера на наличие ошибок при обогащении
4. Повторить обогащение CSV после исправления Identity Conflicts
