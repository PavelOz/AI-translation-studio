# Cascade Delete Fix Summary

## Problem
Foreign key constraint violations when deleting Projects and Documents.

## Root Causes Found
1. **QualityMetric.segmentId** - Had RESTRICT constraint (now fixed to CASCADE)
2. **Segment.documentId** - Had RESTRICT constraint (now fixed to CASCADE)  
3. **AIRequest.documentId** - Had RESTRICT constraint (now fixed to CASCADE)
4. **Prisma Client Out of Sync** - Client doesn't know about DocumentAnalysis, DocumentGlossaryEntry models

## Fixes Applied
✅ All Project foreign key relations now have `onDelete: Cascade`
✅ All Document foreign key relations now have `onDelete: Cascade`
✅ QualityMetric.segmentId now has `onDelete: Cascade`
✅ Database constraints updated via migrations

## Required Action
**The Prisma client MUST be regenerated for changes to take effect:**

1. **Stop the backend server** (Ctrl+C)
2. Run: `cd backend && npx prisma generate`
3. **Restart the backend server**

The database constraints are correct, but Prisma client is using old schema information.

## Verification
After regenerating Prisma client, all cascade deletes should work:
- Delete Project → Cascades to Documents → Cascades to Segments → Cascades to QualityMetrics
- Delete Document → Cascades to Segments, AIRequests, DocumentAnalysis, etc.



