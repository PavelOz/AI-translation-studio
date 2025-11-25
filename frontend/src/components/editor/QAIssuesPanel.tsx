import { useQuery } from 'react-query';
import { qualityApi } from '../../api/quality.api';
import type { QAIssue } from '../../api/quality.api';

interface QAIssuesPanelProps {
  segmentId: string;
}

export default function QAIssuesPanel({ segmentId }: QAIssuesPanelProps) {
  const { data: qaResult, isLoading } = useQuery({
    queryKey: ['qa', segmentId],
    queryFn: () => qualityApi.runSegmentCheck(segmentId),
    enabled: !!segmentId,
  });

  if (isLoading) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h3 className="font-semibold text-gray-900 mb-3">Quality Assurance</h3>
        <div className="text-sm text-gray-500">Checking...</div>
      </div>
    );
  }

  if (!qaResult || qaResult.issues.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h3 className="font-semibold text-gray-900 mb-3">Quality Assurance</h3>
        <div className="text-sm text-green-600">✓ No issues found</div>
      </div>
    );
  }

  const getSeverityColor = (severity: QAIssue['severity']) => {
    switch (severity) {
      case 'error':
        return 'text-red-600 bg-red-50 border-red-200';
      case 'warning':
        return 'text-yellow-600 bg-yellow-50 border-yellow-200';
      default:
        return 'text-blue-600 bg-blue-50 border-blue-200';
    }
  };

  const getCategoryIcon = (category: QAIssue['category']) => {
    switch (category) {
      case 'terminology':
        return '📝';
      case 'format':
        return '🔢';
      case 'tags':
        return '🏷️';
      case 'consistency':
        return '🔄';
      default:
        return 'ℹ️';
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h3 className="font-semibold text-gray-900 mb-3">
        Quality Assurance ({qaResult.issues.length} issue{qaResult.issues.length !== 1 ? 's' : ''})
      </h3>
      <div className="space-y-2">
        {qaResult.issues.map((issue, index) => (
          <div
            key={index}
            className={`border rounded p-2 ${getSeverityColor(issue.severity)}`}
          >
            <div className="flex items-start">
              <span className="mr-2">{getCategoryIcon(issue.category)}</span>
              <div className="flex-1">
                <div className="text-sm font-medium">{issue.message}</div>
                <div className="text-xs mt-1 opacity-75">
                  {issue.category} • {issue.severity}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}



