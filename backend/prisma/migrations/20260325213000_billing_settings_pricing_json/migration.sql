-- AlterTable: optional JSON pricing registry (overrides bundled billing-pricing.v1.json when set)
ALTER TABLE "BillingSettings" ADD COLUMN "pricingJson" JSONB;
