import { useQuery, useMutation, useQueryClient } from 'react-query';
import { analysisApi, type DnaContractValidationResult } from '../../api/analysis.api';
import toast from 'react-hot-toast';
import { useState } from 'react';

type Props = {
  documentId: string;
};

export default function DNAValidationHeader({ documentId }: Props) {
  const queryClient = useQueryClient();
  const [enrichmentModalOpen, setEnrichmentModalOpen] = useState(false);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [useLLM, setUseLLM] = useState(true);
  const [llmProvider, setLlmProvider] = useState<'gemini' | 'openai' | 'yandex' | 'deepseek'>('gemini');

  const { data: validation, isLoading: validationLoading } = useQuery({
    queryKey: ['dna-validation', documentId],
    queryFn: () => analysisApi.validateDocumentDna(documentId),
    enabled: !!documentId,
    staleTime: 30_000,
  });

  const enrichMutation = useMutation({
    mutationFn: () => {
      if (!csvFile) throw new Error('CSV file is required');
      return analysisApi.enrichDocumentDnaFromCSV(documentId, csvFile, { useLLM, llmProvider });
    },
    onSuccess: (data) => {
      const added = data?.statistics?.added ?? 0;
      toast.success(`DNA enriched: ${added} entries added`);
      setEnrichmentModalOpen(false);
      setCsvFile(null);
      queryClient.invalidateQueries({ queryKey: ['dna-validation', documentId] });
      queryClient.invalidateQueries({ queryKey: ['document-dna', documentId] });
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.error || err?.message || 'Failed to enrich DNA');
    },
  });

  const contractValidation = validation?.contractValidation;
  const status = contractValidation?.status || 'UNKNOWN';
  const statusColor = 
    status === 'OK' ? 'bg-green-100 text-green-800 border-green-200' :
    status === 'WARNING' ? 'bg-amber-100 text-amber-800 border-amber-200' :
    status === 'ERROR' ? 'bg-red-100 text-red-800 border-red-200' :
    'bg-gray-100 text-gray-800 border-gray-200';

  return (
    <>
      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div>
              <h3 className="text-sm font-medium text-gray-700">DNA Validation Status</h3>
              {validationLoading ? (
                <p className="text-xs text-gray-500 mt-1">Loading...</p>
              ) : (
                <div className="flex items-center gap-2 mt-1">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${statusColor}`}>
                    {status}
                  </span>
                  {contractValidation && (
                    <span className="text-xs text-gray-500">
                      {contractValidation.issues.length} issue{contractValidation.issues.length !== 1 ? 's' : ''}
                    </span>
                  )}
                  {validation && (
                    <span className="text-xs text-gray-500">
                      {validation.abbreviationCount} rules
                    </span>
                  )}
                </div>
              )}
            </div>
            {contractValidation && contractValidation.issues.length > 0 && (
              <div className="text-xs text-gray-600">
                {contractValidation.issues.filter(i => i.type === 'error').length > 0 && (
                  <span className="text-red-600 font-medium">
                    {contractValidation.issues.filter(i => i.type === 'error').length} error{contractValidation.issues.filter(i => i.type === 'error').length !== 1 ? 's' : ''}
                  </span>
                )}
                {contractValidation.issues.filter(i => i.type === 'warning').length > 0 && (
                  <span className="text-amber-600 ml-2">
                    {contractValidation.issues.filter(i => i.type === 'warning').length} warning{contractValidation.issues.filter(i => i.type === 'warning').length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
            )}
          </div>
          <button
            onClick={() => setEnrichmentModalOpen(true)}
            className="px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Enrich from CSV
          </button>
        </div>
      </div>

      {enrichmentModalOpen && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50 flex justify-center items-center">
          <div className="bg-white p-6 rounded-lg shadow-xl max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4">Enrich Document DNA from CSV</h3>
            <div className="mb-4">
              <label htmlFor="csv-file" className="block text-sm font-medium text-gray-700 mb-1">
                Upload CSV File
              </label>
              <input
                type="file"
                id="csv-file"
                accept=".csv"
                onChange={(e) => setCsvFile(e.target.files ? e.target.files[0] : null)}
                className="mt-1 block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
              />
              {csvFile && <p className="mt-2 text-xs text-gray-500">Selected: {csvFile.name}</p>}
            </div>
            <div className="mb-4">
              <label htmlFor="use-llm" className="flex items-center text-sm font-medium text-gray-700">
                <input
                  type="checkbox"
                  id="use-llm"
                  checked={useLLM}
                  onChange={(e) => setUseLLM(e.target.checked)}
                  className="h-4 w-4 text-blue-600 border-gray-300 rounded"
                />
                <span className="ml-2">Use LLM for translation (if English long form is missing)</span>
              </label>
            </div>
            {useLLM && (
              <div className="mb-4">
                <label htmlFor="llm-provider" className="block text-sm font-medium text-gray-700 mb-1">
                  LLM Provider
                </label>
                <select
                  id="llm-provider"
                  value={llmProvider}
                  onChange={(e) => setLlmProvider(e.target.value as any)}
                  className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm rounded-md"
                >
                  <option value="gemini">Gemini</option>
                  <option value="openai">OpenAI</option>
                  <option value="yandex">Yandex</option>
                  <option value="deepseek">DeepSeek</option>
                </select>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEnrichmentModalOpen(false)}
                className="px-4 py-2 bg-gray-100 text-gray-800 text-sm font-medium rounded-md hover:bg-gray-200 disabled:opacity-50"
                disabled={enrichMutation.isPending}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => enrichMutation.mutate()}
                className="px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                disabled={!csvFile || enrichMutation.isPending || (useLLM && !llmProvider)}
              >
                {enrichMutation.isPending && (
                  <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                )}
                {enrichMutation.isPending ? 'Enriching...' : 'Enrich'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
