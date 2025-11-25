// In-memory store for pretranslation progress and cancellation
// In production, consider using Redis or a database for distributed systems

interface PretranslateProgress {
  documentId: string;
  status: 'running' | 'completed' | 'cancelled' | 'error';
  currentSegment: number;
  totalSegments: number;
  tmApplied: number;
  aiApplied: number;
  currentSegmentId?: string;
  currentSegmentText?: string;
  error?: string;
  results: Array<{
    segmentId: string;
    method: 'tm' | 'ai';
    targetMt: string | null;
    fuzzyScore?: number;
  }>;
}

const progressStore = new Map<string, PretranslateProgress>();
const cancellationFlags = new Set<string>();

export const createProgress = (documentId: string, totalSegments: number): void => {
  progressStore.set(documentId, {
    documentId,
    status: 'running',
    currentSegment: 0,
    totalSegments,
    tmApplied: 0,
    aiApplied: 0,
    results: [],
  });
  cancellationFlags.delete(documentId); // Clear any previous cancellation
};

export const updateProgress = (
  documentId: string,
  update: Partial<Pick<PretranslateProgress, 'currentSegment' | 'tmApplied' | 'aiApplied' | 'currentSegmentId' | 'currentSegmentText'>>,
): void => {
  const progress = progressStore.get(documentId);
  if (progress) {
    Object.assign(progress, update);
  }
};

export const addResult = (
  documentId: string,
  result: {
    segmentId: string;
    method: 'tm' | 'ai';
    targetMt: string | null;
    fuzzyScore?: number;
  },
): void => {
  const progress = progressStore.get(documentId);
  if (progress) {
    progress.results.push(result);
  }
};

export const completeProgress = (documentId: string): void => {
  const progress = progressStore.get(documentId);
  if (progress) {
    progress.status = 'completed';
  }
};

export const cancelProgress = (documentId: string): void => {
  cancellationFlags.add(documentId);
  const progress = progressStore.get(documentId);
  if (progress) {
    progress.status = 'cancelled';
  }
};

export const isCancelled = (documentId: string): boolean => {
  return cancellationFlags.has(documentId);
};

export const getProgress = (documentId: string): PretranslateProgress | null => {
  return progressStore.get(documentId) || null;
};

export const setError = (documentId: string, error: string): void => {
  const progress = progressStore.get(documentId);
  if (progress) {
    progress.status = 'error';
    progress.error = error;
  }
};

export const clearProgress = (documentId: string): void => {
  progressStore.delete(documentId);
  cancellationFlags.delete(documentId);
};

// Cleanup old progress entries (older than 1 hour)
setInterval(() => {
  // In a real implementation, you'd track timestamps and clean up old entries
  // For now, we'll just keep them in memory
}, 60 * 60 * 1000);



