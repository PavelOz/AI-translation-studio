-- CreateTable
CREATE TABLE "ProjectDna" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "technicalSchema" JSONB,
    "namingConventions" JSONB,
    "abbreviationLogic" JSONB,
    "entityGroups" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectDna_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectDna_projectId_key" ON "ProjectDna"("projectId");

-- CreateIndex
CREATE INDEX "ProjectDna_projectId_idx" ON "ProjectDna"("projectId");

-- AddForeignKey
ALTER TABLE "ProjectDna" ADD CONSTRAINT "ProjectDna_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
