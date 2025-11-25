import { prisma } from '../db/prisma';
import { QAEngine, type SegmentContext } from '../ai/qaEngine';
import { ApiError } from '../utils/apiError';

const qaEngine = new QAEngine();

type IssueCounts = {
  term: number;
  format: number;
  consistency: number;
  tags: number;
};

const toWordCount = (text?: string | null) => (text ? text.trim().split(/\s+/).filter(Boolean).length : 0);

const editDistance = (a: string, b: string) => {
  if (!a || !b) return Math.max(a?.length ?? 0, b?.length ?? 0);
  if (a === b) return 0;
  const matrix = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) {
    matrix[i][0] = i;
  }
  for (let j = 0; j <= b.length; j += 1) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[a.length][b.length];
};

const countIssues = (issues: Array<{ category: string }>): IssueCounts =>
  issues.reduce(
    (acc, issue) => {
      if (issue.category === 'terminology') {
        acc.term += 1;
      } else if (issue.category === 'format' || issue.category === 'tags') {
        acc.format += issue.category === 'tags' ? 1 : 1;
        if (issue.category === 'tags') {
          acc.tags += 1;
        }
      } else if (issue.category === 'consistency') {
        acc.consistency += 1;
      }
      return acc;
    },
    { term: 0, format: 0, consistency: 0, tags: 0 },
  );

const mapMetricRow = (metric: {
  mtWordCount: number;
  finalWordCount: number;
  editDistanceChars: number;
  termErrors: number;
  formatErrors: number;
  consistencyErrors: number;
  timeSpentSeconds: number;
}) => ({
  ...metric,
  editDistancePercent:
    metric.finalWordCount === 0
      ? 0
      : Math.min(100, (metric.editDistanceChars / Math.max(metric.finalWordCount * 5, 1)) * 100),
});

const aggregateMetrics = (metrics: ReturnType<typeof mapMetricRow>[]) => {
  if (metrics.length === 0) {
    return {
      mtCoverage: 0,
      avgEditDistancePercent: 0,
      termAccuracyPercent: 100,
      totalMtWords: 0,
      totalFinalWords: 0,
      qaErrors: { term: 0, format: 0, consistency: 0 },
      avgTimePerSegment: 0,
    };
  }

  const totals = metrics.reduce(
    (acc, metric) => {
      acc.mtWords += metric.mtWordCount;
      acc.finalWords += metric.finalWordCount;
      acc.editDistancePct += metric.editDistancePercent;
      acc.termErrors += metric.termErrors;
      acc.formatErrors += metric.formatErrors;
      acc.consistencyErrors += metric.consistencyErrors;
      acc.timeSpent += metric.timeSpentSeconds;
      if (metric.mtWordCount > 0) {
        acc.mtSegments += 1;
      }
      return acc;
    },
    {
      mtWords: 0,
      finalWords: 0,
      editDistancePct: 0,
      termErrors: 0,
      formatErrors: 0,
      consistencyErrors: 0,
      timeSpent: 0,
      mtSegments: 0,
    },
  );

  return {
    mtCoverage: totals.mtSegments / metrics.length,
    avgEditDistancePercent: totals.editDistancePct / metrics.length,
    termAccuracyPercent:
      metrics.length === 0
        ? 100
        : Math.max(0, 100 - (totals.termErrors / Math.max(1, totals.finalWords)) * 100),
    totalMtWords: totals.mtWords,
    totalFinalWords: totals.finalWords,
    qaErrors: {
      term: totals.termErrors,
      format: totals.formatErrors,
      consistency: totals.consistencyErrors,
    },
    avgTimePerSegment: totals.timeSpent / metrics.length,
  };
};

export const runSegmentQualityCheck = async (segmentId: string) => {
  const segment = await prisma.segment.findUnique({
    where: { id: segmentId },
    include: {
      document: {
        include: {
          project: true,
        },
      },
    },
  });
  if (!segment || !segment.document) {
    throw ApiError.notFound('Segment not found');
  }

  const glossary = await prisma.glossaryEntry.findMany({
    where: {
      OR: [{ projectId: segment.document.projectId }, { projectId: null }],
      sourceLocale: segment.document.sourceLocale,
      targetLocale: segment.document.targetLocale,
    },
    select: {
      sourceTerm: true,
      targetTerm: true,
      isForbidden: true,
    },
  });

  const projectSegments = await prisma.segment.findMany({
    where: {
      document: {
        projectId: segment.document.projectId,
      },
      NOT: {
        id: segmentId,
      },
    },
    select: {
      sourceText: true,
      targetFinal: true,
    },
    take: 1000,
  });

  const segmentContext: SegmentContext = {
    id: segment.id,
    sourceText: segment.sourceText,
    targetText: segment.targetFinal ?? segment.targetMt ?? null,
    targetMt: segment.targetMt ?? null,
    fileType: segment.document.fileType ?? undefined,
  };

  const issues = qaEngine.runChecks([segmentContext], {
    glossary: glossary.map((g) => ({
      sourceTerm: g.sourceTerm,
      targetTerm: g.targetTerm,
      forbidden: g.isForbidden,
    })),
    projectSegments: projectSegments.map((s) => ({
      sourceText: s.sourceText,
      targetText: s.targetFinal,
    })),
    fileType: segment.document.fileType ?? undefined,
  });

  const issueCounts = countIssues(issues);

  const metricsData = {
    mtWordCount: toWordCount(segment.targetMt),
    finalWordCount: toWordCount(segment.targetFinal ?? segment.targetMt ?? segment.sourceText),
    editDistanceChars: editDistance(
      segment.targetMt ?? segment.sourceText,
      segment.targetFinal ?? segment.targetMt ?? segment.sourceText,
    ),
    termErrors: issueCounts.term,
    formatErrors: issueCounts.format + issueCounts.tags,
    consistencyErrors: issueCounts.consistency,
    timeSpentSeconds: segment.timeSpentSeconds ?? 0,
  };

  const record = await prisma.qualityMetric.upsert({
    where: { segmentId },
    update: metricsData,
    create: {
      segmentId,
      ...metricsData,
    },
  });

  return { metrics: record, issues };
};

export const runDocumentQualityCheck = async (documentId: string) => {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      project: true,
    },
  });
  if (!document) {
    throw ApiError.notFound('Document not found');
  }

  const segments = await prisma.segment.findMany({
    where: { documentId },
    select: { id: true, sourceText: true, targetMt: true, targetFinal: true },
  });

  const glossary = await prisma.glossaryEntry.findMany({
    where: {
      OR: [{ projectId: document.projectId }, { projectId: null }],
      sourceLocale: document.sourceLocale,
      targetLocale: document.targetLocale,
    },
    select: {
      sourceTerm: true,
      targetTerm: true,
      isForbidden: true,
    },
  });

  const segmentContexts: SegmentContext[] = segments.map((seg) => ({
    id: seg.id,
    sourceText: seg.sourceText,
    targetText: seg.targetFinal ?? seg.targetMt ?? null,
    targetMt: seg.targetMt ?? null,
    fileType: document.fileType ?? undefined,
  }));

  const issues = qaEngine.runChecks(segmentContexts, {
    glossary: glossary.map((g) => ({
      sourceTerm: g.sourceTerm,
      targetTerm: g.targetTerm,
      forbidden: g.isForbidden,
    })),
    projectSegments: segmentContexts.map((s) => ({
      sourceText: s.sourceText,
      targetText: s.targetText,
    })),
    fileType: document.fileType ?? undefined,
  });

  const results = [];
  for (const segment of segments) {
    const segmentIssues = issues.filter((issue) => issue.segmentId === segment.id);
    const issueCounts = countIssues(segmentIssues);

    const metricsData = {
      mtWordCount: toWordCount(segment.targetMt),
      finalWordCount: toWordCount(segment.targetFinal ?? segment.targetMt ?? segment.sourceText),
      editDistanceChars: editDistance(
        segment.targetMt ?? segment.sourceText,
        segment.targetFinal ?? segment.targetMt ?? segment.sourceText,
      ),
      termErrors: issueCounts.term,
      formatErrors: issueCounts.format,
      consistencyErrors: issueCounts.consistency,
      timeSpentSeconds: 0,
    };

    await prisma.qualityMetric.upsert({
      where: { segmentId: segment.id },
      update: metricsData,
      create: {
        segmentId: segment.id,
        ...metricsData,
      },
    });

    results.push({ segmentId: segment.id, issues: segmentIssues });
  }

  return {
    documentId,
    processed: results.length,
    issues: issues,
  };
};

export const getSegmentMetrics = async (segmentId: string) => {
  const metrics = await prisma.qualityMetric.findUnique({
    where: { segmentId },
  });
  if (!metrics) {
    throw ApiError.notFound('Metrics not found for segment');
  }
  return mapMetricRow(metrics);
};

export const getDocumentMetricsSummary = async (documentId: string) => {
  const [metrics, totalSegments, mtSegments] = await Promise.all([
    prisma.qualityMetric.findMany({
      where: { segment: { documentId } },
    }),
    prisma.segment.count({ where: { documentId } }),
    prisma.segment.count({ where: { documentId, NOT: { targetMt: null } } }),
  ]);

  const mapped = metrics.map(mapMetricRow);
  const summary = aggregateMetrics(mapped);

  return {
    documentId,
    totalSegments,
    mtCoverage: totalSegments === 0 ? 0 : mtSegments / totalSegments,
    avgEditDistancePercent: summary.avgEditDistancePercent,
    termAccuracyPercent: summary.termAccuracyPercent,
    qaErrors: summary.qaErrors,
    avgTimePerSegment: summary.avgTimePerSegment,
    totals: {
      mtWords: summary.totalMtWords,
      finalWords: summary.totalFinalWords,
    },
  };
};

export const getProjectMetricsSummary = async (projectId: string) => {
  const [metrics, totalSegments, mtSegments, totalDocuments] = await Promise.all([
    prisma.qualityMetric.findMany({
      where: { segment: { document: { projectId } } },
    }),
    prisma.segment.count({ where: { document: { projectId } } }),
    prisma.segment.count({ where: { document: { projectId }, NOT: { targetMt: null } } }),
    prisma.document.count({ where: { projectId } }),
  ]);

  const mapped = metrics.map(mapMetricRow);
  const summary = aggregateMetrics(mapped);

  return {
    projectId,
    totalDocuments,
    totalSegments,
    mtCoverage: totalSegments === 0 ? 0 : mtSegments / Math.max(1, totalSegments),
    avgEditDistancePercent: summary.avgEditDistancePercent,
    termAccuracyPercent: summary.termAccuracyPercent,
    qaErrors: summary.qaErrors,
    avgTimePerSegment: summary.avgTimePerSegment,
    totals: {
      mtWords: summary.totalMtWords,
      finalWords: summary.totalFinalWords,
    },
  };
};
