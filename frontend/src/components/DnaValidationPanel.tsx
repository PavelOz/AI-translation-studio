import { useQuery } from 'react-query';
import { analysisApi } from '../api/analysis.api';

type Props = {
  documentId: string;
};

export default function DnaValidationPanel({ documentId }: Props) {
  const { data: validation, isLoading, refetch } = useQuery({
    queryKey: ['dna-validation', documentId],
    queryFn: () => analysisApi.validateDocumentDna(documentId),
    enabled: !!documentId,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="mt-3 p-2 bg-gray-50 border border-gray-200 rounded text-xs">
        <p className="text-gray-600">Validating DNA...</p>
      </div>
    );
  }

  if (!validation) {
    return null;
  }

  const contractValidation = validation.contractValidation;

  if (!contractValidation) {
    // Базовая валидация
    if (!validation.valid) {
      return (
        <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded text-xs">
          <div className="flex items-start justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-red-600 font-semibold">✗ Validation Failed</span>
            </div>
            <button
              onClick={() => refetch()}
              className="text-red-600 hover:text-red-800 underline"
            >
              Refresh
            </button>
          </div>
          <ul className="list-disc list-inside space-y-1 text-red-700">
            {validation.errors.map((error, i) => (
              <li key={i}>{error}</li>
            ))}
          </ul>
        </div>
      );
    }
    return (
      <div className="mt-3 p-2 bg-green-50 border border-green-200 rounded text-xs">
        <div className="flex items-center justify-between">
          <span className="text-green-700 font-medium">✓ DNA is valid</span>
          <button
            onClick={() => refetch()}
            className="text-green-600 hover:text-green-800 underline"
          >
            Refresh
          </button>
        </div>
        <p className="text-green-600 mt-1">
          {validation.abbreviationCount} abbreviation{validation.abbreviationCount !== 1 ? 's' : ''} defined
        </p>
      </div>
    );
  }

  // Расширенная валидация (DNA-Contract-Validator)
  const errors = contractValidation.issues.filter(i => i.type === 'error');
  const warnings = contractValidation.issues.filter(i => i.type === 'warning');

  return (
    <div className="mt-3 space-y-2">
      {/* Статус валидации */}
      <div
        className={`p-3 rounded border ${
          contractValidation.status === 'ERROR'
            ? 'bg-red-50 border-red-200'
            : contractValidation.status === 'WARNING'
              ? 'bg-amber-50 border-amber-200'
              : 'bg-green-50 border-green-200'
        }`}
      >
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2">
            {contractValidation.status === 'ERROR' && (
              <span className="text-red-600 font-semibold">✗ Validation Failed</span>
            )}
            {contractValidation.status === 'WARNING' && (
              <span className="text-amber-700 font-semibold">⚠ Validation Warnings</span>
            )}
            {contractValidation.status === 'OK' && (
              <span className="text-green-700 font-semibold">✓ All Checks Passed</span>
            )}
          </div>
          <button
            onClick={() => refetch()}
            className={`text-xs underline ${
              contractValidation.status === 'ERROR'
                ? 'text-red-600 hover:text-red-800'
                : contractValidation.status === 'WARNING'
                  ? 'text-amber-600 hover:text-amber-800'
                  : 'text-green-600 hover:text-green-800'
            }`}
          >
            Refresh
          </button>
        </div>

        {/* Ошибки */}
        {errors.length > 0 && (
          <div className="mb-3">
            <p className="text-xs font-medium text-red-800 mb-1">Errors (blocking translation):</p>
            <ul className="space-y-1">
              {errors.map((error, i) => (
                <li key={i} className="text-xs text-red-700">
                  <div className="flex items-start gap-1">
                    <span className="text-red-500 mt-0.5">•</span>
                    <div className="flex-1">
                      <p>{error.message}</p>
                      {error.suggestion && (
                        <p className="text-red-600 mt-0.5 italic">→ {error.suggestion}</p>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Предупреждения */}
        {warnings.length > 0 && (
          <div className="mb-3">
            <p className="text-xs font-medium text-amber-800 mb-1">Warnings (recommended fixes):</p>
            <ul className="space-y-1">
              {warnings.map((warning, i) => (
                <li key={i} className="text-xs text-amber-700">
                  <div className="flex items-start gap-1">
                    <span className="text-amber-500 mt-0.5">•</span>
                    <div className="flex-1">
                      <p>{warning.message}</p>
                      {warning.suggestion && (
                        <p className="text-amber-600 mt-0.5 italic">→ {warning.suggestion}</p>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Успешная валидация */}
        {contractValidation.status === 'OK' && (
          <p className="text-green-700 text-xs">
            All validation checks passed. DNA is ready for translation.
          </p>
        )}

        {/* Рекомендации */}
        {contractValidation.suggestions.length > 0 && (
          <details className="mt-2">
            <summary className="text-xs font-medium cursor-pointer text-gray-700 hover:text-gray-900">
              View all suggestions ({contractValidation.suggestions.length})
            </summary>
            <ul className="mt-2 space-y-1 pl-4">
              {contractValidation.suggestions.map((suggestion, i) => (
                <li key={i} className="text-xs text-gray-600">• {suggestion}</li>
              ))}
            </ul>
          </details>
        )}

        {/* Детальный отчет */}
        <details className="mt-2">
          <summary className="text-xs font-medium cursor-pointer text-gray-700 hover:text-gray-900">
            View detailed report
          </summary>
          <pre className="mt-2 p-2 bg-white border border-gray-200 rounded text-xs font-mono whitespace-pre-wrap overflow-auto max-h-48">
            {contractValidation.report}
          </pre>
        </details>
      </div>
    </div>
  );
}
