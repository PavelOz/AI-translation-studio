import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User, UserRole } from '../api/auth.api';

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  login: (token: string, user: User) => void;
  logout: () => void;
  updateUser: (user: Partial<User>) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      login: (token, user) => {
        set({ token, user, isAuthenticated: true });
      },
      logout: () => {
        set({ user: null, token: null, isAuthenticated: false });
      },
      updateUser: (user) => {
        set((state) => ({
          user: state.user ? { ...state.user, ...user } : null,
        }));
      },
    }),
    {
      name: 'auth-storage',
    },
  ),
);



