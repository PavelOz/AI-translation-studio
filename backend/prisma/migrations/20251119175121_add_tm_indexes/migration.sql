-- CreateIndex
CREATE INDEX "TranslationMemoryEntry_projectId_sourceLocale_targetLocale_idx" ON "TranslationMemoryEntry"("projectId", "sourceLocale", "targetLocale");

-- CreateIndex
CREATE INDEX "TranslationMemoryEntry_sourceLocale_targetLocale_usageCount_idx" ON "TranslationMemoryEntry"("sourceLocale", "targetLocale", "usageCount");

-- CreateIndex
CREATE INDEX "TranslationMemoryEntry_projectId_usageCount_idx" ON "TranslationMemoryEntry"("projectId", "usageCount");
