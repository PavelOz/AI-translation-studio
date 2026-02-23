import apiClient from './client';

export type Profile = {
  id: string;
  name: string;
  expertRole: string;
  instructions: string;
  terminologyJSON: unknown;
};

export type CreateProfileRequest = {
  name: string;
  expertRole?: string;
  instructions?: string;
  terminologyJSON?: unknown;
};

export type UpdateProfileRequest = {
  name?: string;
  expertRole?: string;
  instructions?: string;
  terminologyJSON?: unknown;
};

export const profilesApi = {
  list: async (): Promise<Profile[]> => {
    const response = await apiClient.get<Profile[]>('/profiles');
    return response.data;
  },

  get: async (profileId: string): Promise<Profile> => {
    const response = await apiClient.get<Profile>(`/profiles/${profileId}`);
    return response.data;
  },

  create: async (data: CreateProfileRequest): Promise<Profile> => {
    const response = await apiClient.post<Profile>('/profiles', data);
    return response.data;
  },

  update: async (profileId: string, data: UpdateProfileRequest): Promise<Profile> => {
    const response = await apiClient.patch<Profile>(`/profiles/${profileId}`, data);
    return response.data;
  },

  delete: async (profileId: string): Promise<void> => {
    await apiClient.delete(`/profiles/${profileId}`);
  },
};
