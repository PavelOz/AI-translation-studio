import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../utils/authMiddleware';
import { getDocumentSegments, updateSegment, getSegment, bulkUpdateSegments, searchSegments } from '../services/segment.service';
import { runSegmentMachineTranslation, runSegmentMachineTranslationWithCritic, getSegmentDebugInfo } from '../services/ai.service';
import { getSegmentMetrics, runSegmentQualityCheck } from '../services/quality.service';
import type { GlossaryMode } from '../types/glossary';

const patchSchema = z.object({
  target_final: z.string().optional(),
  targetFinal: z.string().optional(), // Support camelCase
  target_mt: z.string().optional(),
  targetMt: z.string().optional(), // Support camelCase
  status: z.enum(['NEW', 'MT', 'EDITED', 'CONFIRMED']).optional(),
  confirmed_by: z.string().uuid().nullable().optional(),
  confirmedById: z.string().uuid().nullable().optional(), // Support camelCase
  confirmed_at: z.string().datetime().optional(),
  confirmedAt: z.string().datetime().optional(), // Support camelCase
  fuzzy_score: z.number().min(0).max(100).optional(),
  fuzzyScore: z.number().min(0).max(100).optional(), // Support camelCase
  bestTmEntryId: z.string().uuid().nullable().optional(), // Support camelCase
  timeSpentSeconds: z.number().int().min(0).optional(), // Support camelCase
}).transform((data) => ({
  target_final: data.target_final ?? data.targetFinal,
  target_mt: data.target_mt ?? data.targetMt,
  status: data.status,
  confirmed_by: data.confirmed_by ?? data.confirmedById,
  confirmed_at: data.confirmed_at ?? data.confirmedAt,
  fuzzy_score: data.fuzzy_score ?? data.fuzzyScore,
  best_tm_entry_id: (data as any).bestTmEntryId,
  time_spent_seconds: (data as any).timeSpentSeconds,
}));

const bulkUpdateSchema = z.object({
  updates: z.array(
    z.object({
      id: z.string().uuid(),
      target_final: z.string().optional(),
      target_mt: z.string().optional(),
      status: z.enum(['NEW', 'MT', 'EDITED', 'CONFIRMED']).optional(),
      confirmed_by: z.string().uuid().nullable().optional(),
      confirmed_at: z.string().datetime().optional(),
      fuzzy_score: z.number().min(0).max(100).optional(),
    }),
  ),
});

const mtSchema = z.object({
  applyTm: z.boolean().optional(),
  minScore: z.number().min(0).max(100).optional(),
  glossaryMode: z.enum(['off', 'strict_source', 'strict_semantic']).optional(),
  useCritic: z.boolean().optional(), // Enable critic workflow
  tmRagSettings: z.object({
    minScore: z.number().min(0).max(100).optional(),
    vectorSimilarity: z.number().min(0).max(100).optional(),
    mode: z.enum(['basic', 'extended']).optional(),
    useVectorSearch: z.boolean().optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }).nullable().optional(), // Allow null and undefined
});

export const segmentRoutes = Router();

segmentRoutes.use(requireAuth);

segmentRoutes.get(
  '/document/:documentId',
  asyncHandler(async (req, res) => {
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 200;
    const query = req.query.q as string | undefined;

    if (query) {
      const segments = await searchSegments(req.params.documentId, query);
      res.json({ segments, page: 1, pageSize: segments.length, total: segments.length, totalPages: 1 });
    } else {
      const segments = await getDocumentSegments(req.params.documentId, page, pageSize);
      res.json(segments);
    }
  }),
);

segmentRoutes.get(
  '/search',
  asyncHandler(async (req, res) => {
    const documentId = req.query.documentId as string | undefined;
    const query = req.query.q as string | undefined;
    if (!documentId || !query) {
      res.json([]);
      return;
    }
    const segments = await searchSegments(documentId, query);
    res.json(segments);
  }),
);

segmentRoutes.get(
  '/:segmentId',
  asyncHandler(async (req, res) => {
    const segment = await getSegment(req.params.segmentId);
    res.json(segment);
  }),
);

segmentRoutes.patch(
  '/:segmentId',
  asyncHandler(async (req, res) => {
    const payload = patchSchema.parse(req.body);
    const updatePayload: Parameters<typeof updateSegment>[1] = {
      targetFinal: payload.target_final,
      targetMt: payload.target_mt,
      status: payload.status,
      fuzzyScore: payload.fuzzy_score,
      bestTmEntryId: (payload as any).best_tm_entry_id,
      timeSpentSeconds: (payload as any).time_spent_seconds,
    };

    if (payload.confirmed_by !== undefined) {
      updatePayload.confirmedById = payload.confirmed_by;
    }

    if (payload.confirmed_at !== undefined) {
      updatePayload.confirmedAt = payload.confirmed_at ? new Date(payload.confirmed_at) : null;
    } else if (payload.status === 'CONFIRMED') {
      updatePayload.confirmedAt = new Date();
    }

    const segment = await updateSegment(req.params.segmentId, updatePayload);
    res.json(segment);
  }),
);

segmentRoutes.post(
  '/bulk-update',
  asyncHandler(async (req, res) => {
    const payload = bulkUpdateSchema.parse(req.body);
    const segments = await bulkUpdateSegments(
      payload.updates.map((item) => ({
        id: item.id,
        targetFinal: item.target_final,
        targetMt: item.target_mt,
        status: item.status,
        fuzzyScore: item.fuzzy_score,
        confirmedById: item.confirmed_by,
        confirmedAt: item.confirmed_at ? new Date(item.confirmed_at) : undefined,
      })),
    );
    res.json(segments);
  }),
);

segmentRoutes.post(
  '/:segmentId/mt',
  asyncHandler(async (req, res) => {
    const payload = mtSchema.parse(req.body ?? {});
    
    // Use critic workflow if requested
    if (payload.useCritic) {
      // Check if client wants SSE (Server-Sent Events) for progress
      const acceptSSE = req.headers.accept?.includes('text/event-stream');
      
      if (acceptSSE) {
        // Set up SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
        
        // Progress callback
        const sendProgress = (stage: 'draft' | 'critic' | 'editor' | 'complete', message?: string) => {
          res.write(`data: ${JSON.stringify({ stage, message, timestamp: new Date().toISOString() })}\n\n`);
        };
        
        try {
          const result = await runSegmentMachineTranslationWithCritic(
            req.params.segmentId,
            {
              applyTm: payload.applyTm,
              minScore: payload.minScore,
              glossaryMode: payload.glossaryMode ?? 'strict_source',
              tmRagSettings: payload.tmRagSettings,
            },
            sendProgress,
          );
          
          // Send final result
          res.write(`data: ${JSON.stringify({ 
            stage: 'complete', 
            result: {
              id: result.id,
              targetMt: result.targetMt,
              targetFinal: result.targetFinal,
              status: result.status,
              fuzzyScore: result.fuzzyScore,
            },
            timestamp: new Date().toISOString() 
          })}\n\n`);
          res.end();
        } catch (error) {
          res.write(`data: ${JSON.stringify({ stage: 'error', error: (error as Error).message, timestamp: new Date().toISOString() })}\n\n`);
          res.end();
        }
      } else {
        // Regular HTTP response
        const result = await runSegmentMachineTranslationWithCritic(req.params.segmentId, {
          applyTm: payload.applyTm,
          minScore: payload.minScore,
          glossaryMode: payload.glossaryMode ?? 'strict_source',
          tmRagSettings: payload.tmRagSettings,
        });
        res.json(result);
      }
    } else {
      const segment = await runSegmentMachineTranslation(req.params.segmentId, {
        applyTm: payload.applyTm,
        minScore: payload.minScore,
        glossaryMode: payload.glossaryMode ?? 'strict_source', // Default to strict_source if not provided
        tmRagSettings: payload.tmRagSettings,
      });
      res.json(segment);
    }
  }),
);

segmentRoutes.post(
  '/:segmentId/qa',
  asyncHandler(async (req, res) => {
    const report = await runSegmentQualityCheck(req.params.segmentId);
    res.json(report);
  }),
);

segmentRoutes.get(
  '/:segmentId/metrics',
  asyncHandler(async (req, res) => {
    const metrics = await getSegmentMetrics(req.params.segmentId);
    res.json(metrics);
  }),
);

segmentRoutes.get(
  '/:segmentId/debug',
  asyncHandler(async (req, res) => {
    const debugInfo = await getSegmentDebugInfo(req.params.segmentId);
    res.json(debugInfo);
  }),
);

// Control endpoint for blind translation (without document context)
segmentRoutes.post(
  '/:segmentId/translate-blind',
  asyncHandler(async (req, res) => {
    const payload = mtSchema.parse(req.body ?? {});
    
    // Check if client wants SSE (Server-Sent Events) for progress
    const acceptSSE = req.headers.accept?.includes('text/event-stream');
    
    if (acceptSSE) {
      // Set up SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
      
      // Progress callback
      const sendProgress = (stage: 'draft' | 'critic' | 'editor' | 'complete', message?: string) => {
        res.write(`data: ${JSON.stringify({ stage, message, timestamp: new Date().toISOString() })}\n\n`);
      };
      
      try {
        const result = await runSegmentMachineTranslationWithCritic(
          req.params.segmentId,
          {
            applyTm: payload.applyTm,
            minScore: payload.minScore,
            glossaryMode: payload.glossaryMode ?? 'strict_source',
            tmRagSettings: payload.tmRagSettings,
            ignoreContext: true, // Skip document context
          },
          sendProgress,
        );
        
        // Send final result
        res.write(`data: ${JSON.stringify({ 
          stage: 'complete', 
          result: {
            id: result.id,
            targetMt: result.targetMt,
            targetFinal: result.targetFinal,
            status: result.status,
            fuzzyScore: result.fuzzyScore,
          },
          timestamp: new Date().toISOString() 
        })}\n\n`);
        res.end();
      } catch (error) {
        res.write(`data: ${JSON.stringify({ stage: 'error', error: (error as Error).message, timestamp: new Date().toISOString() })}\n\n`);
        res.end();
      }
    } else {
      // Regular HTTP response
      const result = await runSegmentMachineTranslationWithCritic(
        req.params.segmentId,
        {
          applyTm: payload.applyTm,
          minScore: payload.minScore,
          glossaryMode: payload.glossaryMode ?? 'strict_source',
          tmRagSettings: payload.tmRagSettings,
          ignoreContext: true, // Skip document context
        },
      );
      res.json(result);
    }
  }),
);

