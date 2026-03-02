add# Quality Control Station Components

## Overview

Quality Control Station provides a comprehensive UI for managing translation quality, DNA validation, and enrichment.

## Components

### 1. DNAValidationHeader
**Location:** `DNAValidationHeader.tsx`

**Features:**
- Displays DNA validation status (OK, WARNING, ERROR)
- Shows number of issues and DNA rules count
- Button to launch CSV enrichment modal
- Enrichment modal with CSV upload, LLM options, and provider selection

**Props:**
```typescript
{
  documentId: string;
}
```

**Usage:**
```tsx
<DNAValidationHeader documentId={documentId} />
```

---

### 2. QualityStatsGrid
**Location:** `QualityStatsGrid.tsx`

**Features:**
- 4 stat cards displaying:
  - Total Segments
  - DNA Rules (from validation)
  - Suspicious Found (from universal janitor)
  - Resolved (sum of fixed issues)

**Props:**
```typescript
{
  report: JanitorReport | null;
  validation: DnaContractValidationResult | null | undefined;
}
```

**Usage:**
```tsx
<QualityStatsGrid report={report} validation={validation} />
```

---

### 3. BatchProgress
**Location:** `BatchProgress.tsx`

**Features:**
- Progress bar showing enrichment progress
- Batch number and current/total rows
- Status indicators (processing, completed, error)
- Log of last 5 added entries with timestamps

**Props:**
```typescript
{
  progress: EnrichmentProgress | null;
}
```

**Usage:**
```tsx
<BatchProgress progress={enrichmentProgress} />
```

**Note:** Currently not connected to real-time enrichment progress. To enable:
1. Add WebSocket or polling for enrichment progress
2. Update enrichment endpoint to support progress streaming

---

### 4. QualityErrorsTable
**Location:** `QualityErrorsTable.tsx`

**Features:**
- Interactive table of quality errors from universal janitor
- Columns: ID, Type, Detail, Action
- "Add to DNA" button for SUSPICIOUS_ABBREV errors
- Groups errors by type (SUSPICIOUS_ABBREV, FORBIDDEN_SCRIPT, other)
- Extracts abbreviation from error detail and adds to DNA

**Props:**
```typescript
{
  documentId: string;
  unfixable: UnfixableEntry[];
}
```

**Usage:**
```tsx
<QualityErrorsTable 
  documentId={documentId} 
  unfixable={report.unfixable || []} 
/>
```

**Features:**
- Automatically extracts abbreviation from error detail
- Adds entry to DNA with key = abbreviation, shortForm = abbreviation
- Refreshes validation and janitor reports after adding
- Shows loading state during addition

---

## API Integration

### New API Methods

#### `analysisApi.addAbbreviationToDna`
Adds a single abbreviation entry to DNA.

```typescript
analysisApi.addAbbreviationToDna(
  documentId: string,
  key: string,
  longForm: string,
  shortForm: string
): Promise<DocumentDnaPayload>
```

**Implementation:**
1. Fetches current DNA
2. Adds new entry to `abbreviationLogic`
3. Updates DNA via `PUT /documents/:documentId/dna`
4. Returns updated DNA

---

## Integration in QualityControlPage

The `QualityControlPage` now includes:

1. **DNAValidationHeader** - At the top, shows validation status
2. **QualityStatsGrid** - Stats cards below header
3. **QualityErrorsTable** - Main errors table with Add to DNA
4. **ErrorLogExplorer** - Legacy component (still available)
5. **SpotCheckWizard** - Legacy component (still available)

**Layout:**
```
┌─────────────────────────────────────┐
│  DNA Validation Header              │
├─────────────────────────────────────┤
│  Stats Grid (4 cards)               │
├─────────────────────────────────────┤
│  Quality Errors Table               │
│  (with Add to DNA buttons)          │
├─────────────────────────────────────┤
│  Error Log Explorer (legacy)        │
├─────────────────────────────────────┤
│  Spot Check Wizard (legacy)         │
└─────────────────────────────────────┘
```

---

## Data Flow

### Adding Abbreviation to DNA

1. User clicks "Add to DNA" on a SUSPICIOUS_ABBREV error
2. Component extracts abbreviation from error detail
3. Calls `analysisApi.addAbbreviationToDna`
4. API fetches current DNA, adds entry, saves
5. Component invalidates queries:
   - `dna-validation`
   - `document-dna`
   - `validator-janitor`
6. UI automatically refreshes

### Enrichment from CSV

1. User clicks "Enrich from CSV" in header
2. Modal opens for CSV upload
3. User selects file, configures LLM options
4. Calls `analysisApi.enrichDocumentDnaFromCSV`
5. Backend processes CSV in batches
6. Success toast shows statistics
7. Queries invalidated, UI refreshes

---

## Future Enhancements

1. **Real-time Batch Progress:**
   - WebSocket connection for enrichment progress
   - Or polling endpoint for progress updates
   - Connect `BatchProgress` component to live data

2. **Enhanced Error Details:**
   - Show source/target text in error table
   - Link to segment editor
   - Bulk actions for multiple errors

3. **DNA Rule Editor:**
   - Inline editing of DNA rules
   - Validation feedback
   - Conflict detection

4. **Statistics Dashboard:**
   - Historical trends
   - Error rate over time
   - DNA coverage metrics
