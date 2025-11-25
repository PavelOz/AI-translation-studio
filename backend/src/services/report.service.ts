import type { Prisma, ReportType } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../utils/apiError';
import { getProjectMetricsSummary } from './quality.service';

export const generateProjectReport = async (projectId: string, type: ReportType) => {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { documents: { include: { segments: true } } },
  });
  if (!project) {
    throw ApiError.notFound('Project not found');
  }

  const totalSegments = project.documents.reduce((acc, doc) => acc + doc.segments.length, 0);
  const completedSegments = project.documents.reduce(
    (acc, doc) => acc + doc.segments.filter((seg) => seg.status === 'CONFIRMED').length,
    0,
  );

  const payload = {
    type,
    totalDocuments: project.documents.length,
    totalSegments,
    completedSegments,
    completionRate: totalSegments === 0 ? 0 : completedSegments / totalSegments,
  };

  return prisma.report.create({
    data: {
      projectId,
      type,
      payload,
    },
  });
};

export const getReport = async (reportId: string) => {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) {
    throw ApiError.notFound('Report not found');
  }
  return report;
};

export const listReports = async (projectId?: string) => {
  return prisma.report.findMany({
    where: projectId ? { projectId } : undefined,
    orderBy: { createdAt: 'desc' },
    include: { project: { select: { id: true, name: true } } },
  });
};

export const deleteReport = async (reportId: string) => {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) {
    throw ApiError.notFound('Report not found');
  }
  return prisma.report.delete({ where: { id: reportId } });
};

type ProjectReportFilters = {
  client?: string;
  domain?: string;
  dateFrom?: Date;
  dateTo?: Date;
};

export const getProjectReportsOverview = async (filters: ProjectReportFilters) => {
  const where: Prisma.ProjectWhereInput = {};
  if (filters.client) {
    where.clientName = { contains: filters.client, mode: 'insensitive' };
  }
  if (filters.domain) {
    where.domain = { equals: filters.domain, mode: 'insensitive' };
  }
  if (filters.dateFrom || filters.dateTo) {
    where.createdAt = {} as Prisma.DateTimeFilter;
    if (filters.dateFrom) {
      where.createdAt.gte = filters.dateFrom;
    }
    if (filters.dateTo) {
      where.createdAt.lte = filters.dateTo;
    }
  }

  const projects = await prisma.project.findMany({
    where,
    include: { documents: true },
    orderBy: { createdAt: 'desc' },
  });

  const summaries = await Promise.all(projects.map((project) => getProjectMetricsSummary(project.id)));

  return projects.map((project, index) => ({
    id: project.id,
    name: project.name,
    clientName: project.clientName,
    domain: project.domain,
    documents: project.documents.length,
    metrics: summaries[index],
  }));
};

export const getProjectPerformanceReport = async (projectId: string) => {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { documents: true },
  });
  if (!project) {
    throw ApiError.notFound('Project not found');
  }

  const metrics = await getProjectMetricsSummary(projectId);
  const totalWords = project.documents.reduce((acc, doc) => acc + (doc.totalWords ?? doc.wordCount), 0);

  return {
    project: {
      id: project.id,
      name: project.name,
      clientName: project.clientName,
      domain: project.domain,
      sourceLang: project.sourceLang ?? project.sourceLocale,
      targetLang: project.targetLang ?? project.targetLocales[0],
      documents: project.documents.length,
    },
    totals: {
      words: totalWords,
    },
    metrics,
  };
};

export const getUserPerformanceReport = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, role: true },
  });
  if (!user) {
    throw ApiError.notFound('User not found');
  }

  const segments = await prisma.segment.findMany({
    where: { confirmedById: userId },
    select: { id: true, targetFinal: true, targetMt: true },
  });
  const metrics = await prisma.qualityMetric.findMany({
    where: { segment: { confirmedById: userId } },
  });

  const totalWords = segments.reduce((acc, segment) => acc + (segment.targetFinal?.split(/\s+/).filter(Boolean).length ?? 0), 0);
  const avgEditDistance =
    metrics.length === 0
      ? 0
      : metrics.reduce((acc, metric) => acc + metric.editDistanceChars, 0) / metrics.length;

  const errorProfile = metrics.reduce(
    (acc, metric) => {
      acc.term += metric.termErrors;
      acc.format += metric.formatErrors;
      acc.consistency += metric.consistencyErrors;
      return acc;
    },
    { term: 0, format: 0, consistency: 0 },
  );

  const timeSpent =
    metrics.reduce((acc, metric) => acc + metric.timeSpentSeconds, 0) / (segments.length || 1);

  return {
    user,
    totals: {
      segments: segments.length,
      words: totalWords,
      avgEditDistance,
      avgTimePerSegment: timeSpent,
    },
    errorProfile,
  };
};

