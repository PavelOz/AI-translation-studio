import apiClient from './client';

export type ClusterDocument = {
  id: string;
  name: string;
  summary: string | null;
  clusterId: string | null;
  clusterSummary: string | null;
  embeddingUpdatedAt: string | null;
  summaryGeneratedAt: string | null;
  createdAt: string;
};

export type Cluster = {
  clusterId: string;
  documentCount: number;
  documents: ClusterDocument[];
  clusterSummary: string | null;
};

export type ClusteringStats = {
  projectId: string;
  totalDocuments: number;
  documentsWithEmbeddings: number;
  documentsWithSummaries: number;
  clusteredDocuments: number;
  totalClusters: number;
  clusteringProgress: number;
};

export type SimilarDocument = {
  documentId: string;
  similarity: number;
  name: string;
};

export const clusteringApi = {
  getClusters: async (projectId: string): Promise<{
    clusters: Cluster[];
    unclustered: ClusterDocument[];
    totalClusters: number;
    totalUnclustered: number;
  }> => {
    const response = await apiClient.get(`/clustering/projects/${projectId}/clusters`);
    return response.data;
  },

  getCluster: async (clusterId: string): Promise<{
    clusterId: string;
    documentCount: number;
    clusterSummary: string | null;
    documents: ClusterDocument[];
  }> => {
    const response = await apiClient.get(`/clustering/clusters/${clusterId}`);
    return response.data;
  },

  getSimilarDocuments: async (
    documentId: string,
    minSimilarity: number = 0.7,
  ): Promise<{
    documentId: string;
    similarDocuments: SimilarDocument[];
    minSimilarity: number;
  }> => {
    const response = await apiClient.get(`/clustering/documents/${documentId}/similar`, {
      params: { minSimilarity },
    });
    return response.data;
  },

  getStats: async (projectId: string): Promise<ClusteringStats> => {
    const response = await apiClient.get(`/clustering/projects/${projectId}/stats`);
    return response.data;
  },

  triggerClustering: async (documentId: string): Promise<{
    success: boolean;
    document: ClusterDocument;
    message: string;
  }> => {
    const response = await apiClient.post(`/clustering/documents/${documentId}/cluster`);
    return response.data;
  },

  updateClusterSummary: async (clusterId: string, summary: string): Promise<{
    success: boolean;
    clusterId: string;
    summary: string;
    message: string;
  }> => {
    const response = await apiClient.patch(`/clustering/clusters/${clusterId}/summary`, {
      summary,
    });
    return response.data;
  },

  regenerateClusterSummary: async (clusterId: string): Promise<{
    success: boolean;
    clusterId: string;
    summary: string | null;
    message: string;
  }> => {
    const response = await apiClient.post(`/clustering/clusters/${clusterId}/regenerate-summary`);
    return response.data;
  },
};

