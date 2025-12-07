import { useQuery } from 'react-query';
import { glossaryApi } from '../../api/glossary.api';

interface GlossaryPanelProps {
  sourceText: string;
  sourceLocale: string;
  targetLocale: string;
  projectId?: string;
}

interface GlossarySearchResult {
  id: string;
  sourceTerm: string;
  targetTerm: string;
  isForbidden: boolean;
  similarity: number;
  matchMethod: 'exact' | 'semantic' | 'hybrid';
}

export default function GlossaryPanel({
  sourceText,
  sourceLocale,
  targetLocale,
  projectId,
}: GlossaryPanelProps) {
  // Use semantic search API for phrase-based matching with embeddings
  const { data: searchResults, isLoading } = useQuery({
    queryKey: ['glossary-search', sourceText, projectId, sourceLocale, targetLocale],
    queryFn: () => glossaryApi.search(sourceText, {
      projectId,
      sourceLocale,
      targetLocale,
      minSimilarity: 0.75, // 75% similarity threshold for semantic matches
    }),
    enabled: !!sourceText && !!sourceText.trim() && !!sourceLocale && !!targetLocale,
    staleTime: 30000, // Cache for 30 seconds
  });
      
  // Helper function to find positions of terms in source text
  const findTermPositions = (term: string, text: string): number[] => {
            const positions: number[] = [];
    const termLower = term.toLowerCase();
    const textLower = text.toLowerCase();
            let searchIndex = 0;
    
            while (true) {
      const index = textLower.indexOf(termLower, searchIndex);
              if (index === -1) break;
              positions.push(index);
              searchIndex = index + 1;
            }
    
    return positions;
  };

  const relevantTerms: Array<GlossarySearchResult & { positions: number[] }> = 
    (searchResults || []).map((result) => ({
      ...result,
      positions: findTermPositions(result.sourceTerm, sourceText),
    }));

  if (isLoading) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h3 className="font-semibold text-gray-900 mb-3">Glossary</h3>
        <div className="text-sm text-gray-500">Searching glossary terms...</div>
      </div>
    );
  }

  if (relevantTerms.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h3 className="font-semibold text-gray-900 mb-3">Glossary</h3>
        <div className="text-sm text-gray-500">
          {sourceText.trim() 
            ? 'No glossary terms found in this segment' 
            : 'Select a segment to see glossary terms'}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex justify-between items-center mb-3">
        <h3 className="font-semibold text-gray-900">Glossary</h3>
        <span className="text-xs text-gray-500 bg-blue-50 px-2 py-1 rounded">
          {relevantTerms.length} term{relevantTerms.length !== 1 ? 's' : ''} found
        </span>
      </div>
      <div className="space-y-2">
        {relevantTerms.map((term) => {
          const matchBadgeColor = 
            term.matchMethod === 'exact' ? 'bg-green-100 text-green-800' :
            term.matchMethod === 'semantic' ? 'bg-purple-100 text-purple-800' :
            'bg-blue-100 text-blue-800';
          
          const matchBadgeLabel = 
            term.matchMethod === 'exact' ? 'Exact' :
            term.matchMethod === 'semantic' ? 'Semantic' :
            'Hybrid';

          return (
            <div
              key={term.id}
              className={`border rounded p-3 ${
                term.isForbidden
                  ? 'border-red-300 bg-red-50'
                  : 'border-blue-200 bg-blue-50'
              }`}
            >
              <div className="flex justify-between items-start mb-2">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <div className="text-sm font-semibold text-gray-900">{term.sourceTerm}</div>
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${matchBadgeColor}`}>
                      {matchBadgeLabel}
                    </span>
                    {term.matchMethod !== 'exact' && (
                      <span className="text-xs text-gray-600">
                        {(term.similarity * 100).toFixed(0)}%
                      </span>
                    )}
                    {term.positions.length > 1 && (
                      <span className="text-xs bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded font-medium">
                        {term.positions.length}x
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-gray-700 font-medium">→ {term.targetTerm}</div>
                </div>
                {term.isForbidden && (
                  <span className="text-xs font-bold text-red-700 bg-red-100 px-2 py-1 rounded ml-2">
                    FORBIDDEN
                  </span>
                )}
              </div>
              
              {/* Show where the term appears in the segment text */}
              {term.positions.length > 0 && (
                <div className="mt-2 pt-2 border-t border-gray-300">
                  <div className="text-xs text-gray-600 mb-1">
                    Found in segment {term.positions.length > 1 ? `(${term.positions.length} times)` : ''}:
                  </div>
                  <div className="text-xs text-gray-800 bg-white p-2 rounded border border-gray-200 font-mono whitespace-pre-wrap break-words">
                    {(() => {
                      // Build highlighted text by splitting at each occurrence
                      const parts: (string | JSX.Element)[] = [];
                      let lastIndex = 0;
                      const termLength = term.sourceTerm.length;
                      
                      // Sort positions to process in order
                      const sortedPositions = [...term.positions].sort((a, b) => a - b);
                      
                      sortedPositions.forEach((pos, idx) => {
                        // Add text before the match
                        if (pos > lastIndex) {
                          parts.push(sourceText.substring(lastIndex, pos));
                        }
                        // Add highlighted match
                        parts.push(
                          <mark key={`match-${idx}`} className="bg-yellow-200 font-semibold">
                            {sourceText.substring(pos, pos + termLength)}
                          </mark>
                        );
                        lastIndex = pos + termLength;
                      });
                      
                      // Add remaining text after last match
                      if (lastIndex < sourceText.length) {
                        parts.push(sourceText.substring(lastIndex));
                      }
                      
                      return parts.length > 0 ? parts : sourceText;
                    })()}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}




