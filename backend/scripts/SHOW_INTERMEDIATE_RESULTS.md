# How to See Intermediate Enrichment Results

## Quick Test (First 5-10 rows, no LLM)

To quickly test and see intermediate results without waiting for LLM calls:

```bash
cd backend
npx ts-node scripts/test-enrichment-small.ts document-dna-en-ru-adapted.json [CSV_FILE] --test-rows=5 --no-llm
```

**Example output:**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 Processing Row 1/5
   RU Name: "АО 'Астана - РЭК'"
   Short Form: "Астана-РЭК"
   EN Name: N/A (will translate)
   ⏭️  SKIPPED: Key already exists in DNA (expert edit protection)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 Processing Row 2/5
   RU Name: "АО 'Алматы - РЭК'"
   Short Form: "Алматы-РЭК"
   EN Name: N/A (will translate)
   ✅ ADDED to DNA: "АО 'Алматы - РЭК'" → "Алматы-РЭК" (АО 'Алматы - РЭК')

📊 INTERMEDIATE RESULTS (First 5 rows):
✅ Added: 3 entries
⏭️  Skipped: 2 entries
...
```

## Full Enrichment with Batch Progress

For full enrichment, the main script shows intermediate results after each batch (25 rows):

```bash
cd backend
npx ts-node scripts/run-final-enrichment.ts document-dna-en-ru-adapted.json [CSV_FILE]
```

**Example output:**
```
📦 Processing batch 1/6 (rows 1-25)

📊 Batch 1 Results:
   ✅ Added: 15 entries
   ⏭️  Skipped: 8 entries
   ⚠️  Conflicts: 2 entries
   📈 Running totals: Added: 15, Skipped: 8, Conflicts: 2, Errors: 0

   📝 Sample entries added in this batch:
      "АО 'Алматы - РЭК'" → "Алматы-РЭК" (Almaty Regional Energy Company)
      "АО 'Шымкент - РЭК'" → "Шымкент-РЭК" (Shymkent Regional Energy Company)
      "АО 'Караганда - РЭК'" → "Караганда-РЭК" (Karaganda Regional Energy Company)

   ⏳ Waiting 1s before next batch...

📦 Processing batch 2/6 (rows 26-50)
...
```

## What You'll See

### Per-Row Details (test-enrichment-small.ts)
- ✅ **Added**: Entry successfully added to DNA
- ⏭️ **Skipped**: Entry already exists or missing data
- ⚠️ **Identity Conflict**: Key matches shortForm (skipped)
- ❌ **Error**: LLM translation failed (fallback used)

### Per-Batch Summary (run-final-enrichment.ts)
- Batch number and range
- Counts: Added, Skipped, Conflicts, Errors
- Running totals across all batches
- Sample of entries added in this batch
- Progress indicator

## Test Without CSV File

If you want to test the logic without a real CSV, you can create a small test file:

```csv
Наименование энергопроизводящей организации,Сокращенное наименование,Наименование на английском
АО 'Тестовая ЭПО',ТЭПО,Test Power Organization
АО 'Другая ЭПО',ДЭПО,
```

Save as `test.csv` and run:
```bash
npx ts-node scripts/test-enrichment-small.ts document-dna-en-ru-adapted.json test.csv --test-rows=2 --no-llm
```
