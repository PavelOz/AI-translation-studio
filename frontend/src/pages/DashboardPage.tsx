import { useState } from 'react';
import { useQuery } from 'react-query';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout';
import { useProjects } from '../hooks/useProjects';
import { reportsApi } from '../api/reports.api';
import StatCard from '../components/dashboard/StatCard';
import MetricsChart from '../components/dashboard/MetricsChart';
import type { ReportFilters } from '../api/reports.api';

export default function DashboardPage() {
  const { projects, isLoading: projectsLoading } = useProjects();
  const [filters, setFilters] = useState<ReportFilters>({});

  const { data: reportsData, isLoading: reportsLoading } = useQuery({
    queryKey: ['reports', 'overview', filters],
    queryFn: () => reportsApi.getProjectsOverview(filters),
  });

  const isLoading = projectsLoading || reportsLoading;

  // Calculate aggregate statistics
  const stats = reportsData
    ? {
        totalProjects: reportsData.length,
        totalDocuments: reportsData.reduce((acc, p) => acc + p.documents, 0),
        totalSegments: reportsData.reduce((acc, p) => acc + p.metrics.totalSegments, 0),
        avgMTCoverage:
          reportsData.length > 0
            ? reportsData.reduce((acc, p) => acc + p.metrics.mtCoverage, 0) / reportsData.length
            : 0,
        avgTermAccuracy:
          reportsData.length > 0
            ? reportsData.reduce((acc, p) => acc + p.metrics.termAccuracyPercent, 0) / reportsData.length
            : 0,
        totalQaErrors: reportsData.reduce(
          (acc, p) =>
            acc + p.metrics.qaErrors.term + p.metrics.qaErrors.format + p.metrics.qaErrors.consistency,
          0,
        ),
      }
    : null;

  // Prepare chart data
  const statusDistribution = reportsData
    ? [
        {
          name: 'Completed',
          value: reportsData.filter((p) => p.metrics.totalSegments > 0 && p.metrics.mtCoverage > 0.9).length,
        },
        {
          name: 'In Progress',
          value: reportsData.filter(
            (p) => p.metrics.totalSegments > 0 && p.metrics.mtCoverage > 0 && p.metrics.mtCoverage < 0.9,
          ).length,
        },
        {
          name: 'New',
          value: reportsData.filter((p) => p.metrics.mtCoverage === 0).length,
        },
      ]
    : [];

  const qaErrorsData = stats
    ? [
        { name: 'Terminology', value: reportsData!.reduce((acc, p) => acc + p.metrics.qaErrors.term, 0) },
        { name: 'Format', value: reportsData!.reduce((acc, p) => acc + p.metrics.qaErrors.format, 0) },
        { name: 'Consistency', value: reportsData!.reduce((acc, p) => acc + p.metrics.qaErrors.consistency, 0) },
      ]
    : [];

  if (isLoading) {
    return (
      <Layout>
        <div className="text-center py-12">Loading dashboard...</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex justify-between items-center">
          <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
          <Link to="/projects" className="btn btn-primary">
            View All Projects
          </Link>
        </div>

        {/* Filters */}
        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Filters</h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Client</label>
              <input
                type="text"
                value={filters.client || ''}
                onChange={(e) => setFilters({ ...filters, client: e.target.value || undefined })}
                className="input"
                placeholder="Filter by client..."
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Domain</label>
              <input
                type="text"
                value={filters.domain || ''}
                onChange={(e) => setFilters({ ...filters, domain: e.target.value || undefined })}
                className="input"
                placeholder="Filter by domain..."
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Date From</label>
              <input
                type="date"
                value={filters.dateFrom || ''}
                onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value || undefined })}
                className="input"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Date To</label>
              <input
                type="date"
                value={filters.dateTo || ''}
                onChange={(e) => setFilters({ ...filters, dateTo: e.target.value || undefined })}
                className="input"
              />
            </div>
          </div>
        </div>

        {/* Statistics Cards */}
        {stats && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <StatCard
              title="Total Projects"
              value={stats.totalProjects}
              subtitle={`${projects.length} active`}
              icon="📁"
            />
            <StatCard
              title="Total Documents"
              value={stats.totalDocuments}
              subtitle="Across all projects"
              icon="📄"
            />
            <StatCard
              title="Total Segments"
              value={stats.totalSegments.toLocaleString()}
              subtitle="Translation units"
              icon="📝"
            />
            <StatCard
              title="Avg MT Coverage"
              value={`${(stats.avgMTCoverage * 100).toFixed(1)}%`}
              subtitle="Machine translation"
              icon="🤖"
            />
            <StatCard
              title="Avg Term Accuracy"
              value={`${stats.avgTermAccuracy.toFixed(1)}%`}
              subtitle="Glossary compliance"
              icon="✓"
            />
            <StatCard
              title="QA Errors"
              value={stats.totalQaErrors}
              subtitle="Total issues found"
              icon="⚠️"
            />
          </div>
        )}

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <MetricsChart
            data={statusDistribution}
            type="pie"
            title="Project Status Distribution"
          />
          <MetricsChart
            data={qaErrorsData}
            type="bar"
            title="QA Errors by Category"
          />
        </div>

        {/* Recent Projects */}
        <div className="card">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold">Recent Projects</h2>
            <Link to="/projects" className="text-primary-600 hover:text-primary-700 text-sm">
              View all →
            </Link>
          </div>
          {reportsData && reportsData.length > 0 ? (
            <div className="space-y-4">
              {reportsData.slice(0, 5).map((project) => (
                <Link
                  key={project.id}
                  to={`/reports/projects/${project.id}`}
                  className="block border border-gray-200 rounded-lg p-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="font-semibold text-gray-900">{project.name}</h3>
                      <p className="text-sm text-gray-600 mt-1">
                        {project.clientName && `${project.clientName} • `}
                        {project.domain && `${project.domain} • `}
                        {project.documents} document{project.documents !== 1 ? 's' : ''}
                      </p>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-medium text-gray-900">
                        {project.metrics.totalSegments} segments
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        MT: {(project.metrics.mtCoverage * 100).toFixed(1)}% • Accuracy:{' '}
                        {project.metrics.termAccuracyPercent.toFixed(1)}%
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500">No projects found</div>
          )}
        </div>
      </div>
    </Layout>
  );
}
