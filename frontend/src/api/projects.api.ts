import apiClient from './client';

export type ProjectStatus = 'PLANNING' | 'IN_PROGRESS' | 'COMPLETED' | 'ON_HOLD';

export type Project = {
  id: string;
  name: string;
  description?: string;
  clientName?: string;
  domain?: string;
  sourceLocale: string;
  targetLocales: string[];
  status: ProjectStatus;
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateProjectRequest = {
  name: string;
  description?: string;
  clientName?: string;
  domain?: string;
  sourceLocale: string;
  targetLocales: string[];
  dueDate?: string;
};

export type UpdateProjectRequest = Partial<CreateProjectRequest> & {
  status?: ProjectStatus;
};

export type ProjectMember = {
  id: string;
  userId: string;
  projectId: string;
  role: string;
  user: {
    id: string;
    name: string;
    email: string;
  };
};

export const projectsApi = {
  list: async (): Promise<Project[]> => {
    const response = await apiClient.get<Project[]>('/projects');
    return response.data;
  },

  get: async (projectId: string): Promise<Project> => {
    const response = await apiClient.get<Project>(`/projects/${projectId}`);
    return response.data;
  },

  create: async (data: CreateProjectRequest): Promise<Project> => {
    const response = await apiClient.post<Project>('/projects', data);
    return response.data;
  },

  update: async (projectId: string, data: UpdateProjectRequest): Promise<Project> => {
    const response = await apiClient.patch<Project>(`/projects/${projectId}`, data);
    return response.data;
  },

  delete: async (projectId: string): Promise<void> => {
    await apiClient.delete(`/projects/${projectId}`);
  },

  getMembers: async (projectId: string): Promise<ProjectMember[]> => {
    const response = await apiClient.get<ProjectMember[]>(`/projects/${projectId}/members`);
    return response.data;
  },

  addMember: async (projectId: string, userId: string, role: string): Promise<ProjectMember> => {
    const response = await apiClient.post<ProjectMember>(`/projects/${projectId}/members`, {
      userId,
      role,
    });
    return response.data;
  },

  removeMember: async (projectId: string, userId: string): Promise<void> => {
    await apiClient.delete(`/projects/${projectId}/members/${userId}`);
  },
};



