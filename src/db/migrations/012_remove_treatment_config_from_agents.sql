-- Migration: Remove treatment configuration fields from agents table
-- This migration removes treatment configuration fields from agents since they're now handled at doctor/treatment level

-- Remove treatment configuration fields from agents table
ALTER TABLE agents 
DROP COLUMN IF EXISTS return_policy_days,
DROP COLUMN IF EXISTS reimbursement_invoice_enabled,
DROP COLUMN IF EXISTS payment_methods,
DROP COLUMN IF EXISTS confirmation_channel,
DROP COLUMN IF EXISTS sent_paymentlink,
DROP COLUMN IF EXISTS apply_discount_consultancy_pix,
DROP COLUMN IF EXISTS discount_percentage_pix,
DROP COLUMN IF EXISTS use_real_availability;

-- Add comment for documentation
COMMENT ON TABLE agents IS 'Business-level AI agents with basic configuration (treatment settings moved to doctors/treatments tables)';
