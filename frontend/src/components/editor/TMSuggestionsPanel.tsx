import { useState, useEffect, useRef } from 'react';
import { tmApi } from '../../api/tm.api';
import type { TmSearchResult } from '../../api/tm.api';
import { segmentsApi } from '../../api/segments.api';
import toast from 'react-hot-toast';

interface TMSuggestionsPanelProps {
  sourceText: string;
  sourceLocale: string;
  targetLocale: string;
  projectId?: string;
  segmentId: string;
  currentTargetText?: string; // Current target text of the segment to check if empty
  onApply: (targetText: string) => void;
}

// TM Search Profiles: Preset configurations for different translation scenarios
// Legal: High precision, strict matching (70% min, strict mode, 70% vector)
// Technical: Balanced precision/recall (50% min, strict mode, 50% vector)
// Explore: Maximum recall, relaxed matching (40% min, extended mode, 30% vector)
type TMProfile = 'legal' | 'technical' | 'explore' | 'custom';

const TM_PROFILES: Record<'legal' | 'technical' | 'explore', {
  minScore: number;
  mode: 'basic' | 'extended';
  useVectorSearch: boolean;
  vectorSimilarity: number;
}> = {
  legal: {
    minScore: 70,
    mode: 'basic',
    useVectorSearch: true,
    vectorSimilarity: 70,
  },
  technical: {
    minScore: 50,
    mode: 'basic',
    useVectorSearch: true,
    vectorSimilarity: 50,
  },
  explore: {
    minScore: 40,
    mode: 'extended',
    useVectorSearch: true,
    vectorSimilarity: 30,
  },
};

export default function TMSuggestionsPanel({
  sourceText,
  sourceLocale,
  targetLocale,
  projectId,
  segmentId,
  currentTargetText,
  onApply,
}: TMSuggestionsPanelProps) {
  const [suggestions, setSuggestions] = useState<TmSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const searchAbortControllerRef = useRef<AbortController | null>(null);
  const currentSearchTextRef = useRef<string>(''); // Track current search text to prevent stale results
  
  // Load profile from localStorage, default to 'technical'
  const [profile, setProfile] = useState<TMProfile>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('tm-profile');
        if (saved === 'legal' || saved === 'technical' || saved === 'explore' || saved === 'custom') {
          return saved;
        }
      } catch (error) {
        console.warn('Failed to load TM profile from localStorage:', error);
      }
    }
    return 'technical'; // Default to 'technical' (balanced profile)
  });
  
  // Initialize settings from profile or localStorage
  const [minScore, setMinScore] = useState(() => {
    // First try to load from profile
    if (typeof window !== 'undefined') {
      try {
        const savedProfile = localStorage.getItem('tm-profile');
        if (savedProfile === 'legal' || savedProfile === 'technical' || savedProfile === 'explore') {
          return TM_PROFILES[savedProfile].minScore;
        }
        // Fallback to localStorage
        const saved = localStorage.getItem('tm-min-score');
        if (saved) {
          const parsed = parseInt(saved, 10);
          if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
            return parsed;
          }
        }
      } catch (error) {
        console.warn('Failed to load min score from localStorage:', error);
      }
    }
    return TM_PROFILES.technical.minScore; // Default from technical profile
  });
  
  const [vectorSimilarity, setVectorSimilarity] = useState(() => {
    // First try to load from profile
    if (typeof window !== 'undefined') {
      try {
        const savedProfile = localStorage.getItem('tm-profile');
        if (savedProfile === 'legal' || savedProfile === 'technical' || savedProfile === 'explore') {
          return TM_PROFILES[savedProfile].vectorSimilarity;
        }
        // Fallback to localStorage
        const saved = localStorage.getItem('tm-vector-similarity');
        if (saved) {
          const parsed = parseInt(saved, 10);
          if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
            return parsed;
          }
        }
      } catch (error) {
        console.warn('Failed to load vector similarity from localStorage:', error);
      }
    }
    return TM_PROFILES.technical.vectorSimilarity; // Default from technical profile
  });
  
  const [mode, setMode] = useState<'basic' | 'extended'>(() => {
    // First try to load from profile
    if (typeof window !== 'undefined') {
      try {
        const savedProfile = localStorage.getItem('tm-profile');
        if (savedProfile === 'legal' || savedProfile === 'technical' || savedProfile === 'explore') {
          return TM_PROFILES[savedProfile].mode;
        }
        // Fallback to localStorage
        const saved = localStorage.getItem('tm-mode');
        if (saved === 'basic' || saved === 'extended') {
          return saved;
        }
      } catch (error) {
        console.warn('Failed to load TM mode from localStorage:', error);
      }
    }
    return TM_PROFILES.technical.mode; // Default from technical profile
  });
  
  const [useVectorSearch, setUseVectorSearch] = useState(() => {
    // First try to load from profile
    if (typeof window !== 'undefined') {
      try {
        const savedProfile = localStorage.getItem('tm-profile');
        if (savedProfile === 'legal' || savedProfile === 'technical' || savedProfile === 'explore') {
          return TM_PROFILES[savedProfile].useVectorSearch;
        }
        // Fallback to localStorage
        const saved = localStorage.getItem('tm-use-vector-search');
        if (saved !== null) {
          return saved === 'true';
        }
      } catch (error) {
        console.warn('Failed to load useVectorSearch from localStorage:', error);
      }
    }
    return TM_PROFILES.technical.useVectorSearch; // Default from technical profile
  });
  const [searchStatus, setSearchStatus] = useState<{
    isSearching: boolean;
    lastSearchText?: string;
    matchCount?: number;
    searchTime?: number;
  }>({ isSearching: false });
  const autoAppliedRef = useRef<string | null>(null); // Track which segment we've auto-applied to prevent loops

  // Helper function to check if current settings match a profile
  const detectProfile = (currentMinScore: number, currentMode: 'basic' | 'extended', currentUseVector: boolean, currentVectorSim: number): TMProfile => {
    for (const [profileName, preset] of Object.entries(TM_PROFILES)) {
      if (
        preset.minScore === currentMinScore &&
        preset.mode === currentMode &&
        preset.useVectorSearch === currentUseVector &&
        preset.vectorSimilarity === currentVectorSim
      ) {
        return profileName as 'legal' | 'technical' | 'explore';
      }
    }
    return 'custom';
  };

  // Apply a profile preset to all settings
  const applyProfile = (nextProfile: 'legal' | 'technical' | 'explore') => {
    const preset = TM_PROFILES[nextProfile];
    setProfile(nextProfile);
    setMinScore(preset.minScore);
    setMode(preset.mode);
    setUseVectorSearch(preset.useVectorSearch);
    setVectorSimilarity(preset.vectorSimilarity);
    // Persist profile
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('tm-profile', nextProfile);
      } catch (error) {
        console.warn('Failed to save TM profile to localStorage:', error);
      }
    }
  };

  // Save minScore to localStorage when it changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('tm-min-score', minScore.toString());
      } catch (error) {
        console.warn('Failed to save min score to localStorage:', error);
      }
    }
  }, [minScore]);

  // Save vectorSimilarity to localStorage when it changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('tm-vector-similarity', vectorSimilarity.toString());
      } catch (error) {
        console.warn('Failed to save vector similarity to localStorage:', error);
      }
    }
  }, [vectorSimilarity]);
  
  // Save mode to localStorage when it changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('tm-mode', mode);
      } catch (error) {
        console.warn('Failed to save TM mode to localStorage:', error);
      }
    }
  }, [mode]);
  
  // Save useVectorSearch to localStorage when it changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('tm-use-vector-search', useVectorSearch.toString());
      } catch (error) {
        console.warn('Failed to save useVectorSearch to localStorage:', error);
      }
    }
  }, [useVectorSearch]);
  
  // Detect profile changes when settings change (but avoid infinite loops)
  useEffect(() => {
    const detected = detectProfile(minScore, mode, useVectorSearch, vectorSimilarity);
    if (detected !== profile) {
      setProfile(detected);
      if (detected !== 'custom' && typeof window !== 'undefined') {
        try {
          localStorage.setItem('tm-profile', detected);
        } catch (error) {
          // Ignore
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minScore, mode, useVectorSearch, vectorSimilarity]);
  
  // Save profile to localStorage when it changes (only for preset profiles)
  useEffect(() => {
    if (typeof window !== 'undefined' && profile !== 'custom') {
      try {
        localStorage.setItem('tm-profile', profile);
      } catch (error) {
        console.warn('Failed to save TM profile to localStorage:', error);
      }
    }
  }, [profile]);

  // Reset auto-applied flag when segment changes
  useEffect(() => {
    if (autoAppliedRef.current !== segmentId) {
      autoAppliedRef.current = null;
    }
  }, [segmentId]);

  // Track previous values to detect if only settings changed (not sourceText)
  const prevSettingsRef = useRef({ minScore, vectorSimilarity, mode, useVectorSearch });
  const prevSourceTextRef = useRef(sourceText);

  useEffect(() => {
    // Cancel any pending search when parameters change
    if (searchAbortControllerRef.current) {
      searchAbortControllerRef.current.abort();
      searchAbortControllerRef.current = null;
    }

    // Auto-search when source text changes - with debouncing for performance
    if (!sourceText.trim()) {
      setSuggestions([]);
      setSearchStatus({ isSearching: false });
      currentSearchTextRef.current = '';
      prevSourceTextRef.current = sourceText;
      return;
    }

    // Update current search text immediately
    currentSearchTextRef.current = sourceText;

    // Check if only settings changed (not sourceText) - trigger immediate search
    const sourceTextChanged = prevSourceTextRef.current !== sourceText;
    const settingsChanged = 
      prevSettingsRef.current.minScore !== minScore ||
      prevSettingsRef.current.vectorSimilarity !== vectorSimilarity ||
      prevSettingsRef.current.mode !== mode ||
      prevSettingsRef.current.useVectorSearch !== useVectorSearch;

    // Update refs
    prevSourceTextRef.current = sourceText;
    prevSettingsRef.current = { minScore, vectorSimilarity, mode, useVectorSearch };

    // If only settings changed (not sourceText), search immediately without debounce
    if (settingsChanged && !sourceTextChanged && sourceText.trim()) {
      loadSuggestions(sourceText);
      return;
    }

    // If sourceText changed, use debounce to avoid too many requests
    const debounceTimer = setTimeout(() => {
      // Double-check that sourceText hasn't changed during debounce
      if (currentSearchTextRef.current === sourceText) {
        loadSuggestions(sourceText);
      }
    }, 300); // 300ms debounce for text input

    return () => {
      clearTimeout(debounceTimer);
      // Cancel search if component unmounts or parameters change
      if (searchAbortControllerRef.current) {
        searchAbortControllerRef.current.abort();
        searchAbortControllerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceText, sourceLocale, targetLocale, projectId, minScore, vectorSimilarity, mode, useVectorSearch]);

  const loadSuggestions = async (textToSearch: string) => {
    if (!textToSearch.trim()) {
      setSuggestions([]);
      setSearchStatus({ isSearching: false });
      currentSearchTextRef.current = '';
      return;
    }

    // Cancel any previous search
    if (searchAbortControllerRef.current) {
      searchAbortControllerRef.current.abort();
    }

    // Create new AbortController for this search
    const abortController = new AbortController();
    searchAbortControllerRef.current = abortController;
    const searchText = textToSearch; // Capture the search text for this request

    setIsLoading(true);
    setSearchStatus({ 
      isSearching: true, 
      lastSearchText: searchText,
      matchCount: undefined,
    });
    
    const startTime = Date.now();
    
    try {
      // Use actual locales from document, or empty string to search all locales
      // Empty string is better than '*' because backend handles it more gracefully
      const searchSourceLocale = sourceLocale && sourceLocale.trim() ? sourceLocale.trim() : '';
      const searchTargetLocale = targetLocale && targetLocale.trim() ? targetLocale.trim() : '';
      
      const results = await tmApi.search({
        sourceText: searchText,
        sourceLocale: searchSourceLocale,
        targetLocale: searchTargetLocale,
        projectId,
        limit: 10,
        minScore, // Use the adjustable minScore from state
        vectorSimilarity, // Vector search similarity threshold
        mode, // Search mode: 'basic' = strict, 'extended' = relaxed thresholds
        useVectorSearch, // Whether to use semantic (vector) search
      }, abortController.signal);
      
      // Check if this request was aborted or if sourceText has changed
      if (abortController.signal.aborted) {
        return; // Don't update state if request was cancelled
      }
      
      // Verify the results are for the current search text
      if (currentSearchTextRef.current !== searchText) {
        console.log('Search results discarded - source text changed during search');
        return; // Don't update state if sourceText changed
      }
      
      const searchTime = Date.now() - startTime;
      const matches = results || [];
      
      setSuggestions(matches);
      setSearchStatus({
        isSearching: false,
        lastSearchText: searchText,
        matchCount: matches.length,
        searchTime,
      });
      
      // Auto-apply 100% match if segment is empty
      const isSegmentEmpty = !currentTargetText || currentTargetText.trim() === '';
      const perfectMatch = matches.find((m) => m.fuzzyScore === 100);
      
      if (isSegmentEmpty && perfectMatch && perfectMatch.targetText && autoAppliedRef.current !== segmentId) {
        // Only auto-apply once per segment to prevent loops
        autoAppliedRef.current = segmentId;
        console.log('Auto-applying 100% TM match to empty segment:', perfectMatch);
        // Use setTimeout to avoid state update during render
        setTimeout(() => {
          onApply(perfectMatch.targetText);
          // Also update via API in background
          if (segmentId) {
            const updatePayload: any = {
              targetFinal: perfectMatch.targetText,
              targetMt: perfectMatch.targetText,
              status: 'MT',
            };
            if (typeof perfectMatch.fuzzyScore === 'number' && !isNaN(perfectMatch.fuzzyScore)) {
              updatePayload.fuzzyScore = perfectMatch.fuzzyScore;
            }
            if (perfectMatch.id && perfectMatch.id !== 'linked-' && !perfectMatch.id.startsWith('linked-')) {
              updatePayload.bestTmEntryId = perfectMatch.id;
            }
            segmentsApi.update(segmentId, updatePayload).catch((error: any) => {
              console.error('Failed to save auto-applied TM match:', error);
            });
          }
        }, 100);
      }
    } catch (error: any) {
      // Ignore abort errors
      if (error.name === 'AbortError' || abortController.signal.aborted) {
        return;
      }
      
      const searchTime = Date.now() - startTime;
      console.error('TM search error:', error);
      const errorMessage = error.response?.data?.message || error.message || 'Failed to load TM suggestions';
      
      // Only show error if this is still the current search
      if (currentSearchTextRef.current === searchText) {
        toast.error(errorMessage);
        setSuggestions([]);
        setSearchStatus({
          isSearching: false,
          lastSearchText: searchText,
          matchCount: 0,
          searchTime,
        });
      }
    } finally {
      // Only update loading state if this is still the current search
      if (currentSearchTextRef.current === searchText && !abortController.signal.aborted) {
        setIsLoading(false);
      }
    }
  };

  const handleApply = async (suggestion: TmSearchResult) => {
    if (!segmentId) {
      toast.error('No segment selected');
      console.error('handleApply: segmentId is missing');
      return;
    }
    
    if (!suggestion.targetText || !suggestion.targetText.trim()) {
      toast.error('TM suggestion has no target text');
      console.error('handleApply: suggestion.targetText is empty', suggestion);
      return;
    }

    // Update UI immediately (optimistic update) before API call
    onApply(suggestion.targetText);

    try {
      // Update the segment with the TM match
      const updatePayload: any = {
        targetFinal: suggestion.targetText,
        targetMt: suggestion.targetText, // Also set targetMt for consistency
        status: 'MT',
      };
      
      // Only include fuzzyScore if it's a valid number
      if (typeof suggestion.fuzzyScore === 'number' && !isNaN(suggestion.fuzzyScore)) {
        updatePayload.fuzzyScore = suggestion.fuzzyScore;
      }
      
      // Only include bestTmEntryId if suggestion has a valid id
      if (suggestion.id && suggestion.id !== 'linked-' && !suggestion.id.startsWith('linked-')) {
        updatePayload.bestTmEntryId = suggestion.id;
      }
      
      // Call the API in the background (don't await - fire and forget for speed)
      segmentsApi.update(segmentId, updatePayload).catch((error: any) => {
        console.error('Failed to save TM suggestion:', error);
        toast.error('Failed to save changes. Please try again.');
      });
      
      toast.success(`TM match (${suggestion.fuzzyScore || 0}%) applied`);
    } catch (error: any) {
      const errorMessage = error.response?.data?.message || error.message || 'Failed to apply suggestion';
      toast.error(errorMessage);
      console.error('Failed to apply TM suggestion:', error);
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 95) return 'text-green-600';
    if (score >= 85) return 'text-blue-600';
    if (score >= 70) return 'text-yellow-600';
    return 'text-gray-600';
  };

  // Calculate differences between source texts for non-100% matches
  // Uses a simple LCS-based diff algorithm to highlight additions and deletions
  // Shows what's different in the TM match compared to the current segment
  const getTextDifferences = (currentText: string, tmText: string) => {
    if (currentText.toLowerCase().trim() === tmText.toLowerCase().trim()) {
      return null; // No differences
    }

    // Normalize texts for comparison (preserve original for display)
    const current = currentText.trim();
    const tm = tmText.trim();
    
    // Split into words while preserving spaces
    const currentWords = current.split(/(\s+)/).filter(Boolean);
    const tmWords = tm.split(/(\s+)/).filter(Boolean);
    
    // Normalize words for comparison (trim and lowercase, but preserve original for display)
    const normalizeWord = (word: string) => {
      const trimmed = word.trim();
      return trimmed.toLowerCase();
    };
    
    // Build LCS (Longest Common Subsequence) matrix for word-level diff
    const m = currentWords.length;
    const n = tmWords.length;
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    
    // Build the DP matrix
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const currentNorm = normalizeWord(currentWords[i - 1]);
        const tmNorm = normalizeWord(tmWords[j - 1]);
        // Only match non-empty words (skip pure whitespace)
        if (currentNorm === tmNorm && currentNorm.length > 0) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }
    
    // Reconstruct the diff - showing what changes to make to TM to get current segment
    // "removed" = word in TM but not in current (DELETE from TM - red strikethrough)
    // "added" = word in current but not in TM (ADD to TM - green highlight)
    // "unchanged" = word in both (keep as is)
    const differences: Array<{ text: string; type: 'added' | 'removed' | 'unchanged' }> = [];
    let i = m;
    let j = n;
    
    while (i > 0 || j > 0) {
      const currentNorm = i > 0 ? normalizeWord(currentWords[i - 1]) : '';
      const tmNorm = j > 0 ? normalizeWord(tmWords[j - 1]) : '';
      
      // First priority: try to match words
      if (i > 0 && j > 0 && currentNorm === tmNorm && currentNorm.length > 0) {
        // Match found - show TM word as unchanged
        differences.unshift({ text: tmWords[j - 1], type: 'unchanged' });
        i--;
        j--;
      } 
      // Second priority: check which direction gives better LCS score
      else if (i === 0) {
        // Only TM words left - these need to be DELETED from TM (removed)
        differences.unshift({ text: tmWords[j - 1], type: 'removed' });
        j--;
      } else if (j === 0) {
        // Only current words left - these need to be ADDED to TM (added)
        differences.unshift({ text: currentWords[i - 1], type: 'added' });
        i--;
      } else {
        // Both have words - use LCS to decide direction
        if (dp[i][j - 1] > dp[i - 1][j]) {
          // Going left (TM) gives better score - TM word is not in current, DELETE it (removed)
          differences.unshift({ text: tmWords[j - 1], type: 'removed' });
          j--;
        } else if (dp[i - 1][j] > dp[i][j - 1]) {
          // Going up (current) gives better score - current word is not in TM, ADD it (added)
          differences.unshift({ text: currentWords[i - 1], type: 'added' });
          i--;
        } else {
          // Equal scores - both directions are equally good
          // When scores are equal, we need to check which word can be matched later
          // Strategy: check if current word can match any remaining TM word
          // and if TM word can match any remaining current word
          
          let currentCanMatchLater = false;
          let tmCanMatchLater = false;
          
          // Check if current word can match any remaining TM word (looking ahead)
          if (j > 1) {
            for (let k = j - 2; k >= 0; k--) {
              const currentWordNorm = normalizeWord(currentWords[i - 1]);
              const tmWordNorm = normalizeWord(tmWords[k]);
              if (currentWordNorm === tmWordNorm && currentWordNorm.length > 0) {
                currentCanMatchLater = true;
                break;
              }
            }
          }
          
          // Check if TM word can match any remaining current word (looking ahead)
          if (i > 1) {
            for (let k = i - 2; k >= 0; k--) {
              const tmWordNorm = normalizeWord(tmWords[j - 1]);
              const currentWordNorm = normalizeWord(currentWords[k]);
              if (tmWordNorm === currentWordNorm && tmWordNorm.length > 0) {
                tmCanMatchLater = true;
                break;
              }
            }
          }
          
          // Decision logic:
          // - If current can match later but TM cannot → ADD current now (it will match later in TM)
          // - If TM can match later but current cannot → DELETE TM now (it will match later in current)
          // - If both can match later → prefer showing deletion first (DELETE before ADD)
          // - If neither can match later → they're truly different, DELETE TM first
          if (currentCanMatchLater && !tmCanMatchLater) {
            // Current word will match later in TM → ADD it now (added)
            differences.unshift({ text: currentWords[i - 1], type: 'added' });
            i--;
          } else if (tmCanMatchLater && !currentCanMatchLater) {
            // TM word will match later in current → DELETE it now (removed)
            differences.unshift({ text: tmWords[j - 1], type: 'removed' });
            j--;
          } else {
            // Both or neither can match later - prefer showing deletion first (DELETE from TM)
            differences.unshift({ text: tmWords[j - 1], type: 'removed' });
            j--;
          }
        }
      }
    }
    
    return differences;
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="mb-3">
        <div className="flex justify-between items-center mb-2">
          <h3 className="font-semibold text-gray-900">Translation Memory</h3>
          {searchStatus.matchCount !== undefined && !isLoading && (
            <span className="text-xs text-gray-500">
              {searchStatus.matchCount} match{searchStatus.matchCount !== 1 ? 'es' : ''}
              {searchStatus.searchTime && searchStatus.searchTime > 0 && (
                <span className="ml-1">({searchStatus.searchTime}ms)</span>
              )}
            </span>
          )}
        </div>
        
        {/* TM Settings */}
        <div className="bg-gray-50 border border-gray-200 rounded p-2 space-y-2">
          <div className="text-xs font-semibold text-gray-700 mb-1">TM Settings</div>
          
          {/* Profiles */}
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="text-[11px] text-gray-600">Profiles:</span>
            <button
              type="button"
              onClick={() => applyProfile('legal')}
              className={`text-[11px] px-2 py-1 rounded border transition-colors ${
                profile === 'legal'
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
              }`}
              title="Legal: High precision (70% min, strict mode, 70% vector)"
            >
              Legal
            </button>
            <button
              type="button"
              onClick={() => applyProfile('technical')}
              className={`text-[11px] px-2 py-1 rounded border transition-colors ${
                profile === 'technical'
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
              }`}
              title="Technical: Balanced (50% min, strict mode, 50% vector)"
            >
              Technical
            </button>
            <button
              type="button"
              onClick={() => applyProfile('explore')}
              className={`text-[11px] px-2 py-1 rounded border transition-colors ${
                profile === 'explore'
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
              }`}
              title="Explore: Maximum recall (40% min, extended mode, 30% vector)"
            >
              Explore
            </button>
          </div>
          
          {/* Min TM Match (%) */}
          <div className="flex items-center justify-between">
            <label 
              className="text-xs font-medium text-gray-700"
              title="Minimum similarity for TM matches. Higher = stricter, fewer matches."
            >
              Min TM Match (%):
            </label>
            <select
              value={minScore}
              onChange={(e) => setMinScore(parseInt(e.target.value, 10))}
              className="text-xs border border-gray-300 rounded px-2 py-1 bg-white"
            >
              <option value="40">40</option>
              <option value="50">50</option>
              <option value="60">60</option>
              <option value="70">70</option>
            </select>
          </div>
          
          {/* TM Mode */}
          <div className="flex items-center justify-between">
            <span 
              className="text-xs font-medium text-gray-700"
              title="Strict: only structurally close sentences. Extended: allows looser matches."
            >
              Mode:
            </span>
            <div className="flex gap-3">
              <label className="flex items-center gap-1 text-xs cursor-pointer">
                <input
                  type="radio"
                  name="tm-mode"
                  value="basic"
                  checked={mode === 'basic'}
                  onChange={(e) => setMode(e.target.value as 'basic' | 'extended')}
                  className="cursor-pointer"
                />
                <span>Strict</span>
              </label>
              <label className="flex items-center gap-1 text-xs cursor-pointer">
                <input
                  type="radio"
                  name="tm-mode"
                  value="extended"
                  checked={mode === 'extended'}
                  onChange={(e) => setMode(e.target.value as 'basic' | 'extended')}
                  className="cursor-pointer"
                />
                <span>Extended</span>
              </label>
            </div>
          </div>
          
          {/* Use semantic search */}
          <div className="flex items-center justify-between">
            <label 
              className="text-xs font-medium text-gray-700"
              title="Enables semantic (vector) search for meaning-based TM matches."
            >
              Use semantic TM:
            </label>
            <input
              type="checkbox"
              checked={useVectorSearch}
              onChange={(e) => setUseVectorSearch(e.target.checked)}
              className="cursor-pointer"
            />
          </div>
        </div>

        {/* Vector Similarity Threshold Slider */}
        <div className="bg-gray-50 border border-gray-200 rounded p-2 mt-2">
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-medium text-gray-700">
              Vector Similarity Threshold:
            </label>
            <span className="text-xs font-semibold text-green-600">
              {vectorSimilarity}%
            </span>
          </div>
          <input
            type="range"
            min="50"
            max="100"
            value={vectorSimilarity}
            onChange={(e) => setVectorSimilarity(parseInt(e.target.value, 10))}
            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-green-600"
            style={{
              background: `linear-gradient(to right, rgb(16, 185, 129) 0%, rgb(16, 185, 129) ${(vectorSimilarity - 50) * 2}%, rgb(229, 231, 235) ${(vectorSimilarity - 50) * 2}%, rgb(229, 231, 235) 100%)`,
            }}
          />
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>50%</span>
            <span>75%</span>
            <span>100%</span>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            Semantic (vector) search threshold. Lower = more semantic matches
          </p>
        </div>
      </div>

      {/* Search Status */}
      {isLoading && (
        <div className="bg-blue-50 border border-blue-200 rounded p-2 mb-3">
          <div className="flex items-center gap-2">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
            <span className="text-sm text-blue-700">Searching translation memory...</span>
          </div>
          {searchStatus.lastSearchText && (
            <div className="text-xs text-blue-600 mt-1 ml-6">
              Searching for: "{searchStatus.lastSearchText.substring(0, 50)}{searchStatus.lastSearchText.length > 50 ? '...' : ''}"
            </div>
          )}
        </div>
      )}

      {!isLoading && searchStatus.matchCount !== undefined && searchStatus.matchCount > 0 && (
        <div className="bg-green-50 border border-green-200 rounded p-2 mb-3">
          <div className="text-sm text-green-700">
            ✓ Found {searchStatus.matchCount} match{searchStatus.matchCount !== 1 ? 'es' : ''}
            {searchStatus.searchTime && searchStatus.searchTime > 0 && (
              <span className="ml-1">in {searchStatus.searchTime}ms</span>
            )}
          </div>
        </div>
      )}

      {!isLoading && searchStatus.matchCount === 0 && searchStatus.lastSearchText && (
        <div className="bg-yellow-50 border border-yellow-200 rounded p-2 mb-3">
          <div className="text-sm text-yellow-700">
            ⚠ No matches found
            {projectId && (
              <span className="text-xs block mt-1">Searched in project and global TM</span>
            )}
          </div>
        </div>
      )}

          {!isLoading && suggestions.length === 0 && (
        <div className="text-sm text-gray-500 text-center py-4">
          No suggestions found
          {projectId && (
            <div className="text-xs text-gray-400 mt-1">
              Searching in project and global TM
            </div>
          )}
        </div>
      )}

      {!isLoading && suggestions.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs text-gray-500 mb-2">
            Found {suggestions.length} match{suggestions.length !== 1 ? 'es' : ''}
          </div>
          {suggestions.map((suggestion, index) => {
            const isPerfectMatch = suggestion.fuzzyScore === 100;
            const differences = !isPerfectMatch ? getTextDifferences(sourceText, suggestion.sourceText) : null;
            
            return (
            <div
              key={suggestion.id || index}
              className="border border-gray-200 rounded p-3 hover:bg-gray-50 transition-colors"
            >
              <div className="flex justify-between items-start mb-2">
                <div className="flex-1">
                  {isPerfectMatch ? (
                    <div className="text-sm text-gray-600 mb-1">{suggestion.sourceText}</div>
                  ) : differences ? (
                    <div className="text-sm text-gray-600 mb-1">
                      <span className="text-xs text-gray-500 mb-1 block">Differences:</span>
                      <div className="bg-gray-50 p-2 rounded border border-gray-200">
                        {differences.map((diff, idx) => (
                          <span
                            key={idx}
                            className={
                              diff.type === 'added'
                                ? 'bg-green-200 text-green-800 px-1 rounded font-medium'
                                : diff.type === 'removed'
                                  ? 'bg-red-200 text-red-800 px-1 rounded line-through'
                                  : 'text-gray-700'
                            }
                          >
                            {diff.text}
                          </span>
                        ))}
                      </div>
                      <div className="text-xs text-gray-500 mt-2 flex gap-3">
                        <span className="flex items-center gap-1">
                          <span className="inline-block w-3 h-3 bg-green-200 rounded"></span>
                          Add to TM
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="inline-block w-3 h-3 bg-red-200 rounded line-through"></span>
                          Delete from TM
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-gray-600 mb-1">{suggestion.sourceText}</div>
                  )}
                  <div className="text-sm font-medium text-gray-900 mt-2">{suggestion.targetText}</div>
                </div>
              <div className="ml-3 flex flex-col items-end gap-1">
                <span className={`text-sm font-semibold ${getScoreColor(suggestion.fuzzyScore)}`}>
                  {suggestion.fuzzyScore}%
                </span>
                {/* Search Method Badge */}
                {suggestion.searchMethod && (
                  <span
                    className={`text-xs px-2 py-0.5 rounded font-medium ${
                      suggestion.searchMethod === 'vector'
                        ? 'bg-green-100 text-green-700'
                        : suggestion.searchMethod === 'hybrid'
                          ? 'bg-purple-100 text-purple-700'
                          : 'bg-blue-100 text-blue-700'
                    }`}
                    title={
                      suggestion.searchMethod === 'vector'
                        ? 'Found via semantic (vector) search'
                        : suggestion.searchMethod === 'hybrid'
                          ? 'Found via both fuzzy and vector search'
                          : 'Found via fuzzy (text-based) search'
                    }
                  >
                    {suggestion.searchMethod === 'vector'
                      ? '🔍 Vector'
                      : suggestion.searchMethod === 'hybrid'
                        ? '🔀 Hybrid'
                        : '📝 Fuzzy'}
                  </span>
                )}
                <span className="text-xs text-gray-500 mt-1">
                  {suggestion.scope === 'project' ? 'Project' : 'Global'}
                </span>
                {suggestion.tmxFileName && (
                  <span className="text-xs text-primary-600 mt-1 font-medium" title={`From TMX: ${suggestion.tmxFileName}`}>
                    {suggestion.tmxFileName}
                    {suggestion.tmxFileSource === 'linked' && ' (linked)'}
                  </span>
                )}
              </div>
              </div>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleApply(suggestion);
                }}
                className="btn btn-primary text-xs w-full mt-2"
                type="button"
              >
                Apply
              </button>
            </div>
          );
          })}
        </div>
      )}
    </div>
  );
}

