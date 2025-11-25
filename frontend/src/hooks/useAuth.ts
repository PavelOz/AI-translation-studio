import { useMutation, useQuery, useQueryClient } from 'react-query';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../api/auth.api';
import { useAuthStore } from '../stores/authStore';
import toast from 'react-hot-toast';

export const useAuth = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { login, logout, isAuthenticated } = useAuthStore();

  const loginMutation = useMutation({
    mutationFn: authApi.login,
    onSuccess: (data) => {
      login(data.token, data.user);
      queryClient.invalidateQueries();
      navigate('/');
      toast.success('Logged in successfully');
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.message || 'Login failed');
    },
  });

  const registerMutation = useMutation({
    mutationFn: authApi.register,
    onSuccess: () => {
      toast.success('Registration successful. Please login.');
      navigate('/login');
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.message || 'Registration failed');
    },
  });

  const { data: currentUser } = useQuery({
    queryKey: ['currentUser'],
    queryFn: authApi.getCurrentUser,
    enabled: isAuthenticated,
  });

  const handleLogout = () => {
    logout();
    queryClient.clear();
    navigate('/login');
    toast.success('Logged out successfully');
  };

  return {
    login: loginMutation.mutate,
    register: registerMutation.mutate,
    logout: handleLogout,
    isLoading: loginMutation.isPending || registerMutation.isPending,
    currentUser,
  };
};



