import { useEffect, useState } from 'react';
import { useQuery } from 'react-query';
import { healthApi, type HealthStatus } from '../api/health.api';

export default function DatabaseStatusIndicator() {
  const [lastStatus, setLastStatus] = useState<HealthStatus | null>(null);

  const { data: healthStatus, isLoading } = useQuery({
    queryKey: ['health'],
    queryFn: () => healthApi.check(),
    refetchInterval: 30000, // Check every 30 seconds
    retry: 2,
    retryDelay: 1000,
    onSuccess: (data) => {
      setLastStatus(data);
    },
    onError: () => {
      // On error, set disconnected status
      setLastStatus({
        status: 'error',
        database: 'disconnected',
        timestamp: new Date().toISOString(),
        error: 'Connection check failed',
      });
    },
  });

  const status = healthStatus || lastStatus;
  const isConnected = status?.database === 'connected';
  const isChecking = isLoading && !lastStatus;

  // Format timestamp for display
  const formatTime = (timestamp?: string) => {
    if (!timestamp) return '';
    try {
      const date = new Date(timestamp);
      return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return '';
    }
  };

  return (
    <div className="flex items-center gap-2" title={`Database: ${isConnected ? 'Connected' : 'Disconnected'}${status?.timestamp ? ` (${formatTime(status.timestamp)})` : ''}`}>
      <div className="relative">
        <div
          className={`w-2 h-2 rounded-full ${
            isChecking
              ? 'bg-yellow-400 animate-pulse'
              : isConnected
                ? 'bg-green-500'
                : 'bg-red-500 animate-pulse'
          }`}
        />
        {isConnected && (
          <div className="absolute inset-0 w-2 h-2 rounded-full bg-green-500 animate-ping opacity-75" />
        )}
      </div>
      <span className="text-xs text-gray-600 hidden sm:inline">
        {isChecking ? 'Checking...' : isConnected ? 'DB Connected' : 'DB Disconnected'}
      </span>
    </div>
  );
}

