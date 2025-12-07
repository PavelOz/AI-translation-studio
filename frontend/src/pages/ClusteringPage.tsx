import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import Layout from '../components/Layout';
import { clusteringApi, type Cluster, type ClusterDocument, type ClusteringStats } from '../api/clustering.api';
import { documentsApi } from '../api/documents.api';
import toast from 'react-hot-toast';
import { getLanguageName } from '../utils/languages';

export default function ClusteringPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const queryClient = useQueryClient();
  const [selectedCluster, setSelectedCluster] = useState<string | null>(null);
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set());
  const [editingClusterId, setEditingClusterId] = useState<string | null>(null);
  const [editedSummary, setEditedSummary] = useState<string>('');

  const { data: clustersData, isLoading: clustersLoading } = useQuery({
    queryKey: ['clusters', projectId],
    queryFn: () => clusteringApi.getClusters(projectId!),
    enabled: !!projectId,
    refetchInterval: 5000, // Refresh every 5 seconds
  });

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['clustering-stats', projectId],
    queryFn: () => clusteringApi.getStats(projectId!),
    enabled: !!projectId,
    refetchInterval: 5000,
  });

  const { data: selectedClusterData } = useQuery({
    queryKey: ['cluster', selectedCluster],
    queryFn: () => clusteringApi.getCluster(selectedCluster!),
    enabled: !!selectedCluster,
  });

  const triggerClusteringMutation = useMutation({
    mutationFn: (documentId: string) => clusteringApi.triggerClustering(documentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clusters', projectId] });
      queryClient.invalidateQueries({ queryKey: ['clustering-stats', projectId] });
      toast.success('Clustering triggered successfully');
    },
    onError: (error: any) => {
      const errorMessage = error.response?.data?.message || error.response?.data?.error || error.message || 'Failed to trigger clustering';
      console.error('Clustering error:', error.response?.data || error);
      toast.error(errorMessage);
    },
  });

  const updateSummaryMutation = useMutation({
    mutationFn: ({ clusterId, summary }: { clusterId: string; summary: string }) =>
      clusteringApi.updateClusterSummary(clusterId, summary),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clusters', projectId] });
      queryClient.invalidateQueries({ queryKey: ['cluster', editingClusterId] });
      setEditingClusterId(null);
      setEditedSummary('');
      toast.success('Cluster summary updated successfully');
    },
    onError: (error: any) => {
      const errorMessage = error.response?.data?.message || error.response?.data?.error || error.message || 'Failed to update summary';
      console.error('Update summary error:', error.response?.data || error);
      toast.error(errorMessage);
    },
  });

  const regenerateSummaryMutation = useMutation({
    mutationFn: (clusterId: string) => clusteringApi.regenerateClusterSummary(clusterId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clusters', projectId] });
      queryClient.invalidateQueries({ queryKey: ['cluster', selectedCluster] });
      toast.success('Cluster summary regenerated successfully');
    },
    onError: (error: any) => {
      const errorMessage = error.response?.data?.message || error.response?.data?.error || error.message || 'Failed to regenerate summary';
      console.error('Regenerate summary error:', error.response?.data || error);
      toast.error(errorMessage);
    },
  });

  const handleStartEdit = (clusterId: string, currentSummary: string | null) => {
    setEditingClusterId(clusterId);
    setEditedSummary(currentSummary || '');
  };

  const handleCancelEdit = () => {
    setEditingClusterId(null);
    setEditedSummary('');
  };

  const handleSaveEdit = (clusterId: string) => {
    if (!editedSummary.trim()) {
      toast.error('Summary cannot be empty');
      return;
    }
    updateSummaryMutation.mutate({ clusterId, summary: editedSummary.trim() });
  };

  const toggleCluster = (clusterId: string) => {
    setExpandedClusters((prev) => {
      const next = new Set(prev);
      if (next.has(clusterId)) {
        next.delete(clusterId);
      } else {
        next.add(clusterId);
      }
      return next;
    });
  };

  if (!projectId) {
    return (
      <Layout>
        <div className="text-center text-gray-500">Project ID is required</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Document Clusters</h1>
            <p className="text-gray-600 mt-2">Visualize how documents are grouped by similarity</p>
          </div>
          <Link to={`/projects/${projectId}`} className="btn btn-secondary">
            Back to Project
          </Link>
        </div>

        {/* Statistics */}
        {stats && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="card">
              <div className="text-sm text-gray-600">Total Documents</div>
              <div className="text-2xl font-bold mt-1">{stats.totalDocuments}</div>
            </div>
            <div className="card">
              <div className="text-sm text-gray-600">Clustered</div>
              <div className="text-2xl font-bold mt-1 text-primary-600">
                {stats.clusteredDocuments} / {stats.totalDocuments}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {stats.clusteringProgress}% complete
              </div>
            </div>
            <div className="card">
              <div className="text-sm text-gray-600">Total Clusters</div>
              <div className="text-2xl font-bold mt-1">{stats.totalClusters}</div>
            </div>
            <div className="card">
              <div className="text-sm text-gray-600">With Summaries</div>
              <div className="text-2xl font-bold mt-1">{stats.documentsWithSummaries}</div>
            </div>
          </div>
        )}

        {/* Progress Bar */}
        {stats && stats.totalDocuments > 0 && (
          <div className="card">
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm font-medium text-gray-700">Clustering Progress</span>
              <span className="text-sm text-gray-600">
                {stats.clusteredDocuments} / {stats.totalDocuments} documents
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-4">
              <div
                className="bg-primary-600 h-4 rounded-full transition-all duration-300"
                style={{ width: `${stats.clusteringProgress}%` }}
              />
            </div>
          </div>
        )}

        {clustersLoading || statsLoading ? (
          <div className="text-center py-12">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
            <p className="mt-4 text-gray-600">Loading clusters...</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Clusters List */}
            <div className="lg:col-span-2 space-y-4">
              {/* Clustered Documents */}
              {clustersData && clustersData.clusters.length > 0 && (
                <div>
                  <h2 className="text-xl font-semibold mb-4">
                    Clusters ({clustersData.clusters.length})
                  </h2>
                  <div className="space-y-4">
                    {clustersData.clusters.map((cluster, index) => (
                      <div key={cluster.clusterId} className="card border-l-4" style={{ borderLeftColor: `hsl(${(index * 137.5) % 360}, 70%, 50%)` }}>
                        <div
                          className="flex justify-between items-start cursor-pointer"
                          onClick={() => {
                            toggleCluster(cluster.clusterId);
                            setSelectedCluster(cluster.clusterId);
                          }}
                        >
                          <div className="flex-1">
                            <div className="flex items-center gap-3">
                              <div
                                className="w-4 h-4 rounded-full"
                                style={{ backgroundColor: `hsl(${(index * 137.5) % 360}, 70%, 50%)` }}
                              />
                              <span className="text-lg font-semibold">
                                Cluster {index + 1}
                              </span>
                              <span className="px-2 py-1 bg-primary-100 text-primary-800 rounded text-xs font-medium">
                                {cluster.documentCount} {cluster.documentCount === 1 ? 'document' : 'documents'}
                              </span>
                            </div>
                            <div className="mt-2">
                              {cluster.clusterSummary ? (
                                <p className="text-sm text-gray-600 line-clamp-2">
                                  {cluster.clusterSummary}
                                </p>
                              ) : (
                                <p className="text-xs text-gray-400 italic">
                                  Cluster summary pending...
                                </p>
                              )}
                              <div className="flex gap-2 mt-2">
                                {editingClusterId !== cluster.clusterId ? (
                                  <>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleStartEdit(cluster.clusterId, cluster.clusterSummary);
                                        setSelectedCluster(cluster.clusterId);
                                      }}
                                      className="text-xs btn btn-sm btn-secondary"
                                    >
                                      Edit Summary
                                    </button>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        regenerateSummaryMutation.mutate(cluster.clusterId);
                                      }}
                                      disabled={regenerateSummaryMutation.isLoading}
                                      className="text-xs btn btn-sm btn-secondary"
                                    >
                                      Regenerate
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleSaveEdit(cluster.clusterId);
                                      }}
                                      disabled={updateSummaryMutation.isLoading}
                                      className="text-xs btn btn-sm btn-primary"
                                    >
                                      Save
                                    </button>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleCancelEdit();
                                      }}
                                      disabled={updateSummaryMutation.isLoading}
                                      className="text-xs btn btn-sm btn-secondary"
                                    >
                                      Cancel
                                    </button>
                                  </>
                                )}
                              </div>
                              {editingClusterId === cluster.clusterId && (
                                <textarea
                                  value={editedSummary}
                                  onChange={(e) => setEditedSummary(e.target.value)}
                                  onClick={(e) => e.stopPropagation()}
                                  className="w-full text-sm text-gray-700 bg-white border border-gray-300 rounded p-2 mt-2 min-h-[100px] resize-y"
                                  placeholder="Enter cluster summary..."
                                  autoFocus
                                />
                              )}
                            </div>
                          </div>
                          <button className="ml-4 text-gray-400 hover:text-gray-600">
                            {expandedClusters.has(cluster.clusterId) ? '▼' : '▶'}
                          </button>
                        </div>

                        {expandedClusters.has(cluster.clusterId) && (
                          <div className="mt-4 space-y-2 border-t pt-4">
                            {/* Visual cluster representation */}
                            <div className="mb-3 p-3 bg-gray-50 rounded">
                              <div className="flex items-center gap-2 flex-wrap">
                                {cluster.documents.map((doc, docIndex) => (
                                  <div
                                    key={doc.id}
                                    className="px-3 py-1 bg-white border rounded text-sm font-medium text-gray-700 hover:bg-gray-50"
                                    style={{
                                      borderColor: `hsl(${(index * 137.5) % 360}, 70%, 50%)`,
                                    }}
                                  >
                                    {doc.name.length > 30 ? `${doc.name.substring(0, 30)}...` : doc.name}
                                  </div>
                                ))}
                              </div>
                            </div>
                            
                            {/* Detailed document list */}
                            {cluster.documents.map((doc) => (
                              <div
                                key={doc.id}
                                className="flex justify-between items-center p-3 bg-gray-50 rounded hover:bg-gray-100 transition-colors"
                              >
                                <div className="flex-1">
                                  <Link
                                    to={`/documents/${doc.id}`}
                                    className="font-medium text-primary-600 hover:underline"
                                  >
                                    {doc.name}
                                  </Link>
                                  {doc.summary && (
                                    <p className="text-xs text-gray-500 mt-1 line-clamp-1">
                                      {doc.summary}
                                    </p>
                                  )}
                                  {doc.embeddingUpdatedAt && (
                                    <span className="text-xs text-green-600 mt-1 inline-block">
                                      ✓ Processed
                                    </span>
                                  )}
                                </div>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    triggerClusteringMutation.mutate(doc.id);
                                  }}
                                  disabled={triggerClusteringMutation.isLoading}
                                  className="ml-4 text-xs btn btn-sm btn-secondary"
                                >
                                  Re-cluster
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Unclustered Documents */}
              {clustersData && clustersData.unclustered.length > 0 && (
                <div className="mt-6">
                  <h2 className="text-xl font-semibold mb-4">
                    Unclustered Documents ({clustersData.unclustered.length})
                  </h2>
                  <div className="space-y-2">
                    {clustersData.unclustered.map((doc) => (
                      <div
                        key={doc.id}
                        className="card flex justify-between items-center"
                      >
                        <div className="flex-1">
                          <Link
                            to={`/documents/${doc.id}`}
                            className="font-medium text-primary-600 hover:underline"
                          >
                            {doc.name}
                          </Link>
                          {doc.summary && (
                            <p className="text-xs text-gray-500 mt-1 line-clamp-1">
                              {doc.summary}
                            </p>
                          )}
                          {!doc.embeddingUpdatedAt && (
                            <span className="text-xs text-yellow-600 mt-1 inline-block">
                              ⚠️ Embedding not generated yet
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() => triggerClusteringMutation.mutate(doc.id)}
                          disabled={triggerClusteringMutation.isLoading}
                          className="ml-4 btn btn-sm btn-primary"
                        >
                          Cluster Now
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {clustersData && clustersData.clusters.length === 0 && clustersData.unclustered.length === 0 && (
                <div className="card text-center py-12">
                  <p className="text-gray-500">No documents found in this project</p>
                  <Link to={`/projects/${projectId}`} className="btn btn-primary mt-4">
                    Upload Documents
                  </Link>
                </div>
              )}
            </div>

            {/* Cluster Details Sidebar */}
            <div className="lg:col-span-1">
              {selectedClusterData && (
                <div className="card sticky top-4">
                  <h3 className="text-lg font-semibold mb-4">Cluster Details</h3>
                  <div className="space-y-4">
                    <div>
                      <div className="text-sm text-gray-600">Cluster ID</div>
                      <div className="font-mono text-xs mt-1">{selectedClusterData.clusterId}</div>
                    </div>
                    <div>
                      <div className="text-sm text-gray-600">Documents</div>
                      <div className="text-lg font-bold mt-1">
                        {selectedClusterData.documentCount}
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between items-center mb-2">
                        <div className="text-sm text-gray-600">Cluster Summary</div>
                        <div className="flex gap-2">
                          {editingClusterId !== selectedClusterData.clusterId ? (
                            <>
                              <button
                                onClick={() => handleStartEdit(selectedClusterData.clusterId, selectedClusterData.clusterSummary)}
                                className="text-xs btn btn-sm btn-secondary"
                                title="Edit summary"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => regenerateSummaryMutation.mutate(selectedClusterData.clusterId)}
                                disabled={regenerateSummaryMutation.isLoading}
                                className="text-xs btn btn-sm btn-secondary"
                                title="Regenerate with AI"
                              >
                                {regenerateSummaryMutation.isLoading ? 'Regenerating...' : 'Regenerate'}
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => handleSaveEdit(selectedClusterData.clusterId)}
                                disabled={updateSummaryMutation.isLoading}
                                className="text-xs btn btn-sm btn-primary"
                              >
                                {updateSummaryMutation.isLoading ? 'Saving...' : 'Save'}
                              </button>
                              <button
                                onClick={handleCancelEdit}
                                disabled={updateSummaryMutation.isLoading}
                                className="text-xs btn btn-sm btn-secondary"
                              >
                                Cancel
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {editingClusterId === selectedClusterData.clusterId ? (
                        <textarea
                          value={editedSummary}
                          onChange={(e) => setEditedSummary(e.target.value)}
                          className="w-full text-sm text-gray-700 bg-white border border-gray-300 rounded p-3 min-h-[150px] resize-y"
                          placeholder="Enter cluster summary..."
                          autoFocus
                        />
                      ) : selectedClusterData.clusterSummary ? (
                        <p className="text-sm text-gray-700 bg-gray-50 p-3 rounded whitespace-pre-wrap">
                          {selectedClusterData.clusterSummary}
                        </p>
                      ) : (
                        <p className="text-sm text-gray-400 italic bg-gray-50 p-3 rounded">
                          No summary available. Click "Regenerate" to generate one.
                        </p>
                      )}
                    </div>
                    <div>
                      <div className="text-sm text-gray-600 mb-2">Documents in Cluster</div>
                      <div className="space-y-2">
                        {selectedClusterData.documents.map((doc) => (
                          <Link
                            key={doc.id}
                            to={`/documents/${doc.id}`}
                            className="block text-sm text-primary-600 hover:underline"
                          >
                            {doc.name}
                          </Link>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {!selectedClusterData && (
                <div className="card">
                  <h3 className="text-lg font-semibold mb-4">How Clustering Works</h3>
                  <div className="space-y-3 text-sm text-gray-600">
                    <p>
                      Documents are automatically grouped into clusters based on semantic similarity.
                    </p>
                    <p>
                      <strong>Similarity threshold:</strong> 75% minimum
                    </p>
                    <p>
                      <strong>Process:</strong>
                    </p>
                    <ol className="list-decimal list-inside space-y-1 ml-2">
                      <li>Document summary is generated</li>
                      <li>Document embedding is created</li>
                      <li>Similar documents are found</li>
                      <li>Documents are assigned to clusters</li>
                      <li>Cluster summary is generated</li>
                    </ol>
                    <p className="mt-4 text-xs text-gray-500">
                      Clustering happens automatically after document upload. You can manually trigger
                      clustering for unclustered documents.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}

