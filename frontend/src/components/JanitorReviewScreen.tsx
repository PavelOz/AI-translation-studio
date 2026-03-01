/**
 * JanitorReviewScreen: Экран просмотра результатов UniversalJanitor
 * 
 * Дизайн: Data Science Dashboard - чистый, информативный, без лишнего визуального шума
 */

import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { useParams, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import Layout from './Layout';
import { janitorApi, type JanitorReport, type SegmentAuditResult, type JanitorStatus } from '../api/janitor.api';
import { analysisApi } from '../api/analysis.api';
import { segmentsApi } from '../api/segments.api';
import { documentsApi } from '../api/documents.api';
import type { DocumentDnaPayload } from '../api/analysis.api';

interface JanitorReviewScreenProps {
  documentId?: string;
}

export default function JanitorReviewScreen({ documentId: propDocumentId }: JanitorReviewScreenProps) {
  const { documentId: paramDocumentId } = useParams<{ documentId: string }>();
  const documentId = propDocumentId || paramDocumentId;
  const queryClient = useQueryClient();

  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [isDnaPanelOpen, setIsDnaPanelOpen] = useState(true);
  const [statusFilter, setStatusFilter] = useState<JanitorStatus | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // Загружаем документ
  const { data: document } = useQuery({
    queryKey: ['documents', documentId],
    queryFn: () => documentsApi.get(documentId!),
    enabled: !!documentId,
  });

  // Загружаем отчет Janitor
  const { data: report, isLoading: isLoadingReport, refetch: refetchReport } = useQuery({
    queryKey: ['janitor-report', documentId],
    queryFn: () => janitorApi.getReport(documentId!),
    enabled: !!documentId,
    retry: false,
  });

  // Загружаем DNA для Inspector Panel
  const { data: dna } = useQuery({
    queryKey: ['document-dna', documentId],
    queryFn: () => analysisApi.getDocumentDna(documentId!),
    enabled: !!documentId && isDnaPanelOpen,
    retry: false,
  });

  // Запуск аудита
  const auditMutation = useMutation({
    mutationFn: (options?: { autoFix?: boolean; strictMode?: boolean }) =>
      janitorApi.auditSegments(documentId!, {
        autoFix: options?.autoFix ?? true,
        strictMode: options?.strictMode ?? true,
        dryRun: false,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries(['janitor-report', documentId]);
      toast.success('Audit completed successfully');
    },
    onError: (error: any) => {
      toast.error(error?.response?.data?.error || 'Failed to run audit');
    },
  });

  // Подтверждение сегмента
  const approveMutation = useMutation({
    mutationFn: ({ segmentId, fixedText }: { segmentId: string; fixedText?: string }) =>
      janitorApi.approveSegment(segmentId, fixedText),
    onSuccess: () => {
      queryClient.invalidateQueries(['janitor-report', documentId]);
      queryClient.invalidateQueries(['segments', documentId]);
      toast.success('Segment approved');
    },
    onError: () => {
      toast.error('Failed to approve segment');
    },
  });

  // Массовое подтверждение
  const bulkApproveMutation = useMutation({
    mutationFn: (segmentIds: string[]) => janitorApi.bulkApprove(segmentIds),
    onSuccess: (data) => {
      queryClient.invalidateQueries(['janitor-report', documentId]);
      queryClient.invalidateQueries(['segments', documentId]);
      toast.success(`${data.approved} segments approved`);
    },
    onError: () => {
      toast.error('Failed to approve segments');
    },
  });

  // Обновление сегмента
  const updateSegmentMutation = useMutation({
    mutationFn: ({ segmentId, targetFinal }: { segmentId: string; targetFinal: string }) =>
      segmentsApi.update(segmentId, { targetFinal }),
    onSuccess: () => {
      queryClient.invalidateQueries(['segments', documentId]);
      queryClient.invalidateQueries(['janitor-report', documentId]);
      toast.success('Segment updated');
    },
    onError: () => {
      toast.error('Failed to update segment');
    },
  });

  // Фильтрация сегментов
  const filteredSegments = useMemo(() => {
    if (!report?.segments) return [];

    let filtered = report.segments;

    // Фильтр по статусу
    if (statusFilter !== 'ALL') {
      filtered = filtered.filter(s => s.status === statusFilter);
    }

    // Поиск
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        s =>
          s.originalText.toLowerCase().includes(query) ||
          s.fixedText?.toLowerCase().includes(query) ||
          s.janitorComment?.toLowerCase().includes(query) ||
          s.errors.some(e => e.message.toLowerCase().includes(query)),
      );
    }

    return filtered;
  }, [report?.segments, statusFilter, searchQuery]);

  // Выбранный сегмент
  const selectedSegment = useMemo(() => {
    if (!selectedSegmentId || !report) return null;
    return report.segments.find(s => s.segmentId === selectedSegmentId);
  }, [selectedSegmentId, report]);

  if (!documentId) {
    return <div className="p-8 text-center text-gray-500">Document ID is required</div>;
  }

  return (
    <Layout>
      <div className="flex" style={{ height: 'calc(100vh - 64px)' }}>
      {/* Main Content */}
      <div className={`flex-1 flex flex-col transition-all duration-300 ${isDnaPanelOpen ? 'mr-80' : ''}`}>
        {/* Header */}
        <div className="bg-white border-b border-gray-200 px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <Link
                to={documentId ? `/documents/${documentId}` : '/projects'}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                ← Back to document
              </Link>
              <h1 className="text-2xl font-bold text-gray-900 mt-1">Janitor Review</h1>
              {document && (
                <p className="text-sm text-gray-500 mt-1">
                  {document.name} • {document.sourceLocale} → {document.targetLocale}
                </p>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => auditMutation.mutate({ autoFix: true, strictMode: true })}
                disabled={auditMutation.isLoading}
                className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {auditMutation.isLoading ? 'Running...' : 'Run Audit'}
              </button>
            </div>
          </div>
        </div>

        {/* Status Header Cards */}
        {report && (
          <div className="px-6 py-4 bg-white border-b border-gray-200">
            <StatusHeaderCards statistics={report.statistics} />
          </div>
        )}

        {/* Filters */}
        <div className="px-6 py-3 bg-white border-b border-gray-200 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Status:</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as JanitorStatus | 'ALL')}
              className="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="ALL">All</option>
              <option value="VALIDATED">Validated</option>
              <option value="AUTO_FIXED">Auto-fixed</option>
              <option value="REQUIRES_REVIEW">Requires Review</option>
            </select>
          </div>
          <div className="flex-1">
            <input
              type="text"
              placeholder="Search segments..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          {report && filteredSegments.length > 0 && statusFilter === 'REQUIRES_REVIEW' && (
            <button
              onClick={() => {
                const segmentIds = filteredSegments
                  .filter(s => s.status === 'REQUIRES_REVIEW')
                  .map(s => s.segmentId);
                bulkApproveMutation.mutate(segmentIds);
              }}
              disabled={bulkApproveMutation.isLoading}
              className="px-4 py-1.5 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 text-sm flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Approve All ({filteredSegments.length})
            </button>
          )}
        </div>

        {/* Segment List */}
        <div className="flex-1 overflow-y-auto">
          {isLoadingReport ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto"></div>
                <p className="mt-4 text-gray-500">Loading audit report...</p>
              </div>
            </div>
          ) : !report ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <p className="text-gray-500 mb-4">No audit report found</p>
                <button
                  onClick={() => auditMutation.mutate({ autoFix: true, strictMode: true })}
                  className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700"
                >
                  Run First Audit
                </button>
              </div>
            </div>
          ) : filteredSegments.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-gray-500">No segments match the current filters</p>
            </div>
          ) : (
            <div className="p-6 space-y-3">
              {filteredSegments.map((segment) => (
                <SegmentCard
                  key={segment.segmentId}
                  segment={segment}
                  isSelected={selectedSegmentId === segment.segmentId}
                  onSelect={() => setSelectedSegmentId(segment.segmentId)}
                  onApprove={(fixedText) => approveMutation.mutate({ segmentId: segment.segmentId, fixedText })}
                  onEdit={(targetFinal) => updateSegmentMutation.mutate({ segmentId: segment.segmentId, targetFinal })}
                  isApproving={approveMutation.isLoading && approveMutation.variables?.segmentId === segment.segmentId}
                  isUpdating={updateSegmentMutation.isLoading && updateSegmentMutation.variables?.segmentId === segment.segmentId}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* DNA Inspector Panel */}
      <DnaInspectorPanel
        isOpen={isDnaPanelOpen}
        onToggle={() => setIsDnaPanelOpen(!isDnaPanelOpen)}
        dna={dna || null}
        report={report || null}
      />
      </div>
    </Layout>
  );
}

/**
 * Status Header Cards
 */
function StatusHeaderCards({ statistics }: { statistics: JanitorReport['statistics'] }) {
  const stats = [
    {
      label: 'Total Segments',
      value: statistics.totalSegments,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      ),
      color: 'text-blue-600',
      bgColor: 'bg-blue-50',
    },
    {
      label: 'Requires Review',
      value: statistics.requiresReview,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      ),
      color: 'text-red-600',
      bgColor: 'bg-red-50',
    },
    {
      label: 'Auto-fixed',
      value: statistics.autoFixed,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ),
      color: 'text-amber-600',
      bgColor: 'bg-amber-50',
    },
    {
      label: 'Validated',
      value: statistics.validated,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      color: 'text-green-600',
      bgColor: 'bg-green-50',
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm hover:shadow-md transition-shadow"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{stat.label}</p>
              <p className="text-2xl font-bold text-gray-900 mt-1">{stat.value.toLocaleString()}</p>
            </div>
            <div className={`${stat.bgColor} ${stat.color} p-3 rounded-lg`}>
              {stat.icon}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Segment Card
 */
interface SegmentCardProps {
  segment: SegmentAuditResult;
  isSelected: boolean;
  onSelect: () => void;
  onApprove: (fixedText?: string) => void;
  onEdit: (targetFinal: string) => void;
  isApproving: boolean;
  isUpdating: boolean;
}

function SegmentCard({
  segment,
  isSelected,
  onSelect,
  onApprove,
  onEdit,
  isApproving,
  isUpdating,
}: SegmentCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(segment.fixedText || segment.originalText);

  const statusColors = {
    VALIDATED: 'bg-green-50 border-green-200',
    AUTO_FIXED: 'bg-amber-50 border-amber-200',
    REQUIRES_REVIEW: 'bg-red-50 border-red-200',
  };

  const statusBadges = {
    VALIDATED: (
      <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800 rounded-full">
        Validated
      </span>
    ),
    AUTO_FIXED: (
      <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 rounded-full">
        Auto-fixed
      </span>
    ),
    REQUIRES_REVIEW: (
      <span className="px-2 py-0.5 text-xs font-medium bg-red-100 text-red-800 rounded-full">
        Requires Review
      </span>
    ),
  };

  const handleSaveEdit = () => {
    onEdit(editText);
    setIsEditing(false);
  };

  return (
    <div
      className={`rounded-lg border-2 p-4 cursor-pointer transition-all ${
        statusColors[segment.status]
      } ${isSelected ? 'ring-2 ring-primary-500' : ''} hover:shadow-md`}
      onClick={onSelect}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-500">#{segment.segmentIndex}</span>
          {statusBadges[segment.status]}
        </div>
        <div className="flex items-center gap-2">
          {segment.status === 'REQUIRES_REVIEW' && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setIsEditing(true);
                }}
                className="px-3 py-1 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
              >
                Edit
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onApprove(segment.fixedText);
                }}
                disabled={isApproving}
                className="px-3 py-1 text-sm text-white bg-green-600 rounded-md hover:bg-green-700 disabled:opacity-50"
              >
                {isApproving ? 'Approving...' : 'Approve'}
              </button>
            </>
          )}
          {segment.status === 'AUTO_FIXED' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onApprove(segment.fixedText);
              }}
              disabled={isApproving}
              className="px-3 py-1 text-sm text-white bg-green-600 rounded-md hover:bg-green-700 disabled:opacity-50"
            >
              {isApproving ? 'Approving...' : 'Approve Fix'}
            </button>
          )}
        </div>
      </div>

      {isEditing ? (
        <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            rows={3}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={handleSaveEdit}
              disabled={isUpdating}
              className="px-3 py-1 text-sm text-white bg-primary-600 rounded-md hover:bg-primary-700 disabled:opacity-50"
            >
              {isUpdating ? 'Saving...' : 'Save'}
            </button>
            <button
              onClick={() => {
                setIsEditing(false);
                setEditText(segment.fixedText || segment.originalText);
              }}
              className="px-3 py-1 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-2">
            <p className="text-sm text-gray-600 mb-1">Original:</p>
            <p className="text-sm text-gray-900">{segment.originalText}</p>
          </div>
          {segment.fixedText && segment.fixedText !== segment.originalText && (
            <div className="mb-2">
              <p className="text-sm text-gray-600 mb-1">Fixed:</p>
              <p className="text-sm text-gray-900 bg-white px-2 py-1 rounded border border-gray-200">
                {segment.fixedText}
              </p>
            </div>
          )}
        </>
      )}

      {segment.janitorComment && (
        <div className="mt-2 p-2 bg-white rounded border border-gray-200">
          <p className="text-xs font-medium text-gray-700 mb-1">Janitor Comment:</p>
          <p className="text-xs text-gray-600">{segment.janitorComment}</p>
        </div>
      )}

      {segment.errors.length > 0 && (
        <div className="mt-2 space-y-1">
          {segment.errors.slice(0, 3).map((error, idx) => (
            <div key={idx} className="text-xs text-red-700 bg-red-50 px-2 py-1 rounded">
              <span className="font-medium">{error.type}:</span> {error.message}
            </div>
          ))}
          {segment.errors.length > 3 && (
            <p className="text-xs text-gray-500">+{segment.errors.length - 3} more errors</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * DNA Inspector Panel
 */
interface DnaInspectorPanelProps {
  isOpen: boolean;
  onToggle: () => void;
  dna: DocumentDnaPayload | null;
  report: JanitorReport | null;
}

function DnaInspectorPanel({ isOpen, onToggle, dna, report }: DnaInspectorPanelProps) {
  if (!isOpen) {
    return (
      <button
        onClick={onToggle}
        className="fixed right-0 top-1/2 -translate-y-1/2 bg-primary-600 text-white px-2 py-8 rounded-l-lg hover:bg-primary-700 transition-colors"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
    );
  }

  const abbreviationLogic = dna?.abbreviationLogic;
  const terms = abbreviationLogic && typeof abbreviationLogic === 'object'
    ? Object.entries(abbreviationLogic)
    : [];

  return (
    <div className="fixed right-0 top-0 h-screen w-80 bg-white border-l border-gray-200 shadow-xl flex flex-col z-50">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">DNA Inspector</h2>
        <button
          onClick={onToggle}
          className="p-1 text-gray-400 hover:text-gray-600 rounded"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {!dna ? (
          <div className="text-center text-gray-500 py-8">
            <p>No DNA available</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Statistics */}
            {report && (
              <div className="bg-gray-50 rounded-lg p-3">
                <h3 className="text-sm font-medium text-gray-700 mb-2">DNA Usage</h3>
                <div className="space-y-1 text-xs text-gray-600">
                  <div className="flex justify-between">
                    <span>Total Terms:</span>
                    <span className="font-medium">{report.dnaUsed.totalTerms}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Terms Checked:</span>
                    <span className="font-medium">{report.dnaUsed.termsChecked}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Validation Rules:</span>
                    <span className="font-medium">{report.dnaUsed.validationRules}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Glossary Terms */}
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-2">Glossary Terms</h3>
              {terms.length === 0 ? (
                <p className="text-xs text-gray-500">No terms available</p>
              ) : (
                <div className="space-y-2">
                  {terms.map(([key, value]) => {
                    let longForm = '';
                    let shortForm = '';
                    const aliases: string[] = [];

                    if (typeof value === 'string') {
                      longForm = value;
                      shortForm = value;
                    } else if (value && typeof value === 'object') {
                      const obj = value as Record<string, unknown>;
                      longForm = (obj.longForm as string) || (obj.value as string) || key;
                      shortForm = (obj.shortForm as string) || longForm;
                      if (Array.isArray(obj.aliases)) {
                        aliases.push(...(obj.aliases as string[]).filter(a => typeof a === 'string'));
                      }
                    }

                    return (
                      <div key={key} className="bg-gray-50 rounded p-2 text-xs">
                        <div className="font-medium text-gray-900 mb-1">{key}</div>
                        <div className="text-gray-600 space-y-0.5">
                          <div>Long: {longForm}</div>
                          {shortForm && shortForm !== longForm && <div>Short: {shortForm}</div>}
                          {aliases.length > 0 && (
                            <div>Aliases: {aliases.join(', ')}</div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Validation Hints */}
            {dna.validationHints && (
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-2">Validation Rules</h3>
                {dna.validationHints.rules && dna.validationHints.rules.length > 0 ? (
                  <div className="space-y-2">
                    {dna.validationHints.rules.map((rule, idx) => (
                      <div key={idx} className="bg-blue-50 rounded p-2 text-xs">
                        <div className="font-medium text-gray-900 mb-1">{rule.term}</div>
                        <div className="text-gray-600">{rule.rule}</div>
                        {rule.example && (
                          <div className="text-gray-500 mt-1 italic">Example: {rule.example}</div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-gray-500">No validation rules</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
