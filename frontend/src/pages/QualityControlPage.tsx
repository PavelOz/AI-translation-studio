import Layout from '../components/Layout';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { documentsApi, type ValidatorJanitorReport, type JanitorCounts } from '../api/documents.api';
import { analysisApi } from '../api/analysis.api';
import toast from 'react-hot-toast';
import ErrorLogExplorer from '../components/quality-control/ErrorLogExplorer';
import SpotCheckWizard from '../components/quality-control/SpotCheckWizard';
import DNAValidationHeader from '../components/quality-control/DNAValidationHeader';
import QualityStatsGrid from '../components/quality-control/QualityStatsGrid';
import QualityErrorsTable from '../components/quality-control/QualityErrorsTable';
import BatchProgress from '../components/quality-control/BatchProgress';

export default function QualityControlPage() {
  const { documentId } = useParams<{ documentId: string }>();
  const queryClient = useQueryClient();

  if (!documentId) {
    return (
      <Layout>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="rounded-lg border border-red-200 bg-red-50 p-4">
            <p className="text-sm font-medium text-red-800">Error</p>
            <p className="text-sm text-red-600 mt-1">Document ID is missing from URL.</p>
          </div>
        </div>
      </Layout>
    );
  }

  const { data: document, error: documentError } = useQuery({
    queryKey: ['documents', documentId],
    queryFn: () => documentsApi.get(documentId),
    enabled: !!documentId,
  });

  const runReportMutation = useMutation({
    mutationFn: (dryRun: boolean) =>
      documentsApi.runValidatorJanitor(documentId, { dryRun }),
    onSuccess: (report: ValidatorJanitorReport, dryRun: boolean) => {
      queryClient.setQueryData(['validator-janitor', documentId], report);
      toast.success(dryRun ? 'Report generated' : 'Validator-Janitor applied');
    },
    onError: (err: any) => {
      console.error('Error running validator-janitor:', err);
      toast.error(err.response?.data?.message || err.response?.data?.error || 'Validator-Janitor failed');
    },
  });

  const { 
    data: report, 
    isLoading: reportLoading,
    error: reportError,
    refetch: refetchReport 
  } = useQuery({
    queryKey: ['validator-janitor', documentId],
    queryFn: () => documentsApi.runValidatorJanitor(documentId, { dryRun: true }),
    enabled: !!documentId,
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
    onError: (err: any) => {
      console.error('Error loading validator-janitor report:', err);
    },
  });

  const { data: validation } = useQuery({
    queryKey: ['dna-validation', documentId],
    queryFn: () => analysisApi.validateDocumentDna(documentId),
    enabled: !!documentId,
    staleTime: 30_000,
  });

  const isLoading = runReportMutation.isPending || reportLoading;

  return (
    <Layout>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <Link
              to={documentId ? `/documents/${documentId}` : '/projects'}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              ← Back to document
            </Link>
            <h1 className="text-2xl font-bold text-gray-900 mt-1">
              Quality Control — {document?.name ?? documentId}
            </h1>
          </div>
          <div className="flex gap-2">
            {documentId && (
              <Link
                to={`/documents/${documentId}/janitor`}
                className="px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Janitor Review
              </Link>
            )}
            <button
              onClick={() => runReportMutation.mutate(true)}
              disabled={isLoading || !documentId}
              className="px-4 py-2 bg-gray-100 text-gray-800 rounded-md hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {runReportMutation.isPending && (
                <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              )}
              {runReportMutation.isPending ? 'Running…' : 'Refresh report'}
            </button>
            <button
              onClick={() => runReportMutation.mutate(false)}
              disabled={isLoading || !documentId}
              className="px-4 py-2 bg-primary-600 text-white rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {runReportMutation.isPending && (
                <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              )}
              Run & apply fixes
            </button>
          </div>
        </div>

        {documentError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4">
            <p className="text-sm font-medium text-red-800">Error loading document</p>
            <p className="text-sm text-red-600 mt-1">
              {(documentError as any)?.response?.data?.message || (documentError as any)?.message || 'Failed to load document'}
            </p>
          </div>
        )}

        {/* DNA Validation Header */}
        <DNAValidationHeader documentId={documentId} />

        {/* Stats Grid */}
        {report && (
          <QualityStatsGrid 
            report={report} 
            validation={validation}
          />
        )}

        {/* Batch Progress (shown during enrichment) */}
        {/* Note: This would need to be connected to enrichment progress state */}
        {/* <BatchProgress progress={enrichmentProgress} /> */}

        {report && (
          <>
            {/* Quality Errors Table with Add to DNA */}
            <QualityErrorsTable
              documentId={documentId}
              unfixable={report.unfixable || []}
            />

            {/* Legacy Components */}
            <div className="grid gap-6 lg:grid-cols-1">
              <ErrorLogExplorer
                documentId={documentId}
                unfixable={report.unfixable || []}
              />
              <SpotCheckWizard
                documentId={documentId}
                spotCheckSegmentIds={report.spotCheckSegmentIds || []}
              />
            </div>
          </>
        )}

        {reportError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4">
            <p className="text-sm font-medium text-red-800">Error loading report</p>
            <p className="text-sm text-red-600 mt-1">
              {(reportError as any)?.response?.data?.message || (reportError as any)?.message || 'Failed to load validator-janitor report'}
            </p>
            <button
              onClick={() => refetchReport()}
              className="mt-2 px-3 py-1 text-sm bg-red-100 text-red-800 rounded hover:bg-red-200"
            >
              Retry
            </button>
          </div>
        )}
        {!report && !isLoading && !reportError && documentId && (
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <p className="text-gray-500">No report data. Click "Refresh report" to generate one.</p>
          </div>
        )}
        {isLoading && !report && (
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <p className="text-gray-500">Loading report…</p>
            <p className="text-xs text-gray-400 mt-1">This may take a moment for large documents.</p>
          </div>
        )}
      </div>
    </Layout>
  );
}

function CountCards({
  counts,
  totalSegments,
}: {
  counts: JanitorCounts;
  totalSegments: number;
}) {
  // Ensure counts is always an object with default values
  const safeCounts = counts || {
    legalKeywordRemoved: 0,
    bracketDupRemoved: 0,
    spaceDupRemoved: 0,
    identityProtectionFixed: 0,
    forbiddenScriptSegments: 0,
    suspiciousAbbrevCount: 0,
  };
  
  const cards: { label: string; value: number; sub?: string }[] = [
    { label: 'Legal keyword removed', value: safeCounts.legalKeywordRemoved || 0 },
    { label: 'Bracket dup removed', value: safeCounts.bracketDupRemoved || 0 },
    { label: 'Space dup removed', value: safeCounts.spaceDupRemoved || 0 },
    { label: 'Glossary (identity) fixed', value: safeCounts.identityProtectionFixed || 0 },
    { label: 'Forbidden script', value: safeCounts.forbiddenScriptSegments || 0, sub: 'unfixable' },
    { label: 'Suspicious abbrev', value: safeCounts.suspiciousAbbrevCount || 0, sub: 'unfixable' },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
        <p className="text-xs font-medium text-gray-500 uppercase">Total segments</p>
        <p className="text-xl font-semibold text-gray-900">{totalSegments}</p>
      </div>
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm"
        >
          <p className="text-xs font-medium text-gray-500 uppercase truncate" title={c.label}>
            {c.label}
          </p>
          <p className="text-xl font-semibold text-gray-900">{c.value}</p>
          {c.sub && (
            <p className="text-xs text-amber-600">{c.sub}</p>
          )}
        </div>
      ))}
    </div>
  );
}
