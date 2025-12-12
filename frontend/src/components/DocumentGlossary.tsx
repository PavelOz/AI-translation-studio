import { useState } from 'react';
import { useDocumentGlossary } from '../hooks/useDocumentGlossary';

interface DocumentGlossaryProps {
  documentId: string;
}

export default function DocumentGlossary({ documentId }: DocumentGlossaryProps) {
  const { data: glossaryEntries, isLoading, error } = useDocumentGlossary(documentId);
  const [sortBy, setSortBy] = useState<'source' | 'target'>('source');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  // Sort entries
  const sortedEntries = glossaryEntries
    ? [...glossaryEntries].sort((a, b) => {
        const aValue = sortBy === 'source' ? a.sourceTerm.toLowerCase() : a.targetTerm.toLowerCase();
        const bValue = sortBy === 'target' ? b.targetTerm.toLowerCase() : b.targetTerm.toLowerCase();
        
        if (sortOrder === 'asc') {
          return aValue.localeCompare(bValue);
        } else {
          return bValue.localeCompare(aValue);
        }
      })
    : [];

  const handleSort = (column: 'source' | 'target') => {
    if (sortBy === column) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(column);
      setSortOrder('asc');
    }
  };

  if (error) {
    return (
      <div className="bg-white rounded-lg shadow p-4">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Document Glossary</h3>
        <div className="text-sm text-red-600">
          Failed to load glossary: {(error as Error).message}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Document Glossary</h3>
        {glossaryEntries && (
          <span className="text-sm text-gray-500">
            {glossaryEntries.length} term{glossaryEntries.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-200 border-t-primary-600"></div>
        </div>
      ) : sortedEntries.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          <p className="text-sm">No glossary terms found.</p>
          <p className="text-xs mt-1 text-gray-400">Generate glossary terms from your document translations.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th
                  className="text-left py-2 px-3 font-semibold text-gray-700 cursor-pointer hover:bg-gray-50 select-none"
                  onClick={() => handleSort('source')}
                >
                  <div className="flex items-center space-x-1">
                    <span>Source Term</span>
                    {sortBy === 'source' && (
                      <span className="text-primary-600">
                        {sortOrder === 'asc' ? '↑' : '↓'}
                      </span>
                    )}
                  </div>
                </th>
                <th
                  className="text-left py-2 px-3 font-semibold text-gray-700 cursor-pointer hover:bg-gray-50 select-none"
                  onClick={() => handleSort('target')}
                >
                  <div className="flex items-center space-x-1">
                    <span>Target Term</span>
                    {sortBy === 'target' && (
                      <span className="text-primary-600">
                        {sortOrder === 'asc' ? '↑' : '↓'}
                      </span>
                    )}
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedEntries.map((entry) => (
                <tr
                  key={entry.id}
                  className="border-b border-gray-100 hover:bg-gray-50 transition-colors"
                >
                  <td className="py-2 px-3 text-gray-900">{entry.sourceTerm}</td>
                  <td className="py-2 px-3 text-gray-700">{entry.targetTerm}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}




