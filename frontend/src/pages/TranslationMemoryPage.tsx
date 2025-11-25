import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import Layout from '../components/Layout';
import { tmApi } from '../api/tm.api';
import TMImportModal from '../components/TMImportModal';
import TMEntryModal from '../components/TMEntryModal';
import { projectsApi } from '../api/projects.api';
import type { TranslationMemoryEntry, TmSearchResult } from '../api/tm.api';
import toast from 'react-hot-toast';
import apiClient from '../api/client';

export default function TranslationMemoryPage() {
  const queryClient = useQueryClient();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isEntryModalOpen, setIsEntryModalOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<TranslationMemoryEntry | null>(null);
  const [projectFilter, setProjectFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchMode, setSearchMode] = useState<'source' | 'target' | 'both'>('both');
  const [searchResults, setSearchResults] = useState<TmSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(500); // Increased default to show more entries
  const [showFindReplace, setShowFindReplace] = useState(false);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [replaceMode, setReplaceMode] = useState<'source' | 'target' | 'both'>('target');
  const [matchingEntries, setMatchingEntries] = useState<TranslationMemoryEntry[]>([]);
  const [isReplacing, setIsReplacing] = useState(false);
  
  // Embedding generation state
  const [showEmbeddingGenerator, setShowEmbeddingGenerator] = useState(false);
  const [embeddingProgressId, setEmbeddingProgressId] = useState<string | null>(null);
  const [batchSize, setBatchSize] = useState(50);

  // Fetch projects for dropdown
  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: projectsApi.list,
  });

  const { data: tmData, isLoading } = useQuery({
    queryKey: ['tm', 'entries', projectFilter, currentPage, pageSize],
    queryFn: () => {
      // Handle special case: 'general' means global entries only (projectId = null)
      if (projectFilter === 'general') {
        return tmApi.list(undefined, currentPage, pageSize, true); // globalOnly = true
      }
      // Empty string means all entries (both project and global)
      // Specific projectId means entries for that project only
      return tmApi.list(projectFilter || undefined, currentPage, pageSize, false);
    },
  });

  const entries = (tmData as any)?.entries || [];
  const total = (tmData as any)?.total || 0;
  const totalPages = (tmData as any)?.totalPages || 1;

  // Fetch embedding statistics
  const { data: embeddingStats, refetch: refetchEmbeddingStats } = useQuery({
    queryKey: ['embedding-stats', projectFilter],
    queryFn: () => tmApi.getEmbeddingStats(projectFilter || undefined),
    refetchInterval: embeddingProgressId ? 2000 : false, // Poll every 2 seconds when generating
  });

  // Fetch embedding generation progress
  const { data: embeddingProgress } = useQuery({
    queryKey: ['embedding-progress', embeddingProgressId],
    queryFn: () => embeddingProgressId ? tmApi.getEmbeddingProgress(embeddingProgressId) : null,
    enabled: !!embeddingProgressId,
    refetchInterval: (data) => {
      // Stop polling if completed, cancelled, or error
      if (data?.status === 'completed' || data?.status === 'cancelled' || data?.status === 'error') {
        return false;
      }
      return 1000; // Poll every second while running
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: tmApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tm'] });
      toast.success('Translation memory entry deleted successfully');
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.message || 'Failed to delete translation memory entry');
    },
  });

  // Embedding generation mutations
  const generateEmbeddingsMutation = useMutation({
    mutationFn: (params: { projectId?: string; batchSize?: number; limit?: number }) =>
      tmApi.generateEmbeddings(params.projectId, params.batchSize, params.limit),
    onSuccess: (data) => {
      setEmbeddingProgressId(data.progressId);
      toast.success('Embedding generation started');
      refetchEmbeddingStats();
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.message || 'Failed to start embedding generation');
    },
  });

  const cancelEmbeddingMutation = useMutation({
    mutationFn: (progressId: string) =>
      apiClient.post(`/tm/embedding-progress/${progressId}/cancel`),
    onSuccess: () => {
      toast.success('Embedding generation cancelled');
      setEmbeddingProgressId(null);
      refetchEmbeddingStats();
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.message || 'Failed to cancel embedding generation');
    },
  });

  const handleEditEntry = (entry: TranslationMemoryEntry) => {
    setEditingEntry(entry);
    setIsEntryModalOpen(true);
  };

  const handleDeleteEntry = async (entryId: string) => {
    if (window.confirm('Are you sure you want to delete this translation memory entry?')) {
      deleteMutation.mutate(entryId);
    }
  };

  const handleEntryModalClose = () => {
    setIsEntryModalOpen(false);
    setEditingEntry(null);
  };

  // Reset to page 1 when filters change
  const handleProjectFilterChange = (value: string) => {
    setProjectFilter(value);
    setCurrentPage(1);
  };

  // Find matching entries for find/replace (works on currently displayed/filtered entries)
  const handleFind = () => {
    if (!findText.trim()) {
      setMatchingEntries([]);
      return;
    }

    const findLower = findText.toLowerCase();
    // Use displayEntries (filtered/search results) instead of all entries
    const matches = displayEntries
      .filter((entry): entry is TranslationMemoryEntry => {
        // Only process actual TM entries, not search results from linked files
        return !('tmxFileSource' in entry && (entry as TmSearchResult).tmxFileSource === 'linked');
      })
      .filter((entry: TranslationMemoryEntry) => {
        if (replaceMode === 'source') {
          return entry.sourceText.toLowerCase().includes(findLower);
        } else if (replaceMode === 'target') {
          return entry.targetText.toLowerCase().includes(findLower);
        } else {
          return (
            entry.sourceText.toLowerCase().includes(findLower) ||
            entry.targetText.toLowerCase().includes(findLower)
          );
        }
      });

    setMatchingEntries(matches);
  };

  // Replace text in matching entries
  const replaceMutation = useMutation({
    mutationFn: async (updates: Array<{ id: string; sourceText?: string; targetText?: string }>) => {
      // Update entries one by one
      const promises = updates.map((update) => {
        const { id, ...data } = update;
        return tmApi.update(id, data);
      });
      return Promise.all(promises);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tm'] });
      toast.success(`Successfully replaced text in ${matchingEntries.length} entries`);
      setFindText('');
      setReplaceText('');
      setMatchingEntries([]);
      setShowFindReplace(false);
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.message || 'Failed to replace text');
    },
  });

  const handleReplace = async () => {
    if (!findText.trim() || !replaceText.trim() || matchingEntries.length === 0) {
      toast.error('Please provide find text, replace text, and ensure there are matches');
      return;
    }

    if (!window.confirm(`Replace "${findText}" with "${replaceText}" in ${matchingEntries.length} entries?`)) {
      return;
    }

    setIsReplacing(true);
    const updates = matchingEntries.map((entry) => {
      const update: { id: string; sourceText?: string; targetText?: string } = { id: entry.id };
      
      if (replaceMode === 'source' || replaceMode === 'both') {
        update.sourceText = entry.sourceText.replace(
          new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
          replaceText
        );
      }
      
      if (replaceMode === 'target' || replaceMode === 'both') {
        update.targetText = entry.targetText.replace(
          new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
          replaceText
        );
      }
      
      return update;
    });

    replaceMutation.mutate(updates);
    setIsReplacing(false);
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    setIsSearching(true);
    try {
      // Search using the TM search API with fuzzy matching
      // Use wildcard locales to search across all locales
      const results = await tmApi.search({
        sourceText: searchQuery,
        sourceLocale: '*', // Will search across all source locales
        targetLocale: '*', // Will search across all target locales
        projectId: projectFilter || undefined,
        limit: 1000, // Increased limit for search results
        minScore: 50, // Lower threshold for broader search
      });
      setSearchResults(results);
    } catch (error: any) {
      console.error('Search error:', error);
      // Fallback to client-side filtering if API search fails
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  // Filter entries by search query if not using API search
  const filteredEntries = searchQuery.trim() && !isSearching
    ? entries.filter((entry: TranslationMemoryEntry) => {
        const query = searchQuery.toLowerCase();
        if (searchMode === 'source') {
          return entry.sourceText.toLowerCase().includes(query);
        } else if (searchMode === 'target') {
          return entry.targetText.toLowerCase().includes(query);
        } else {
          return (
            entry.sourceText.toLowerCase().includes(query) ||
            entry.targetText.toLowerCase().includes(query)
          );
        }
      })
    : entries;

  const displayEntries = searchQuery.trim() && searchResults.length > 0
    ? searchResults
    : filteredEntries;

  // Update embedding progress when it completes
  useEffect(() => {
    if (embeddingProgress?.status === 'completed' || embeddingProgress?.status === 'error' || embeddingProgress?.status === 'cancelled') {
      // Refresh stats and TM entries when generation completes
      refetchEmbeddingStats();
      queryClient.invalidateQueries({ queryKey: ['tm'] });
      
      if (embeddingProgress.status === 'completed') {
        toast.success(`Embedding generation completed: ${embeddingProgress.succeeded} succeeded, ${embeddingProgress.failed} failed`);
      }
    }
  }, [embeddingProgress?.status, refetchEmbeddingStats, queryClient]);

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <h1 className="text-3xl font-bold text-gray-900">Translation Memory</h1>
          <div className="flex gap-2">
            <button
              onClick={() => setShowEmbeddingGenerator(!showEmbeddingGenerator)}
              className="btn btn-secondary"
            >
              {showEmbeddingGenerator ? 'Hide' : 'Show'} Embedding Generator
            </button>
            <button
              onClick={() => setShowFindReplace(!showFindReplace)}
              className="btn btn-secondary"
            >
              {showFindReplace ? 'Hide' : 'Show'} Find & Replace
            </button>
            <button
              onClick={() => setIsModalOpen(true)}
              className="btn btn-primary"
            >
              Import TMX File
            </button>
          </div>
        </div>

        {/* Embedding Generator Section */}
        {showEmbeddingGenerator && (
          <div className="card bg-blue-50 border-blue-200">
            <h2 className="text-lg font-semibold mb-4 text-gray-900">Vector Embeddings Generator</h2>
            <p className="text-sm text-gray-600 mb-4">
              Generate vector embeddings for Translation Memory entries to enable semantic search (RAG).
              Embeddings are required for vector-based similarity search.
            </p>

            {/* Statistics */}
            {embeddingStats && (
              <div className="grid grid-cols-4 gap-4 mb-4">
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
            )}

            {/* Progress Display */}
            {embeddingProgress && embeddingProgress.status === 'running' && (
              <div className="mb-4 bg-white p-4 rounded border">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-medium text-gray-700">Generation Progress</span>
                  <span className="text-sm text-gray-600">
                    {embeddingProgress.processed} / {embeddingProgress.total} entries
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-3 mb-2">
                  <div
                    className="bg-blue-600 h-3 rounded-full transition-all duration-500"
                    style={{
                      width: `${embeddingProgress.total > 0 ? (embeddingProgress.processed / embeddingProgress.total) * 100 : 0}%`,
                      minWidth: embeddingProgress.total > 0 ? '2px' : '0',
                    }}
                  />
                </div>
                <div className="flex justify-between text-xs text-gray-600">
                  <span>✓ Succeeded: {embeddingProgress.succeeded}</span>
                  <span>✗ Failed: {embeddingProgress.failed}</span>
                  {embeddingProgress.currentEntry && (
                    <span className="text-gray-500">
                      Processing: {embeddingProgress.currentEntry.sourceText}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => {
                    if (embeddingProgressId) {
                      cancelEmbeddingMutation.mutate(embeddingProgressId);
                    }
                  }}
                  className="mt-2 btn btn-secondary btn-sm"
                  disabled={cancelEmbeddingMutation.isLoading}
                >
                  {cancelEmbeddingMutation.isLoading ? 'Cancelling...' : 'Cancel Generation'}
                </button>
              </div>
            )}

            {/* Completed/Error Status */}
            {embeddingProgress && (embeddingProgress.status === 'completed' || embeddingProgress.status === 'error' || embeddingProgress.status === 'cancelled') && (
              <div className={`mb-4 p-4 rounded border ${
                embeddingProgress.status === 'completed' ? 'bg-green-50 border-green-200' :
                embeddingProgress.status === 'error' ? 'bg-red-50 border-red-200' :
                'bg-yellow-50 border-yellow-200'
              }`}>
                <div className="font-medium mb-2">
                  {embeddingProgress.status === 'completed' && '✓ Generation Completed'}
                  {embeddingProgress.status === 'error' && '✗ Generation Failed'}
                  {embeddingProgress.status === 'cancelled' && '⚠ Generation Cancelled'}
                </div>
                <div className="text-sm text-gray-600">
                  Processed: {embeddingProgress.processed} | 
                  Succeeded: {embeddingProgress.succeeded} | 
                  Failed: {embeddingProgress.failed}
                </div>
                {embeddingProgress.error && (
                  <div className="text-sm text-red-600 mt-2">Error: {embeddingProgress.error}</div>
                )}
                <button
                  onClick={() => {
                    setEmbeddingProgressId(null);
                    refetchEmbeddingStats();
                  }}
                  className="mt-2 btn btn-secondary btn-sm"
                >
                  Clear Status
                </button>
              </div>
            )}

            {/* Generation Controls */}
            {(!embeddingProgress || embeddingProgress.status !== 'running') && (
              <div className="space-y-4">
                <div className="flex gap-4 items-end">
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Batch Size (entries per batch)
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="200"
                      value={batchSize}
                      onChange={(e) => setBatchSize(parseInt(e.target.value) || 50)}
                      className="input w-full"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Recommended: 50-100. Larger batches are faster but may hit API rate limits.
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Project Filter
                    </label>
                    <select
                      value={projectFilter}
                      onChange={(e) => setProjectFilter(e.target.value)}
                      className="input"
                    >
                      <option value="">All Projects</option>
                      {projects?.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <button
                  onClick={() => {
                    generateEmbeddingsMutation.mutate({
                      projectId: projectFilter || undefined,
                      batchSize,
                    });
                  }}
                  disabled={generateEmbeddingsMutation.isLoading || (embeddingStats?.withoutEmbedding ?? 0) === 0}
                  className="btn btn-primary"
                >
                  {generateEmbeddingsMutation.isLoading
                    ? 'Starting...'
                    : `Generate Embeddings for ${embeddingStats?.withoutEmbedding ?? 0} Entries`}
                </button>
                {(embeddingStats?.withoutEmbedding ?? 0) === 0 && (
                  <p className="text-sm text-green-600 mt-2">
                    ✓ All entries already have embeddings!
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Filters & Search</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Project Filter
              </label>
                <select
                  value={projectFilter}
                  onChange={(e) => handleProjectFilterChange(e.target.value)}
                  className="input w-full"
                >
                <option value="">All Projects (Project + Global)</option>
                <option value="general">General (Global Only)</option>
                {projects?.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Search TM Entries (fuzzy match)
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Search in source/target text..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleSearch();
                    }
                  }}
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
                <button
                  onClick={handleSearch}
                  disabled={isSearching || !searchQuery.trim()}
                  className="btn btn-primary whitespace-nowrap"
                >
                  {isSearching ? 'Searching...' : 'Search'}
                </button>
                {searchQuery && (
                  <button
                    onClick={() => {
                      setSearchQuery('');
                      setSearchResults([]);
                    }}
                    className="btn btn-secondary whitespace-nowrap"
                  >
                    Clear
                  </button>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-1">
                {searchQuery.trim()
                  ? 'Using fuzzy matching API search (searches imported and linked TMX files)'
                  : 'Enter text and click Search for fuzzy matching, or type to filter displayed entries'}
              </p>
            </div>
          </div>
        </div>

        {/* Find & Replace Section */}
        {showFindReplace && (
          <div className="card bg-blue-50 border-blue-200">
            <h2 className="text-lg font-semibold mb-4">Find & Replace in Filtered Entries</h2>
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Find Text
                  </label>
                  <input
                    type="text"
                    value={findText}
                    onChange={(e) => {
                      setFindText(e.target.value);
                      setMatchingEntries([]);
                    }}
                    placeholder="Text to find..."
                    className="input w-full"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Replace With
                  </label>
                  <input
                    type="text"
                    value={replaceText}
                    onChange={(e) => setReplaceText(e.target.value)}
                    placeholder="Replacement text..."
                    className="input w-full"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Replace In
                  </label>
                  <select
                    value={replaceMode}
                    onChange={(e) => {
                      setReplaceMode(e.target.value as 'source' | 'target' | 'both');
                      setMatchingEntries([]);
                    }}
                    className="input w-full"
                  >
                    <option value="target">Target Text Only</option>
                    <option value="source">Source Text Only</option>
                    <option value="both">Both Source & Target</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleFind}
                  disabled={!findText.trim() || isReplacing}
                  className="btn btn-secondary"
                >
                  Find ({matchingEntries.length} matches)
                </button>
                <button
                  onClick={handleReplace}
                  disabled={!findText.trim() || !replaceText.trim() || matchingEntries.length === 0 || isReplacing}
                  className="btn btn-primary"
                >
                  {isReplacing ? 'Replacing...' : `Replace All (${matchingEntries.length} entries)`}
                </button>
                {matchingEntries.length > 0 && (
                  <button
                    onClick={() => {
                      setFindText('');
                      setReplaceText('');
                      setMatchingEntries([]);
                    }}
                    className="btn btn-secondary"
                  >
                    Clear
                  </button>
                )}
              </div>
              {matchingEntries.length > 0 && (
                <div className="bg-white border border-blue-300 rounded p-3 max-h-48 overflow-y-auto">
                  <p className="text-sm font-medium text-gray-700 mb-2">
                    Preview ({matchingEntries.length} entries will be updated):
                  </p>
                  <div className="space-y-2 text-sm">
                    {matchingEntries.slice(0, 10).map((entry) => (
                      <div key={entry.id} className="border-b border-gray-200 pb-2">
                        {replaceMode === 'source' || replaceMode === 'both' ? (
                          <div>
                            <span className="text-gray-600">Source: </span>
                            <span className="line-through text-red-600">
                              {entry.sourceText.substring(0, 100)}
                            </span>
                            <span className="text-gray-600"> → </span>
                            <span className="text-green-600">
                              {entry.sourceText.replace(
                                new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
                                replaceText
                              ).substring(0, 100)}
                            </span>
                          </div>
                        ) : null}
                        {replaceMode === 'target' || replaceMode === 'both' ? (
                          <div>
                            <span className="text-gray-600">Target: </span>
                            <span className="line-through text-red-600">
                              {entry.targetText.substring(0, 100)}
                            </span>
                            <span className="text-gray-600"> → </span>
                            <span className="text-green-600">
                              {entry.targetText.replace(
                                new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
                                replaceText
                              ).substring(0, 100)}
                            </span>
                          </div>
                        ) : null}
                      </div>
                    ))}
                    {matchingEntries.length > 10 && (
                      <p className="text-xs text-gray-500 italic">
                        ... and {matchingEntries.length - 10} more entries
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="card">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold">
              TM Entries
              {searchQuery.trim() && searchResults.length > 0
                ? ` (${searchResults.length} fuzzy matches)`
                : total > 0 && ` (${total} total, showing ${entries.length})`}
            </h2>
            {!searchQuery.trim() && total > 0 && (
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-700">Page size:</label>
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setCurrentPage(1);
                  }}
                  className="input w-24"
                >
                  <option value="50">50</option>
                  <option value="100">100</option>
                  <option value="200">200</option>
                  <option value="500">500</option>
                  <option value="1000">1000</option>
                </select>
              </div>
            )}
          </div>
          {isLoading || isSearching ? (
            <div className="text-center py-8">Loading...</div>
          ) : displayEntries.length > 0 ? (
            <>
              {/* Pagination controls at top - only show when not searching */}
              {!searchQuery.trim() && total > pageSize && (
                <div className="mb-6 flex items-center justify-between border-b border-gray-200 pb-4">
                  <div className="text-sm text-gray-700">
                    Showing page {currentPage} of {totalPages} ({total} total entries)
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setCurrentPage(1)}
                      disabled={currentPage === 1}
                      className="btn btn-sm btn-secondary"
                    >
                      First
                    </button>
                    <button
                      onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                      disabled={currentPage === 1}
                      className="btn btn-sm btn-secondary"
                    >
                      Previous
                    </button>
                    <span className="px-4 py-2 text-sm text-gray-700">
                      Page {currentPage} of {totalPages}
                    </span>
                    <button
                      onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                      disabled={currentPage >= totalPages}
                      className="btn btn-sm btn-secondary"
                    >
                      Next
                    </button>
                    <button
                      onClick={() => setCurrentPage(totalPages)}
                      disabled={currentPage >= totalPages}
                      className="btn btn-sm btn-secondary"
                    >
                      Last
                    </button>
                  </div>
                </div>
              )}

              <div className="space-y-3">
                {displayEntries.map((entry: TranslationMemoryEntry | TmSearchResult) => (
                  <div
                    key={entry.id}
                    className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex justify-between items-start">
                      <div className="flex-1">
                        <div className="mb-2">
                          <p className="text-sm text-gray-600 mb-1">Source ({entry.sourceLocale}):</p>
                          <p className="text-gray-900 font-medium">{entry.sourceText}</p>
                        </div>
                        <div>
                          <p className="text-sm text-gray-600 mb-1">Target ({entry.targetLocale}):</p>
                          <p className="text-gray-900">{entry.targetText}</p>
                        </div>
                        <div className="flex flex-wrap gap-4 mt-2 text-xs text-gray-500">
                          {entry.clientName && <span>Client: {entry.clientName}</span>}
                          {entry.domain && <span>Domain: {entry.domain}</span>}
                          {entry.matchRate && <span>Match: {(entry.matchRate * 100).toFixed(0)}%</span>}
                          <span>Used: {entry.usageCount} times</span>
                          {'tmxFileName' in entry && (entry as TmSearchResult).tmxFileName && (
                            <span className="font-medium text-primary-600" title={`Source: ${(entry as TmSearchResult).tmxFileSource === 'linked' ? 'Linked TMX file' : 'Imported TMX file'}`}>
                              📄 {(entry as TmSearchResult).tmxFileName}
                              {(entry as TmSearchResult).tmxFileSource === 'linked' && ' (linked)'}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="ml-4 flex flex-col gap-2 items-end">
                        <div>
                          {entry.projectId ? (
                            <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs">
                              Project
                            </span>
                          ) : (
                            <span className="px-2 py-1 bg-green-100 text-green-800 rounded text-xs">
                              Global
                            </span>
                          )}
                        </div>
                        {/* Only show edit/delete for entries in database, not linked TMX files */}
                        {('tmxFileSource' in entry && (entry as TmSearchResult).tmxFileSource === 'linked') ? (
                          <span className="text-xs text-gray-500 italic">Read-only (linked file)</span>
                        ) : (
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleEditEntry(entry as TranslationMemoryEntry)}
                              className="btn btn-sm btn-secondary"
                              disabled={deleteMutation.isLoading}
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
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Pagination controls - only show when not searching */}
              {!searchQuery.trim() && total > pageSize && (
                <div className="mt-6 flex items-center justify-between border-t border-gray-200 pt-4">
                  <div className="text-sm text-gray-700">
                    Showing page {currentPage} of {totalPages} ({total} total entries)
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setCurrentPage(1)}
                      disabled={currentPage === 1}
                      className="btn btn-sm btn-secondary"
                    >
                      First
                    </button>
                    <button
                      onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                      disabled={currentPage === 1}
                      className="btn btn-sm btn-secondary"
                    >
                      Previous
                    </button>
                    <span className="px-4 py-2 text-sm text-gray-700">
                      Page {currentPage} of {totalPages}
                    </span>
                    <button
                      onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                      disabled={currentPage >= totalPages}
                      className="btn btn-sm btn-secondary"
                    >
                      Next
                    </button>
                    <button
                      onClick={() => setCurrentPage(totalPages)}
                      disabled={currentPage >= totalPages}
                      className="btn btn-sm btn-secondary"
                    >
                      Last
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-8">
              {searchQuery.trim() ? (
                <>
                  <p className="text-gray-500 mb-4">No matches found for "{searchQuery}"</p>
                  <button
                    onClick={() => {
                      setSearchQuery('');
                      setSearchResults([]);
                    }}
                    className="btn btn-secondary"
                  >
                    Clear Search
                  </button>
                </>
              ) : (
                <>
                  <p className="text-gray-500 mb-4">No translation memory entries found</p>
                  <p className="text-sm text-gray-400 mb-4">
                    Import TMX files to build your translation memory database
                  </p>
                  <button
                    onClick={() => setIsModalOpen(true)}
                    className="btn btn-primary"
                  >
                    Import Your First TMX File
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <TMImportModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          onSuccess={() => {
            // Refresh will happen automatically via React Query
          }}
        />

        <TMEntryModal
          isOpen={isEntryModalOpen}
          onClose={handleEntryModalClose}
          entry={editingEntry}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['tm'] });
            handleEntryModalClose();
          }}
        />
      </div>
    </Layout>
  );
}
