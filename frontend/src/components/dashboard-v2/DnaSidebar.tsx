/**
 * DnaSidebar: Интерактивная панель с abbreviationLogic
 * При клике на термин он подсвечивается в сегментах
 */

import { useState } from 'react';
import { X, Dna, Search } from 'lucide-react';
import { Loader2 } from 'lucide-react';

interface DnaSidebarProps {
  dna: {
    abbreviationLogic?: Record<string, { longForm: string; shortForm: string; aliases?: string[] }> | null;
    validationHints?: any;
  } | null;
  isOpen: boolean;
  onToggle: () => void;
  selectedTerm: string | null;
  onTermSelect: (term: string | null) => void;
  isLoading: boolean;
}

export default function DnaSidebar({
  dna,
  isOpen,
  onToggle,
  selectedTerm,
  onTermSelect,
  isLoading,
}: DnaSidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');

  if (!isOpen) {
    return (
      <button
        onClick={onToggle}
        className="fixed right-0 top-1/2 -translate-y-1/2 bg-primary-600 text-white px-3 py-8 rounded-l-lg shadow-lg hover:bg-primary-700 transition-colors z-40"
        title="Open DNA Sidebar"
      >
        <Dna className="w-5 h-5" />
      </button>
    );
  }

  const abbreviationLogic = dna?.abbreviationLogic || {};
  const terms = Object.entries(abbreviationLogic);

  // Фильтруем термины по поисковому запросу
  const filteredTerms = terms.filter(([key, value]) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      key.toLowerCase().includes(query) ||
      (typeof value === 'object' && value.longForm?.toLowerCase().includes(query)) ||
      (typeof value === 'object' && value.shortForm?.toLowerCase().includes(query)) ||
      (typeof value === 'object' && value.aliases?.some(a => a.toLowerCase().includes(query)))
    );
  });

  return (
    <div className="fixed right-0 top-0 h-full w-80 bg-white border-l border-gray-200 shadow-xl z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-200 bg-gray-50">
        <div className="flex items-center gap-2">
          <Dna className="w-5 h-5 text-primary-600" />
          <h2 className="text-lg font-semibold text-gray-900">DNA Glossary</h2>
        </div>
        <button
          onClick={onToggle}
          className="p-1 hover:bg-gray-200 rounded transition-colors"
          title="Close DNA Sidebar"
        >
          <X className="w-5 h-5 text-gray-500" />
        </button>
      </div>

      {/* Search */}
      <div className="p-4 border-b border-gray-200">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search terms..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </div>
      </div>

      {/* Terms List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-6 h-6 animate-spin text-primary-600" />
          </div>
        ) : filteredTerms.length === 0 ? (
          <div className="p-4 text-center text-gray-500">
            {searchQuery ? 'No terms found' : 'No glossary terms available'}
          </div>
        ) : (
          <div className="p-2">
            {filteredTerms.map(([key, value]) => {
              const isSelected = selectedTerm === key;
              const entry = typeof value === 'object' ? value : { longForm: value, shortForm: value };
              
              return (
                <button
                  key={key}
                  onClick={() => onTermSelect(isSelected ? null : key)}
                  className={`w-full text-left p-3 rounded-lg mb-2 transition-all ${
                    isSelected
                      ? 'bg-primary-100 border-2 border-primary-500 shadow-md'
                      : 'bg-gray-50 border border-gray-200 hover:bg-gray-100 hover:border-gray-300'
                  }`}
                >
                  <div className="font-semibold text-gray-900 mb-1">{key}</div>
                  <div className="text-sm text-gray-600 space-y-1">
                    {entry.longForm && (
                      <div>
                        <span className="text-gray-500">Long:</span> {entry.longForm}
                      </div>
                    )}
                    {entry.shortForm && entry.shortForm !== entry.longForm && (
                      <div>
                        <span className="text-gray-500">Short:</span> {entry.shortForm}
                      </div>
                    )}
                    {entry.aliases && entry.aliases.length > 0 && (
                      <div>
                        <span className="text-gray-500">Aliases:</span>{' '}
                        {entry.aliases.join(', ')}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-gray-200 bg-gray-50 text-sm text-gray-500">
        {terms.length} term{terms.length !== 1 ? 's' : ''} in glossary
      </div>
    </div>
  );
}
