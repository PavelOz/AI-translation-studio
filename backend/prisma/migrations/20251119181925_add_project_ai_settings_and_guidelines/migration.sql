-- CreateTable
CREATE TABLE "ProjectAISetting" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "temperature" DOUBLE PRECISION,
    "maxTokens" INTEGER,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectAISetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectGuideline" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "rules" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectGuideline_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAISetting_projectId_key" ON "ProjectAISetting"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectGuideline_projectId_key" ON "ProjectGuideline"("projectId");

-- AddForeignKey
ALTER TABLE "ProjectAISetting" ADD CONSTRAINT "ProjectAISetting_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectGuideline" ADD CONSTRAINT "ProjectGuideline_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
