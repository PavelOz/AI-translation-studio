# How to Monitor Embedding Generation Progress

## Quick Check

Run this command to see current progress:

```bash
cd backend
npx ts-node scripts/check-embedding-progress.ts
```

## Real-time Monitoring

To watch progress in real-time (updates every 2 seconds):

```bash
cd backend
npx ts-node scripts/monitor-embeddings.ts
```

Press `Ctrl+C` to stop monitoring.

## Start Generation

To start generating embeddings for all entries:

```bash
cd backend
npx ts-node scripts/generate-all-embeddings.ts
```

This will:
- Process ALL TM entries that don't have embeddings
- Show progress updates every 2 seconds
- Complete automatically when done

## Current Status

- **Total TM entries**: 54,261
- **With embeddings**: ~6,000 (11%)
- **Remaining**: ~48,000 entries

## Notes

- Generation runs in the background
- Progress is stored in memory (resets if backend restarts)
- You can run multiple monitoring scripts in different terminals
- Estimated time: ~6-8 hours for all entries (at ~2 entries/sec)
- Estimated cost: ~$0.50-1.00 for all entries



