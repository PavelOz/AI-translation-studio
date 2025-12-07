import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import Layout from '../components/Layout';
import { glossaryApi } from '../api/glossary.api';
import type { GlossaryEntry, UpsertGlossaryEntryRequest } from '../api/glossary.api';
import GlossaryEntryModal from '../components/GlossaryEntryModal';
import GlossaryImportModal from '../components/GlossaryImportModal';
import { projectsApi } from '../api/projects.api';
import { getLanguageName } from '../utils/languages';
import toast from 'react-hot-toast';

export default function GlossaryPage() {
  const queryClient = useQueryClient();
  const [isEntryModalOpen, setIsEntryModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<GlossaryEntry | null>(null);
  const [projectFilter, setProjectFilter] = useState<string>('');
  const [sourceLocaleFilter, setSourceLocaleFilter] = useState<string>('');
  const [targetLocaleFilter, setTargetLocaleFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchMode, setSearchMode] = useState<'source' | 'target' | 'both'>('both');

  // Fetch projects for filter dropdown
  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: projectsApi.list,
  });

  // Fetch glossary entries
  const { data: glossaryEntries = [], isLoading } = useQuery({
    queryKey: ['glossary', 'all', projectFilter, sourceLocaleFilter, targetLocaleFilter],
    queryFn: () => glossaryApi.list(
      projectFilter || undefined,
      sourceLocaleFilter || undefined,
      targetLocaleFilter || undefined
    ),
  });

  // Fetch embedding statistics
  const { data: embeddingStats } = useQuery({
    queryKey: ['glossary-embedding-stats', projectFilter],
    queryFn: () => glossaryApi.getEmbeddingStats(projectFilter || undefined),
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: glossaryApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['glossary'] });
      queryClient.invalidateQueries({ queryKey: ['glossary-embedding-stats'] });
      toast.success('Glossary entry deleted successfully');
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.message || 'Failed to delete glossary entry');
    },
  });

  // Filter entries by search query
  const filteredEntries = glossaryEntries.filter((entry: GlossaryEntry) => {
    if (!searchQuery.trim()) return true;
    
    const query = searchQuery.toLowerCase();
    if (searchMode === 'source') {
      return entry.sourceTerm.toLowerCase().includes(query) ||
             entry.description?.toLowerCase().includes(query);
    } else if (searchMode === 'target') {
      return entry.targetTerm.toLowerCase().includes(query) ||
             entry.notes?.toLowerCase().includes(query);
    } else {
      return (
        entry.sourceTerm.toLowerCase().includes(query) ||
        entry.targetTerm.toLowerCase().includes(query) ||
        entry.description?.toLowerCase().includes(query) ||
        entry.notes?.toLowerCase().includes(query)
      );
    }
  });

  const handleAddEntry = () => {
    setEditingEntry(null);
    setIsEntryModalOpen(true);
  };

  const handleEditEntry = (entry: GlossaryEntry) => {
    setEditingEntry(entry);
    setIsEntryModalOpen(true);
  };

  const handleDeleteEntry = async (entryId: string) => {
    if (window.confirm('Are you sure you want to delete this glossary entry?')) {
      deleteMutation.mutate(entryId);
    }
  };

  const handleModalClose = () => {
    setIsEntryModalOpen(false);
    setEditingEntry(null);
  };

  // Get unique locales from entries
  const sourceLocales = Array.from(new Set(glossaryEntries.map(e => e.sourceLocale))).sort();
  const targetLocales = Array.from(new Set(glossaryEntries.map(e => e.targetLocale))).sort();

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <h1 className="text-3xl font-bold text-gray-900">Glossary</h1>
          <div className="flex gap-2">
            <button
              onClick={() => setIsImportModalOpen(true)}
              className="btn btn-secondary"
            >
              Import CSV
            </button>
            <button
              onClick={handleAddEntry}
              className="btn btn-primary"
            >
              Add Entry
            </button>
          </div>
        </div>

        {/* Embedding Statistics */}
        {embeddingStats && (
          <div className="card bg-blue-50 border-blue-200">
            <h2 className="text-lg font-semibold mb-4 text-gray-900">Vector Embeddings Status</h2>
            <p className="text-sm text-gray-600 mb-4">
              Embeddings enable semantic search for glossary entries. Entries with embeddings can be found using AI-powered similarity matching.
            </p>
            <div className="grid grid-cols-4 gap-4">
              <div className="bg-white p-3 rounded border">
                <div className="text-sm text-gray-600">Total Entries</div>
                <div className="text-2xl font-bold text-gray-900">{embeddingStats.total}</div>
              </div>
              <div className="bg-white p-3 rounded border">
                <div className="text-sm text-gray-600">With Embeddings</div>
                <div className="text-2xl font-bold text-green-600">{embeddingStats.withEmbedding}</div>
              </div>
              <div className="bg-white p-3 rounded border">
                <div className="text-sm text-gray-600">Without Embeddings</div>
                <div className="text-2xl font-bold text-orange-600">{embeddingStats.withoutEmbedding}</div>
              </div>
              <div className="bg-white p-3 rounded border">
                <div className="text-sm text-gray-600">Coverage</div>
                <div className="text-2xl font-bold text-blue-600">{embeddingStats.coverage.toFixed(1)}%</div>
              </div>
            </div>
            {embeddingStats.withoutEmbedding > 0 && (
              <div className="mt-4 text-sm text-gray-600">
                <p>
                  💡 To generate embeddings for existing entries, run:{' '}
                  <code className="bg-gray-100 px-2 py-1 rounded text-xs">
                    npx ts-node backend/scripts/generate-glossary-embeddings.ts
                  </code>
                </p>
              </div>
            )}
          </div>
        )}

        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Filters & Search</h2>
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Project
                </label>
                <select
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                  className="input w-full"
                >
                  <option value="">All Projects</option>
                  {projects?.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Source Locale
                </label>
                <select
                  value={sourceLocaleFilter}
                  onChange={(e) => setSourceLocaleFilter(e.target.value)}
                  className="input w-full"
                >
                  <option value="">All Locales</option>
                  {sourceLocales.map((locale) => (
                    <option key={locale} value={locale}>
                      {getLanguageName(locale)} ({locale})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Target Locale
                </label>
                <select
                  value={targetLocaleFilter}
                  onChange={(e) => setTargetLocaleFilter(e.target.value)}
                  className="input w-full"
                >
                  <option value="">All Locales</option>
                  {targetLocales.map((locale) => (
                    <option key={locale} value={locale}>
                      {getLanguageName(locale)} ({locale})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Search Glossary Entries
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Search in terms, descriptions, notes..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="input flex-1 min-w-[400px]"
                />
                <select
                  value={searchMode}
                  onChange={(e) => setSearchMode(e.target.value as 'source' | 'target' | 'both')}
                  className="input w-48"
                >
                  <option value="both">Source & Target</option>
                  <option value="source">Source Only</option>
                  <option value="target">Target Only</option>
                </select>
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="btn btn-secondary whitespace-nowrap"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <h2 className="text-xl font-semibold mb-4">
            Glossary Entries ({filteredEntries.length})
          </h2>
          {isLoading ? (
            <div className="text-center py-8">Loading...</div>
          ) : filteredEntries.length > 0 ? (
            <div className="space-y-3">
              {filteredEntries.map((entry: GlossaryEntry) => (
                <div
                  key={entry.id}
                  className={`border rounded-lg p-4 hover:bg-gray-50 transition-colors ${
                    entry.forbidden
                      ? 'border-red-300 bg-red-50'
                      : entry.status === 'DEPRECATED'
                      ? 'border-yellow-300 bg-yellow-50'
                      : 'border-gray-200'
                  }`}
                >
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <div className="mb-2">
                        <div className="flex items-center gap-2 mb-1">
                          <p className="text-sm text-gray-600">
                            Source ({getLanguageName(entry.sourceLocale)}):
                          </p>
                          {entry.forbidden && (
                            <span className="px-2 py-0.5 bg-red-100 text-red-800 rounded text-xs font-medium">
                              FORBIDDEN
                            </span>
                          )}
                          {entry.status === 'DEPRECATED' && (
                            <span className="px-2 py-0.5 bg-yellow-100 text-yellow-800 rounded text-xs font-medium">
                              DEPRECATED
                            </span>
                          )}
                          {entry.status === 'PREFERRED' && (
                            <span className="px-2 py-0.5 bg-green-100 text-green-800 rounded text-xs font-medium">
                              PREFERRED
                            </span>
                          )}
                        </div>
                        <p className="text-gray-900 font-medium">{entry.sourceTerm}</p>
                      </div>
                      <div className="mb-2">
                        <p className="text-sm text-gray-600 mb-1">
                          Target ({getLanguageName(entry.targetLocale)}):
                        </p>
                        <p className="text-gray-900">{entry.targetTerm}</p>
                      </div>
                      {entry.description && (
                        <div className="mb-2">
                          <p className="text-xs text-gray-500 mb-1">Description:</p>
                          <p className="text-sm text-gray-700">{entry.description}</p>
                        </div>
                      )}
                      {entry.notes && (
                        <div className="mb-2">
                          <p className="text-xs text-gray-500 mb-1">Notes:</p>
                          <p className="text-sm text-gray-700">{entry.notes}</p>
                        </div>
                      )}
                      <div className="flex flex-wrap gap-4 mt-2 text-xs text-gray-500">
                        <span>
                          {entry.sourceLocale} → {entry.targetLocale}
                        </span>
                        {entry.projectId && (
                          <span className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded">
                            Project
                          </span>
                        )}
                        {!entry.projectId && (
                          <span className="px-2 py-0.5 bg-green-100 text-green-800 rounded">
                            Global
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="ml-4 flex gap-2">
                      <button
                        onClick={() => handleEditEntry(entry)}
                        className="btn btn-sm btn-secondary"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDeleteEntry(entry.id)}
                        className="btn btn-sm btn-danger"
                        disabled={deleteMutation.isLoading}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              {searchQuery.trim() || projectFilter || sourceLocaleFilter || targetLocaleFilter ? (
                <>
                  <p className="text-gray-500 mb-4">No entries found matching your filters</p>
                  <button
                    onClick={() => {
                      setSearchQuery('');
                      setProjectFilter('');
                      setSourceLocaleFilter('');
                      setTargetLocaleFilter('');
                    }}
                    className="btn btn-secondary"
                  >
                    Clear Filters
                  </button>
                </>
              ) : (
                <>
                  <p className="text-gray-500 mb-4">No glossary entries found</p>
                  <p className="text-sm text-gray-400 mb-4">
                    Add entries manually or import a CSV file to build your glossary
                  </p>
                  <div className="flex gap-2 justify-center">
                    <button
                      onClick={() => setIsImportModalOpen(true)}
                      className="btn btn-secondary"
                    >
                      Import CSV File
                    </button>
                    <button
                      onClick={handleAddEntry}
                      className="btn btn-primary"
                    >
                      Add Your First Entry
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <GlossaryEntryModal
          isOpen={isEntryModalOpen}
          onClose={handleModalClose}
          entry={editingEntry}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['glossary'] });
            queryClient.invalidateQueries({ queryKey: ['glossary-embedding-stats'] });
          }}
        />

        <GlossaryImportModal
          isOpen={isImportModalOpen}
          onClose={() => setIsImportModalOpen(false)}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['glossary'] });
            queryClient.invalidateQueries({ queryKey: ['glossary-embedding-stats'] });
            setIsImportModalOpen(false);
          }}
        />
      </div>
    </Layout>
  );
}







