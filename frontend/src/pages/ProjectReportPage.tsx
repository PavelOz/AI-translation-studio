import { useParams, Link } from 'react-router-dom';
import { useQuery } from 'react-query';
import Layout from '../components/Layout';
import { reportsApi } from '../api/reports.api';
import StatCard from '../components/dashboard/StatCard';
import MetricsChart from '../components/dashboard/MetricsChart';
import { getLanguageName } from '../utils/languages';

export default function ProjectReportPage() {
  const { projectId } = useParams<{ projectId: string }>();

  const { data: report, isLoading } = useQuery({
    queryKey: ['reports', 'project', projectId],
    queryFn: () => reportsApi.getProjectReport(projectId!),
    enabled: !!projectId,
  });

  if (isLoading) {
    return (
      <Layout>
        <div className="text-center py-12">Loading report...</div>
      </Layout>
    );
  }

  if (!report) {
    return (
      <Layout>
        <div className="text-center py-12">Report not found</div>
      </Layout>
    );
  }

  const metrics = report.metrics;
  const completionRate = metrics.totalSegments > 0 
    ? ((metrics.totals.finalWords / metrics.totalSegments) * 100) 
    : 0;

  const qaErrorsData = [
    { name: 'Terminology', value: metrics.qaErrors.term },
    { name: 'Format', value: metrics.qaErrors.format },
    { name: 'Consistency', value: metrics.qaErrors.consistency },
  ];

  const segmentStatusData = [
    { name: 'MT Words', value: metrics.totals.mtWords },
    { name: 'Final Words', value: metrics.totals.finalWords },
  ];

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex justify-between items-start">
          <div>
            <Link to="/dashboard" className="text-primary-600 hover:text-primary-700 text-sm mb-2 inline-block">
              ← Back to Dashboard
            </Link>
            <h1 className="text-3xl font-bold text-gray-900">{report.project.name}</h1>
            <p className="text-gray-600 mt-2">
              {report.project.clientName && `${report.project.clientName} • `}
              {report.project.domain && `${report.project.domain} • `}
              {getLanguageName(report.project.sourceLang || report.project.sourceLocale)} → {getLanguageName(report.project.targetLang || report.project.targetLocales?.[0])}
            </p>
          </div>
          <Link
            to={`/projects/${projectId}`}
            className="btn btn-secondary"
          >
            View Project
          </Link>
        </div>

        {/* Statistics Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <StatCard
            title="Total Documents"
            value={report.project.documents}
            icon="📄"
          />
          <StatCard
            title="Total Segments"
            value={metrics.totalSegments.toLocaleString()}
            subtitle="Translation units"
            icon="📝"
          />
          <StatCard
            title="Total Words"
            value={report.totals.words.toLocaleString()}
            icon="📊"
          />
          <StatCard
            title="MT Coverage"
            value={`${(metrics.mtCoverage * 100).toFixed(1)}%`}
            subtitle="Machine translated"
            icon="🤖"
          />
          <StatCard
            title="Term Accuracy"
            value={`${metrics.termAccuracyPercent.toFixed(1)}%`}
            subtitle="Glossary compliance"
            icon="✓"
          />
          <StatCard
            title="Avg Edit Distance"
            value={`${metrics.avgEditDistancePercent.toFixed(1)}%`}
            subtitle="MT vs Final"
            icon="📏"
          />
          <StatCard
            title="Avg Time/Segment"
            value={`${(metrics.avgTimePerSegment / 60).toFixed(1)} min`}
            subtitle="Average processing time"
            icon="⏱️"
          />
          <StatCard
            title="QA Errors"
            value={metrics.qaErrors.term + metrics.qaErrors.format + metrics.qaErrors.consistency}
            subtitle="Total issues"
            icon="⚠️"
          />
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <MetricsChart
            data={qaErrorsData}
            type="bar"
            title="QA Errors by Category"
          />
          <MetricsChart
            data={segmentStatusData}
            type="pie"
            title="Word Distribution"
          />
        </div>

        {/* Detailed Metrics */}
        <div className="card">
          <h2 className="text-xl font-semibold mb-4">Detailed Metrics</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h3 className="font-medium text-gray-900 mb-3">Translation Statistics</h3>
              <dl className="space-y-2">
                <div className="flex justify-between">
                  <dt className="text-sm text-gray-600">MT Words:</dt>
                  <dd className="text-sm font-medium">{metrics.totals.mtWords.toLocaleString()}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-sm text-gray-600">Final Words:</dt>
                  <dd className="text-sm font-medium">{metrics.totals.finalWords.toLocaleString()}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-sm text-gray-600">MT Coverage:</dt>
                  <dd className="text-sm font-medium">{(metrics.mtCoverage * 100).toFixed(1)}%</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-sm text-gray-600">Avg Edit Distance:</dt>
                  <dd className="text-sm font-medium">{metrics.avgEditDistancePercent.toFixed(1)}%</dd>
                </div>
              </dl>
            </div>
            <div>
              <h3 className="font-medium text-gray-900 mb-3">Quality Metrics</h3>
              <dl className="space-y-2">
                <div className="flex justify-between">
                  <dt className="text-sm text-gray-600">Term Accuracy:</dt>
                  <dd className="text-sm font-medium">{metrics.termAccuracyPercent.toFixed(1)}%</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-sm text-gray-600">Term Errors:</dt>
                  <dd className="text-sm font-medium">{metrics.qaErrors.term}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-sm text-gray-600">Format Errors:</dt>
                  <dd className="text-sm font-medium">{metrics.qaErrors.format}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-sm text-gray-600">Consistency Errors:</dt>
                  <dd className="text-sm font-medium">{metrics.qaErrors.consistency}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-sm text-gray-600">Avg Time/Segment:</dt>
                  <dd className="text-sm font-medium">
                    {(metrics.avgTimePerSegment / 60).toFixed(1)} minutes
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}

