import { useParams, Link } from 'react-router-dom';
import { useQuery } from 'react-query';
import Layout from '../components/Layout';
import { reportsApi } from '../api/reports.api';
import StatCard from '../components/dashboard/StatCard';
import MetricsChart from '../components/dashboard/MetricsChart';

export default function UserReportPage() {
  const { userId } = useParams<{ userId: string }>();

  const { data: report, isLoading } = useQuery({
    queryKey: ['reports', 'user', userId],
    queryFn: () => reportsApi.getUserReport(userId!),
    enabled: !!userId,
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

  const errorProfileData = [
    { name: 'Terminology', value: report.errorProfile.term },
    { name: 'Format', value: report.errorProfile.format },
    { name: 'Consistency', value: report.errorProfile.consistency },
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
            <h1 className="text-3xl font-bold text-gray-900">{report.user.name}</h1>
            <p className="text-gray-600 mt-2">
              {report.user.email} • {report.user.role}
            </p>
          </div>
        </div>

        {/* Statistics Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <StatCard
            title="Segments Confirmed"
            value={report.totals.segments.toLocaleString()}
            subtitle="Total translations"
            icon="✓"
          />
          <StatCard
            title="Words Translated"
            value={report.totals.words.toLocaleString()}
            subtitle="Total words"
            icon="📝"
          />
          <StatCard
            title="Avg Edit Distance"
            value={`${report.totals.avgEditDistance.toFixed(1)} chars`}
            subtitle="MT vs Final"
            icon="📏"
          />
          <StatCard
            title="Avg Time/Segment"
            value={`${(report.totals.avgTimePerSegment / 60).toFixed(1)} min`}
            subtitle="Processing time"
            icon="⏱️"
          />
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <MetricsChart
            data={errorProfileData}
            type="bar"
            title="Error Profile"
          />
          <MetricsChart
            data={errorProfileData}
            type="pie"
            title="Error Distribution"
          />
        </div>

        {/* Detailed Metrics */}
        <div className="card">
          <h2 className="text-xl font-semibold mb-4">Performance Summary</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h3 className="font-medium text-gray-900 mb-3">Translation Statistics</h3>
              <dl className="space-y-2">
                <div className="flex justify-between">
                  <dt className="text-sm text-gray-600">Total Segments:</dt>
                  <dd className="text-sm font-medium">{report.totals.segments.toLocaleString()}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-sm text-gray-600">Total Words:</dt>
                  <dd className="text-sm font-medium">{report.totals.words.toLocaleString()}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-sm text-gray-600">Avg Words/Segment:</dt>
                  <dd className="text-sm font-medium">
                    {report.totals.segments > 0
                      ? (report.totals.words / report.totals.segments).toFixed(1)
                      : 0}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-sm text-gray-600">Avg Edit Distance:</dt>
                  <dd className="text-sm font-medium">{report.totals.avgEditDistance.toFixed(1)} chars</dd>
                </div>
              </dl>
            </div>
            <div>
              <h3 className="font-medium text-gray-900 mb-3">Quality Metrics</h3>
              <dl className="space-y-2">
                <div className="flex justify-between">
                  <dt className="text-sm text-gray-600">Term Errors:</dt>
                  <dd className="text-sm font-medium">{report.errorProfile.term}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-sm text-gray-600">Format Errors:</dt>
                  <dd className="text-sm font-medium">{report.errorProfile.format}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-sm text-gray-600">Consistency Errors:</dt>
                  <dd className="text-sm font-medium">{report.errorProfile.consistency}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-sm text-gray-600">Total Errors:</dt>
                  <dd className="text-sm font-medium">
                    {report.errorProfile.term +
                      report.errorProfile.format +
                      report.errorProfile.consistency}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-sm text-gray-600">Avg Time/Segment:</dt>
                  <dd className="text-sm font-medium">
                    {(report.totals.avgTimePerSegment / 60).toFixed(1)} minutes
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



