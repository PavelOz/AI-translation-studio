import { useQuery } from 'react-query';
import { analysisApi, type StageMonitoringData, type LogEntry } from '../api/analysis.api';
import { useParams, Link } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';

export default function StageMonitoringDashboard() {
  const { documentId } = useParams<{ documentId: string }>();
  const [showLogs] = useState(true); // Always expanded - no toggle needed
  const [expandedStages, setExpandedStages] = useState<Set<string>>(new Set());
  const logsEndRef = useRef<HTMLDivElement>(null);
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const stageLogRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const { data: monitoringData, isLoading, error, refetch } = useQuery({
    queryKey: ['stage-monitoring', documentId],
    queryFn: () => analysisApi.getStageMonitoring(documentId!),
    enabled: !!documentId,
    refetchInterval: (data) => {
      // Poll every 2 seconds if analysis is running, otherwise stop
      if (data?.status === 'RUNNING' || data?.status === 'PENDING') {
        return 2000;
      }
      return false;
    },
  });

  useEffect(() => {
    // Refetch when component mounts if analysis is running
    if (monitoringData?.status === 'RUNNING') {
      const interval = setInterval(() => {
        refetch();
      }, 2000);
      return () => clearInterval(interval);
    }
  }, [monitoringData?.status, refetch]);

  // Auto-scroll logs to bottom when new logs arrive - STRICTLY enforce auto-scroll
  useEffect(() => {
    if (logsContainerRef.current && logsEndRef.current) {
      // Always scroll to bottom when new logs arrive (strict auto-scroll)
      // Use requestAnimationFrame for smooth scrolling
      requestAnimationFrame(() => {
        if (logsEndRef.current) {
          logsEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
      });
    }
  }, [monitoringData?.logs?.length]); // Trigger on log count change

  // Also scroll on initial load and when data first loads
  useEffect(() => {
    if (logsContainerRef.current && monitoringData?.logs && monitoringData.logs.length > 0) {
      // Small delay to ensure DOM is ready
      const timer = setTimeout(() => {
        if (logsEndRef.current) {
          logsContainerRef.current?.scrollTo({
            top: logsContainerRef.current.scrollHeight,
            behavior: 'auto',
          });
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [monitoringData?.logs]);

  // Format log message with JSON data
  const formatLogMessage = (entry: LogEntry): string => {
    let message = entry.message;
    
    // Format data if present
    if (entry.data) {
      try {
        // Format arrays and objects nicely
        const formattedData: string[] = [];
        
        for (const [key, value] of Object.entries(entry.data)) {
          if (Array.isArray(value)) {
            // Format arrays - show first few items, then count
            if (value.length === 0) {
              formattedData.push(`  ${key}: []`);
            } else if (value.length <= 5) {
              formattedData.push(`  ${key}: [${value.map(v => typeof v === 'string' ? `"${v.substring(0, 50)}"` : JSON.stringify(v)).join(', ')}]`);
            } else {
              formattedData.push(`  ${key}: [${value.slice(0, 3).map(v => typeof v === 'string' ? `"${v.substring(0, 50)}"` : JSON.stringify(v)).join(', ')}, ... and ${value.length - 3} more]`);
            }
          } else if (typeof value === 'object' && value !== null) {
            // Format objects - show key-value pairs
            const objStr = JSON.stringify(value, null, 2);
            if (objStr.length < 200) {
              formattedData.push(`  ${key}: ${objStr.split('\n').join('\n    ')}`);
            } else {
              formattedData.push(`  ${key}: ${objStr.substring(0, 200)}...`);
            }
          } else {
            // Simple values
            formattedData.push(`  ${key}: ${typeof value === 'string' && value.length > 100 ? value.substring(0, 100) + '...' : value}`);
          }
        }
        
        if (formattedData.length > 0) {
          message += '\n' + formattedData.join('\n');
        }
      } catch (e) {
        message += `\n  Data: [Unable to format: ${String(e)}]`;
      }
    }
    
    return message;
  };

  const getLogLevelColor = (level: LogEntry['level']) => {
    switch (level) {
      case 'error':
        return '#f44336'; // Red
      case 'warn':
        return '#ff9800'; // Orange
      case 'debug':
        return '#9e9e9e'; // Grey
      default:
        return '#4caf50'; // Green
    }
  };

  // Filter logs by stage
  const getLogsForStage = (stageName: string): LogEntry[] => {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'StageMonitoringDashboard.tsx:125',message:'getLogsForStage called',data:{stageName,hasMonitoringData:!!monitoringData,hasLogs:!!monitoringData?.logs,logCount:monitoringData?.logs?.length||0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'F'})}).catch(()=>{});
    // #endregion
    if (!monitoringData?.logs) {
      console.debug('[StageMonitoringDashboard] No logs in monitoringData', { monitoringData });
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'StageMonitoringDashboard.tsx:128',message:'No logs in monitoringData',data:{stageName,monitoringDataStatus:monitoringData?.status},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'F'})}).catch(()=>{});
      // #endregion
      return [];
    }
    const filtered = monitoringData.logs.filter(log => log.stage === stageName);
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'StageMonitoringDashboard.tsx:133',message:'Log filtering result',data:{stageName,totalLogs:monitoringData.logs.length,matchingLogs:filtered.length,allStageNames:[...new Set(monitoringData.logs.map(l => l.stage))],sampleLogStages:monitoringData.logs.slice(0,5).map(l=>l.stage)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'F'})}).catch(()=>{});
    // #endregion
    console.debug(`[StageMonitoringDashboard] Filtering logs for "${stageName}":`, {
      totalLogs: monitoringData.logs.length,
      matchingLogs: filtered.length,
      allStageNames: [...new Set(monitoringData.logs.map(l => l.stage))],
    });
    return filtered;
  };

  // Toggle stage log expansion
  const toggleStageLogs = (stageId: string) => {
    setExpandedStages(prev => {
      const next = new Set(prev);
      if (next.has(stageId)) {
        next.delete(stageId);
      } else {
        next.add(stageId);
      }
      return next;
    });
  };

  // Auto-scroll stage logs when expanded
  useEffect(() => {
    expandedStages.forEach(stageId => {
      const logRef = stageLogRefs.current[stageId];
      if (logRef) {
        setTimeout(() => {
          logRef.scrollTop = logRef.scrollHeight;
        }, 100);
      }
    });
  }, [monitoringData?.logs, expandedStages]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading monitoring data...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="text-red-600 text-xl mb-2">Error loading monitoring data</div>
          <p className="text-gray-600">{(error as Error).message}</p>
          <Link to={`/documents/${documentId}`} className="text-primary-600 hover:underline mt-4 inline-block">
            ← Back to Document
          </Link>
        </div>
      </div>
    );
  }

  if (!monitoringData) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-600">No monitoring data available</p>
          <Link to={`/documents/${documentId}`} className="text-primary-600 hover:underline mt-4 inline-block">
            ← Back to Document
          </Link>
        </div>
      </div>
    );
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-green-100 text-green-800 border-green-300';
      case 'active':
        return 'bg-blue-100 text-blue-800 border-blue-300';
      case 'error':
        return 'bg-red-100 text-red-800 border-red-300';
      default:
        return 'bg-gray-100 text-gray-600 border-gray-300';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return '✓';
      case 'active':
        return '⟳';
      case 'error':
        return '✗';
      default:
        return '○';
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Glossary Extraction Monitor</h1>
              <p className="text-gray-600 mt-1">{monitoringData.documentName || `Document ${monitoringData.documentId}`}</p>
              <div className="flex gap-4 mt-2 text-sm text-gray-500">
                <span>{monitoringData.sourceLocale} → {monitoringData.targetLocale}</span>
                <span>•</span>
                <span>{monitoringData.totalSegments} segments</span>
                <span>•</span>
                <span>{monitoringData.glossaryCount} glossary terms</span>
              </div>
            </div>
            <Link
              to={`/documents/${documentId}`}
              className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors"
            >
              ← Back
            </Link>
          </div>
        </div>

        {/* Overall Progress */}
        <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-gray-900">Overall Progress</h2>
            <span className={`px-3 py-1 rounded-full text-sm font-medium ${
              monitoringData.status === 'COMPLETED' ? 'bg-green-100 text-green-800' :
              monitoringData.status === 'RUNNING' ? 'bg-blue-100 text-blue-800' :
              monitoringData.status === 'FAILED' ? 'bg-red-100 text-red-800' :
              'bg-gray-100 text-gray-800'
            }`}>
              {monitoringData.status}
            </span>
          </div>
          <div className="mb-4">
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm font-medium text-gray-700">
                {monitoringData.currentStageInfo.name}
              </span>
              <span className="text-sm font-semibold text-primary-600">
                {monitoringData.progress.overall}%
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-4 overflow-hidden">
              <div
                className="bg-gradient-to-r from-primary-500 to-primary-600 h-4 rounded-full transition-all duration-500"
                style={{ width: `${monitoringData.progress.overall}%` }}
              ></div>
            </div>
          </div>
          {monitoringData.progress.message && (
            <p className="text-sm text-gray-600 mt-2">{monitoringData.progress.message}</p>
          )}
          <p className="text-xs text-gray-500 mt-2">
            Last updated: {new Date(monitoringData.progress.updatedAt).toLocaleString()}
          </p>
        </div>

        {/* Stages */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-6">Extraction Stages</h2>
          <div className="space-y-4">
            {monitoringData.stages.map((stage, index) => {
              const stageLogs = getLogsForStage(stage.name);
              const hasLogs = stageLogs.length > 0;
              const isExpanded = expandedStages.has(stage.id);
              
              return (
                <div
                  key={stage.id}
                  className={`border-2 rounded-lg transition-all ${
                    stage.status === 'active' ? 'ring-2 ring-primary-500 ring-opacity-50' : ''
                  } ${getStatusColor(stage.status)}`}
                >
                  <div className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <span className="text-2xl font-bold">{getStatusIcon(stage.status)}</span>
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <h3 className="font-semibold text-lg">{stage.name}</h3>
                              <span className={`text-xs px-2 py-0.5 rounded-full ${
                                hasLogs 
                                  ? 'bg-blue-100 text-blue-700' 
                                  : 'bg-gray-100 text-gray-500'
                              }`}>
                                {stageLogs.length} log{stageLogs.length !== 1 ? 's' : ''}
                              </span>
                            </div>
                            <p className="text-sm opacity-80 mt-1">{stage.description}</p>
                          </div>
                        </div>
                        <div className="mt-3">
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-xs font-medium">Stage Progress</span>
                            <span className="text-xs font-semibold">{stage.progress}%</span>
                          </div>
                          <div className="w-full bg-white bg-opacity-50 rounded-full h-2 overflow-hidden">
                            <div
                              className={`h-2 rounded-full transition-all duration-500 ${
                                stage.status === 'active' ? 'bg-blue-500' :
                                stage.status === 'completed' ? 'bg-green-500' :
                                stage.status === 'error' ? 'bg-red-500' :
                                'bg-gray-300'
                              }`}
                              style={{ width: `${stage.progress}%` }}
                            ></div>
                          </div>
                        </div>
                        <div className="mt-2 text-xs opacity-70">
                          Overall: {stage.progressRange[0]}% - {stage.progressRange[1]}%
                        </div>
                      </div>
                    </div>
                    
                    {/* Stage Logs Toggle Button - Always visible, always clickable */}
                    <button
                      onClick={() => toggleStageLogs(stage.id)}
                      className={`mt-3 w-full text-left text-sm flex items-center justify-between py-2 px-3 rounded border transition-colors ${
                        hasLogs
                          ? 'text-gray-600 hover:text-gray-900 bg-gray-50 border-gray-200 hover:bg-gray-100'
                          : 'text-gray-600 hover:text-gray-900 bg-gray-50 border-gray-200 hover:bg-gray-100'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span>{isExpanded ? '▼' : '▶'}</span>
                        <span>
                          {hasLogs 
                            ? `View ${stageLogs.length} execution log${stageLogs.length !== 1 ? 's' : ''}`
                            : 'View logs (0 logs - waiting for stage to process)'
                          }
                        </span>
                      </span>
                    </button>
                  </div>
                  
                  {/* Stage Logs Window - Always expandable, even with 0 logs */}
                  {isExpanded && (
                    <div className="border-t border-gray-200 bg-[#111]">
                      <div
                        ref={(el) => {
                          stageLogRefs.current[stage.id] = el;
                        }}
                        className="bg-[#111] text-[#4caf50] font-mono text-xs p-3 overflow-y-auto"
                        style={{ height: '200px', maxHeight: '300px' }}
                      >
                        {hasLogs ? (
                          stageLogs.map((log, logIndex) => (
                            <div key={logIndex} className="mb-1.5">
                              <div className="flex items-start gap-2">
                                <span className="text-gray-600 text-xs flex-shrink-0 font-mono">
                                  {new Date(log.timestamp).toLocaleTimeString()}
                                </span>
                                <span
                                  className="text-xs font-semibold flex-shrink-0 font-mono"
                                  style={{ color: getLogLevelColor(log.level) }}
                                >
                                  [{log.level.toUpperCase()}]
                                </span>
                                <pre className="text-[#4caf50] whitespace-pre-wrap break-words flex-1 font-mono leading-relaxed text-xs">
                                  {formatLogMessage(log)}
                                </pre>
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="text-gray-500 text-center py-8 font-mono">
                            <div className="mb-2">No logs yet for this stage</div>
                            <div className="text-xs text-gray-600">
                              Logs will appear here as "{stage.name}" processes.
                            </div>
                            <div className="text-xs text-gray-600 mt-2">
                              {monitoringData.status === 'RUNNING' 
                                ? 'Waiting for stage to execute...'
                                : 'Stage has not been executed yet.'
                              }
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Summary Stats */}
        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white rounded-lg shadow-sm p-4">
            <div className="text-sm text-gray-600 mb-1">Glossary Terms</div>
            <div className="text-2xl font-bold text-gray-900">{monitoringData.glossaryCount}</div>
            <div className="text-xs text-gray-500 mt-1">
              {monitoringData.glossaryExtracted ? 'Extraction completed' : 'Extraction in progress'}
            </div>
          </div>
          <div className="bg-white rounded-lg shadow-sm p-4">
            <div className="text-sm text-gray-600 mb-1">Current Stage</div>
            <div className="text-2xl font-bold text-gray-900">
              {monitoringData.currentStageInfo.id ? 
                monitoringData.stages.findIndex(s => s.id === monitoringData.currentStageInfo.id) + 1 :
                '-'
              } / {monitoringData.stages.length}
            </div>
            <div className="text-xs text-gray-500 mt-1">{monitoringData.currentStageInfo.name}</div>
          </div>
          <div className="bg-white rounded-lg shadow-sm p-4">
            <div className="text-sm text-gray-600 mb-1">Status</div>
            <div className="text-2xl font-bold text-gray-900">{monitoringData.status}</div>
            <div className="text-xs text-gray-500 mt-1">
              {monitoringData.status === 'RUNNING' && 'Auto-refreshing every 2s'}
            </div>
          </div>
        </div>

        {/* Execution Logs Terminal - Always Visible, Live Stream */}
        <div className="mt-6 bg-white rounded-lg shadow-sm overflow-hidden">
          <div className="w-full px-6 py-4 bg-gray-50 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">Execution Logs</h2>
                {(!monitoringData.logs || monitoringData.logs.length === 0) && monitoringData.status === 'RUNNING' && (
                  <p className="text-xs text-amber-600 mt-1">
                    ⚠️ No logs yet. If logs don't appear, the executionLogs database column may need to be added.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3">
                {monitoringData.status === 'RUNNING' && (
                  <span className="flex items-center gap-2 text-sm text-green-600">
                    <span className="inline-block w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                    Live
                  </span>
                )}
                <span className="text-sm text-gray-500">
                  {monitoringData.logs?.length || 0} entries
                </span>
              </div>
            </div>
          </div>
          
          {/* Live Terminal Window */}
          <div
            ref={logsContainerRef}
            className="bg-[#111] text-[#4caf50] font-mono text-sm p-4 overflow-y-auto border-t-2 border-gray-800"
            style={{ height: '300px' }}
          >
            {monitoringData.logs && monitoringData.logs.length > 0 ? (
              <>
                {monitoringData.logs.map((log, index) => (
                  <div key={index} className="mb-1.5">
                    <div className="flex items-start gap-2">
                      <span className="text-gray-600 text-xs flex-shrink-0 font-mono">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                      <span
                        className="text-xs font-semibold flex-shrink-0 font-mono"
                        style={{ color: getLogLevelColor(log.level) }}
                      >
                        [{log.level.toUpperCase()}]
                      </span>
                      <span className="text-[#4caf50] flex-shrink-0 min-w-[220px] font-mono">
                        {log.stage}:
                      </span>
                      <pre className="text-[#4caf50] whitespace-pre-wrap break-words flex-1 font-mono leading-relaxed">
                        {formatLogMessage(log)}
                      </pre>
                    </div>
                  </div>
                ))}
                <div ref={logsEndRef} />
              </>
            ) : (
              <div className="text-gray-500 text-center py-8 font-mono">
                <div className="mb-2">Waiting for logs...</div>
                <div className="text-xs text-gray-600">Logs will appear here as the extraction progresses.</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
