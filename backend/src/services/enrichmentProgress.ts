/**
 * In-memory store for DNA enrichment progress tracking
 * Similar to pretranslateProgress.ts
 */

interface EnrichmentProgress {
  documentId: string;
  status: 'idle' | 'processing' | 'completed' | 'error';
  current: number;
  total: number;
  batchNumber: number;
  totalBatches: number;
  added: number;
  skipped: number;
  conflicts: number;
  errors: Array<{ row: number; ruName: string; error: string }>;
  lastAdded?: {
    ruName: string;
    shortForm: string;
    longForm: string;
  };
  error?: string;
  startedAt: Date;
  updatedAt: Date;
}

const progressStore = new Map<string, EnrichmentProgress>();

/**
 * Create or update enrichment progress
 */
export function createOrUpdateProgress(
  documentId: string,
  updates: Partial<Omit<EnrichmentProgress, 'documentId' | 'startedAt' | 'updatedAt'>> = {},
): EnrichmentProgress {
  try {
    const existing = progressStore.get(documentId);
    const now = new Date();

    // Ensure updates is an object
    const safeUpdates = updates || {};

    // Safely extract values with type checking
    const getAdded = (): number => {
      if (safeUpdates && typeof safeUpdates.added === 'number') return safeUpdates.added;
      if (existing && typeof existing.added === 'number') return existing.added;
      return 0;
    };

    const getSkipped = (): number => {
      if (safeUpdates && typeof safeUpdates.skipped === 'number') return safeUpdates.skipped;
      if (existing && typeof existing.skipped === 'number') return existing.skipped;
      return 0;
    };

    const getConflicts = (): number => {
      if (safeUpdates && typeof safeUpdates.conflicts === 'number') return safeUpdates.conflicts;
      if (existing && typeof existing.conflicts === 'number') return existing.conflicts;
      return 0;
    };

    const progress: EnrichmentProgress = {
      documentId,
      status: (safeUpdates.status || existing?.status || 'idle') as 'idle' | 'processing' | 'completed' | 'error',
      current: safeUpdates.current ?? existing?.current ?? 0,
      total: safeUpdates.total ?? existing?.total ?? 0,
      batchNumber: safeUpdates.batchNumber ?? existing?.batchNumber ?? 0,
      totalBatches: safeUpdates.totalBatches ?? existing?.totalBatches ?? 0,
      added: getAdded(),
      skipped: getSkipped(),
      conflicts: getConflicts(),
      errors: Array.isArray(safeUpdates.errors) ? safeUpdates.errors : (Array.isArray(existing?.errors) ? existing.errors : []),
      lastAdded: safeUpdates.lastAdded ?? existing?.lastAdded,
      error: safeUpdates.error ?? existing?.error,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
    };

    progressStore.set(documentId, progress);
    return progress;
  } catch (error) {
    // Fallback: create minimal progress object
    const now = new Date();
    const minimalProgress: EnrichmentProgress = {
      documentId,
      status: 'error',
      current: 0,
      total: 0,
      batchNumber: 0,
      totalBatches: 0,
      added: 0,
      skipped: 0,
      conflicts: 0,
      errors: [],
      error: error instanceof Error ? error.message : 'Unknown error in createOrUpdateProgress',
      startedAt: now,
      updatedAt: now,
    };
    progressStore.set(documentId, minimalProgress);
    return minimalProgress;
  }
}

/**
 * Get enrichment progress for a document
 */
export function getProgress(documentId: string): EnrichmentProgress | null {
  const progress = progressStore.get(documentId);
  if (!progress) return null;
  
  // Ensure all required fields exist with defaults
  try {
    return {
      ...progress,
      documentId: progress.documentId || documentId,
      status: progress.status || 'idle',
      added: typeof progress.added === 'number' ? progress.added : 0,
      skipped: typeof progress.skipped === 'number' ? progress.skipped : 0,
      conflicts: typeof progress.conflicts === 'number' ? progress.conflicts : 0,
      errors: Array.isArray(progress.errors) ? progress.errors : [],
      current: typeof progress.current === 'number' ? progress.current : 0,
      total: typeof progress.total === 'number' ? progress.total : 0,
      batchNumber: typeof progress.batchNumber === 'number' ? progress.batchNumber : 0,
      totalBatches: typeof progress.totalBatches === 'number' ? progress.totalBatches : 0,
      startedAt: progress.startedAt || new Date(),
      updatedAt: progress.updatedAt || new Date(),
    };
  } catch (error) {
    // If there's any error reading progress, return null
    return null;
  }
}

/**
 * Complete enrichment progress
 */
export function completeProgress(documentId: string): void {
  const existing = progressStore.get(documentId);
  if (existing) {
    // Don't overwrite if status is already set to completed with full data
    if (existing.status !== 'completed') {
      createOrUpdateProgress(documentId, { status: 'completed' });
    }
    // Auto-cleanup after 5 minutes
    setTimeout(() => {
      progressStore.delete(documentId);
    }, 5 * 60 * 1000);
  }
}

/**
 * Clear progress (for cancellation or cleanup)
 */
export function clearProgress(documentId: string): void {
  progressStore.delete(documentId);
}

/**
 * Get all active enrichment progress
 */
export function getAllActiveProgress(): EnrichmentProgress[] {
  return Array.from(progressStore.values())
    .filter((p) => p && (p.status === 'processing' || p.status === 'idle'))
    .map((p) => ({
      ...p,
      added: p.added ?? 0,
      skipped: p.skipped ?? 0,
      conflicts: p.conflicts ?? 0,
      errors: p.errors ?? [],
      current: p.current ?? 0,
      total: p.total ?? 0,
      batchNumber: p.batchNumber ?? 0,
      totalBatches: p.totalBatches ?? 0,
    }));
}
