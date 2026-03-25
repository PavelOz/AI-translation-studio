-- DropIndex
DROP INDEX "Document_documentEmbedding_idx";

-- DropIndex
DROP INDEX "GlossaryEntry_sourceEmbedding_idx";

-- CreateTable
CREATE TABLE "BillingSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "dailyCapUsd" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
    "proMinRemainingUsd" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "warnInputTokens" INTEGER NOT NULL DEFAULT 50000,
    "maxPromptChars" INTEGER NOT NULL DEFAULT 2000000,
    "powerRoles" TEXT NOT NULL DEFAULT 'ADMIN',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingSettings_pkey" PRIMARY KEY ("id")
);
