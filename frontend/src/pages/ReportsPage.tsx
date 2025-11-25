import { useState } from 'react';
import { useQuery } from 'react-query';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout';
import { reportsApi } from '../api/reports.api';
import type { ReportFilters } from '../api/reports.api';

export default function ReportsPage() {
  const [filters, setFilters] = useState<ReportFilters>({});

  const { data: reportsData, isLoading } = useQuery({
    queryKey: ['reports', 'overview', filters],
    queryFn: () => reportsApi.getProjectsOverview(filters),
  });

  if (isLoading) {
    return (
      <Layout>
        <div className="text-center py-12">Loading reports...</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex justify-between items-center">
          <h1 className="text-3xl font-bold text-gray-900">Reports</h1>
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

        {/* Reports List */}
        <div className="card">
          <h2 className="text-xl font-semibold mb-4">Project Reports</h2>
          {reportsData && reportsData.length > 0 ? (
            <div className="space-y-4">
              {reportsData.map((project) => (
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
            <div className="text-center py-8 text-gray-500">No reports found</div>
          )}
        </div>
      </div>
    </Layout>
  );
}



