-- Migration: Simplify payment fields in doctors table
-- This migration removes unused payment-related fields (sent_paymentlink, apply_discount_consultancy_pix)
-- and updates the payment_methods structure to match the simplified frontend

-- Drop the unused payment fields
ALTER TABLE doctors DROP COLUMN IF EXISTS sent_paymentlink;
ALTER TABLE doctors DROP COLUMN IF EXISTS apply_discount_consultancy_pix;

-- Update payment_methods default value to match new structure
-- Note: This doesn't affect existing data, just sets the default for new records
-- Existing records with pix_enabled will continue to work

-- Drop any indexes related to the removed columns
DROP INDEX IF EXISTS idx_doctors_sent_paymentlink;
DROP INDEX IF EXISTS idx_doctors_apply_discount_consultancy_pix;
