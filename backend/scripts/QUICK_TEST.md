# Quick Test - See Intermediate Results

## Option 1: Test Script (Recommended for Quick Check)

Shows detailed per-row processing with intermediate results:

```bash
cd backend
npx ts-node scripts/test-enrichment-small.ts document-dna-en-ru-adapted.json [CSV_FILE] --test-rows=5 --no-llm
```

**What you'll see:**
- Each row processed with full details
- Status: Added, Skipped, Conflict, Error
- Sample of new entries
- Final statistics

## Option 2: Full Enrichment with Batch Progress

Shows intermediate results after each batch (25 rows):

```bash
cd backend
npx ts-node scripts/run-final-enrichment.ts document-dna-en-ru-adapted.json [CSV_FILE]
```

**What you'll see after each batch:**
```
📦 Processing batch 1/6 (rows 1-25)

📊 Batch 1 Results:
   ✅ Added: 15 entries
   ⏭️  Skipped: 8 entries
   ⚠️  Conflicts: 2 entries
   📈 Running totals: Added: 15, Skipped: 8, Conflicts: 2, Errors: 0

   📝 Sample entries added in this batch:
      Row 2: "АО 'Алматы - РЭК'" → "Алматы-РЭК" (Almaty Regional Energy Company)
      Row 5: "АО 'Шымкент - РЭК'" → "Шымкент-РЭК" (Shymkent Regional Energy Company)
      ...

   ⏳ Waiting 1s before next batch...
```

## Example Output Structure

### Per-Batch Summary:
- **Batch number** and row range
- **Counts**: Added, Skipped, Conflicts, Errors
- **Sample entries**: First 5 added entries from this batch
- **Running totals**: Cumulative statistics
- **Progress indicator**: Wait time before next batch

### Final Summary:
- Total entries before/after
- Final statistics
- Sample of all new entries
- Output file location
