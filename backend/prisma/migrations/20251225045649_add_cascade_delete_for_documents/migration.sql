/*
  Warnings:

  - The values [CANDIDATE] on the enum `GlossaryStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `clusterId` on the `Document` table. All the data in the column will be lost.
  - You are about to drop the column `clusterSummary` on the `Document` table. All the data in the column will be lost.
  - You are about to drop the column `documentEmbedding` on the `Document` table. All the data in the column will be lost.
  - You are about to drop the column `embeddingModel` on the `Document` table. All the data in the column will be lost.
  - You are about to drop the column `embeddingUpdatedAt` on the `Document` table. All the data in the column will be lost.
  - You are about to drop the column `summary` on the `Document` table. All the data in the column will be lost.
  - You are about to drop the column `summaryGeneratedAt` on the `Document` table. All the data in the column will be lost.
  - You are about to drop the column `contextRules` on the `GlossaryEntry` table. All the data in the column will be lost.
  - You are about to drop the column `embeddingModel` on the `GlossaryEntry` table. All the data in the column will be lost.
  - You are about to drop the column `embeddingUpdatedAt` on the `GlossaryEntry` table. All the data in the column will be lost.
  - You are about to drop the column `sourceEmbedding` on the `GlossaryEntry` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `GlossaryEntry` table. All the data in the column will be lost.
  - You are about to drop the column `segmentType` on the `Segment` table. All the data in the column will be lost.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "GlossaryStatus_new" AS ENUM ('PREFERRED', 'DEPRECATED');
ALTER TABLE "GlossaryEntry" ALTER COLUMN "status" DROP DEFAULT;
ALTER TYPE "GlossaryStatus" RENAME TO "GlossaryStatus_old";
ALTER TYPE "GlossaryStatus_new" RENAME TO "GlossaryStatus";
DROP TYPE "GlossaryStatus_old";
COMMIT;

-- DropIndex
DROP INDEX "Document_clusterId_idx";

-- DropIndex
DROP INDEX "Document_documentEmbedding_idx";

-- DropIndex
DROP INDEX "GlossaryEntry_sourceEmbedding_idx";

-- AlterTable
ALTER TABLE "Document" DROP COLUMN "clusterId",
DROP COLUMN "clusterSummary",
DROP COLUMN "documentEmbedding",
DROP COLUMN "embeddingModel",
DROP COLUMN "embeddingUpdatedAt",
DROP COLUMN "summary",
DROP COLUMN "summaryGeneratedAt";

-- AlterTable
ALTER TABLE "DocumentAnalysis" ADD COLUMN     "executionLogs" JSONB;

-- AlterTable
ALTER TABLE "GlossaryEntry" DROP COLUMN "contextRules",
DROP COLUMN "embeddingModel",
DROP COLUMN "embeddingUpdatedAt",
DROP COLUMN "sourceEmbedding",
DROP COLUMN "status";

-- AlterTable
ALTER TABLE "Segment" DROP COLUMN "segmentType";
