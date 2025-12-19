-- Migration: Add consultation configuration fields to doctors table
-- This migration adds the necessary fields for the consultation configuration section

-- Add return_policy_days for follow-up consultation (number of days)
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS return_policy_days INTEGER DEFAULT 30;

-- Add reimbursement_invoice_enabled to enable/disable insurance claim notifications
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS reimbursement_invoice_enabled BOOLEAN DEFAULT false;

-- Add payment_methods as JSONB for payment configuration (installments, PIX, etc.)
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS payment_methods JSONB DEFAULT '{"credit_card_installments": 4}'::jsonb;

-- Add discount_percentage_pix for payment discount percentage (0-100)
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS discount_percentage_pix INTEGER DEFAULT 0;

-- Add use_real_availability to toggle between real calendar slots and scarcity method
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS use_real_availability BOOLEAN DEFAULT false;

-- Add comments for documentation
COMMENT ON COLUMN doctors.return_policy_days IS 'Number of days for included follow-up consultation';
COMMENT ON COLUMN doctors.reimbursement_invoice_enabled IS 'If enabled, inform user invoice is available for insurance claims';
COMMENT ON COLUMN doctors.payment_methods IS 'Payment methods configuration (credit card installments)';
COMMENT ON COLUMN doctors.discount_percentage_pix IS 'Discount percentage for payments (0-100)';
COMMENT ON COLUMN doctors.use_real_availability IS 'If true, show real calendar slots; if false, use scarcity method';

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_doctors_return_policy ON doctors(return_policy_days);
CREATE INDEX IF NOT EXISTS idx_doctors_payment_methods ON doctors USING GIN(payment_methods);
