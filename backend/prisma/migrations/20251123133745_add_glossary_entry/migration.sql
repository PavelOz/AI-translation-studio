/*
  Warnings:

  - You are about to drop the column `description` on the `GlossaryEntry` table. All the data in the column will be lost.
  - You are about to drop the column `forbidden` on the `GlossaryEntry` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `GlossaryEntry` table. All the data in the column will be lost.
  - Added the required column `direction` to the `GlossaryEntry` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "GlossaryEntry" DROP COLUMN "description",
DROP COLUMN "forbidden",
DROP COLUMN "status",
ADD COLUMN     "client" TEXT,
ADD COLUMN     "direction" TEXT NOT NULL,
ADD COLUMN     "domain" TEXT,
ADD COLUMN     "isForbidden" BOOLEAN NOT NULL DEFAULT false;
