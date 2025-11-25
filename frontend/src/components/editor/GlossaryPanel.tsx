import { useQuery } from 'react-query';
import { useMemo } from 'react';
import { glossaryApi } from '../../api/glossary.api';

interface GlossaryPanelProps {
  sourceText: string;
  sourceLocale: string;
  targetLocale: string;
  projectId?: string;
}

interface RelevantTerm {
  entry: any;
  matches: number; // Number of times the term appears in the text
  positions: number[]; // Character positions where the term appears
}

export default function GlossaryPanel({
  sourceText,
  sourceLocale,
  targetLocale,
  projectId,
}: GlossaryPanelProps) {
  const { data: glossaryEntries } = useQuery({
    queryKey: ['glossary', projectId, sourceLocale, targetLocale],
    queryFn: () => glossaryApi.list(projectId, sourceLocale, targetLocale),
    enabled: !!sourceLocale && !!targetLocale,
  });

  // Improved search: find terms that appear in the source text
  // Supports exact matches, root-based matching (for morphological variants), and substring matches
  const relevantTerms = useMemo(() => {
    // Helper: Extract word root/stem for Russian/Kazakh (simple heuristic)
    // Removes common endings: -ия, -ии, -ию, -ий, -а, -у, -е, -ом, -ой, -ами, -ах, -ов, etc.
    const extractRoot = (word: string): string => {
      if (!word || typeof word !== 'string' || word.length < 4) {
        return word ? word.toLowerCase() : '';
      }
      
      // Russian/Kazakh common endings (ordered by length - longest first)
      const endings = [
        'ами', 'ах', 'ов', 'ей', 'ом', 'ой', 'ую', 'ая', 'ое', 'ые', 'ых', // plural/adj endings
        'ия', 'ии', 'ию', 'ий', 'ие', // -ия endings
        'ая', 'ую', 'ой', 'ом', 'ое', // adjective endings
        'ов', 'ев', 'ин', 'ын', // possessive endings
        'а', 'у', 'е', 'и', 'о', 'ы', 'ь', 'й', // basic endings
      ];
      
      let root = word.toLowerCase();
      for (const ending of endings) {
        if (root.endsWith(ending) && root.length > ending.length + 2) {
          root = root.slice(0, -ending.length);
          break; // Remove only one ending
        }
      }
      
      return root;
    };

    // Helper: Check if two words share the same root (for morphological matching)
    const shareRoot = (word1: string, word2: string): boolean => {
      if (!word1 || !word2) return false;
      const root1 = extractRoot(word1);
      const root2 = extractRoot(word2);
      
      // Words share root if:
      // 1. Roots are identical
      // 2. One root is a prefix of the other (min 4 chars overlap for accuracy)
      const minRootLength = Math.min(root1.length, root2.length);
      if (minRootLength < 4) {
        // For short words, require exact match
        return root1 === root2;
      }
      
      return root1 === root2 || 
             (root1.length >= 4 && root2.startsWith(root1)) ||
             (root2.length >= 4 && root1.startsWith(root2));
    };

    if (!glossaryEntries || !sourceText || !sourceText.trim()) {
      return [];
    }

    try {
      const sourceLower = sourceText.toLowerCase();
      const sourceWords = sourceText.split(/\s+/)
        .map(w => w.toLowerCase().replace(/[.,!?;:()\[\]{}"']/g, ''))
        .filter(w => w.length > 0);
      
      if (!Array.isArray(glossaryEntries)) {
        return [];
      }
      
      return glossaryEntries
      .map((entry): RelevantTerm | null => {
        const termLower = entry.sourceTerm.toLowerCase();
        const termWords = entry.sourceTerm.split(/\s+/).map(w => w.toLowerCase().replace(/[.,!?;:()\[\]{}"']/g, ''));
        
        // Strategy 1: Exact word match (for single-word terms) - 100% similarity
        if (termWords.length === 1) {
          const word = termWords[0];
          // Check if the word appears as a whole word (not just substring)
          const wordRegex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
          const matches = sourceText.match(wordRegex);
          if (matches) {
            // Find all positions
            const positions: number[] = [];
            let searchIndex = 0;
            while (true) {
              const index = sourceLower.indexOf(word, searchIndex);
              if (index === -1) break;
              positions.push(index);
              searchIndex = index + 1;
            }
            return {
              entry,
              matches: matches.length,
              positions,
            };
          }
          
          // Strategy 1b: Root-based match (for morphological variants) - ~80-95% similarity
          // Only for Russian/Kazakh locales (ru, kk)
          if (sourceLocale && (sourceLocale === 'ru' || sourceLocale === 'kk' || sourceLocale.startsWith('ru-') || sourceLocale.startsWith('kk-'))) {
            for (const sourceWord of sourceWords) {
              if (sourceWord && shareRoot(word, sourceWord)) {
                // Find positions where words with matching root appear
                const positions: number[] = [];
                try {
                  const escapedWord = sourceWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                  const regex = new RegExp(`\\b${escapedWord}\\b`, 'gi');
                  let match;
                  // Reset regex lastIndex to avoid issues
                  regex.lastIndex = 0;
                  while ((match = regex.exec(sourceText)) !== null) {
                    positions.push(match.index);
                    // Prevent infinite loop
                    if (positions.length > 100) break;
                  }
                } catch (e) {
                  // If regex fails, skip this word
                  console.warn('Regex error in glossary search:', e);
                }
                
                if (positions.length > 0) {
                  return {
                    entry,
                    matches: positions.length,
                    positions,
                  };
                }
              }
            }
          }
        }
        
        // Strategy 2: Phrase match (for multi-word terms) - 100% similarity
        if (termWords.length > 1) {
          // First try exact phrase match
          const phraseIndex = sourceLower.indexOf(termLower);
          if (phraseIndex !== -1) {
            return {
              entry,
              matches: 1,
              positions: [phraseIndex],
            };
          }
          
          // Then try root-based matching for each word in phrase
          // Check if all words (or their roots) appear in order
          let lastIndex = -1;
          let allWordsFound = true;
          const isRuKk = sourceLocale && (sourceLocale === 'ru' || sourceLocale === 'kk' || sourceLocale.startsWith('ru-') || sourceLocale.startsWith('kk-'));
          
          for (const word of termWords) {
            if (!word) continue;
            let found = false;
            // Try exact match first
            const index = sourceLower.indexOf(word, lastIndex + 1);
            if (index !== -1) {
              lastIndex = index;
              found = true;
            } else if (isRuKk) {
              // Try root-based match
              for (let i = 0; i < sourceWords.length; i++) {
                const sourceWord = sourceWords[i];
                if (sourceWord && shareRoot(word, sourceWord)) {
                  const wordIndex = sourceLower.indexOf(sourceWord, lastIndex + 1);
                  if (wordIndex !== -1) {
                    lastIndex = wordIndex;
                    found = true;
                    break;
                  }
                }
              }
            }
            
            if (!found) {
              allWordsFound = false;
              break;
            }
          }
          
          if (allWordsFound) {
            // Find approximate position (use first word's position)
            const firstWordIndex = sourceLower.indexOf(termWords[0]);
            if (firstWordIndex !== -1) {
              return {
                entry,
                matches: 1,
                positions: [firstWordIndex],
              };
            }
          }
        }
        
        // Strategy 3: Substring match (fallback for compound terms) - 100% similarity
        if (sourceLower.includes(termLower)) {
          const positions: number[] = [];
          let searchIndex = 0;
          while (true) {
            const index = sourceLower.indexOf(termLower, searchIndex);
            if (index === -1) break;
            positions.push(index);
            searchIndex = index + 1;
          }
          return {
            entry,
            matches: positions.length,
            positions,
          };
        }
        
        return null;
      })
      .filter((term): term is RelevantTerm => term !== null)
      .sort((a, b) => {
        // Sort by: forbidden first, then by number of matches (descending)
        if (a.entry.forbidden && !b.entry.forbidden) return -1;
        if (!a.entry.forbidden && b.entry.forbidden) return 1;
        return b.matches - a.matches;
      });
    } catch (error) {
      console.error('Error in glossary search:', error);
      return [];
    }
  }, [glossaryEntries, sourceText, sourceLocale]);

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
        {relevantTerms.map(({ entry, matches, positions }) => {
          return (
            <div
              key={entry.id}
              className={`border rounded p-3 ${
                entry.forbidden
                  ? 'border-red-300 bg-red-50'
                  : 'border-blue-200 bg-blue-50'
              }`}
            >
              <div className="flex justify-between items-start mb-2">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="text-sm font-semibold text-gray-900">{entry.sourceTerm}</div>
                    {matches > 1 && (
                      <span className="text-xs bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded font-medium">
                        {matches}x
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-gray-700 font-medium">→ {entry.targetTerm}</div>
                  {entry.description && (
                    <div className="text-xs text-gray-600 mt-1 italic">{entry.description}</div>
                  )}
                </div>
                {entry.forbidden && (
                  <span className="text-xs font-bold text-red-700 bg-red-100 px-2 py-1 rounded ml-2">
                    FORBIDDEN
                  </span>
                )}
              </div>
              
              {/* Show where the term appears in the segment text */}
              {positions.length > 0 && (
                <div className="mt-2 pt-2 border-t border-gray-300">
                  <div className="text-xs text-gray-600 mb-1">
                    Found in segment {positions.length > 1 ? `(${positions.length} times)` : ''}:
                  </div>
                  <div className="text-xs text-gray-800 bg-white p-2 rounded border border-gray-200 font-mono whitespace-pre-wrap break-words">
                    {(() => {
                      // Build highlighted text by splitting at each occurrence
                      const parts: (string | JSX.Element)[] = [];
                      let lastIndex = 0;
                      const termLength = entry.sourceTerm.length;
                      
                      // Sort positions to process in order
                      const sortedPositions = [...positions].sort((a, b) => a - b);
                      
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




