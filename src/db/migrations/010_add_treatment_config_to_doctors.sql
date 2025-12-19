-- Migration: Add treatment configuration fields to doctors table
-- This migration moves treatment/consultation configuration from agents to individual doctors

-- Add treatment configuration fields to doctors table
ALTER TABLE doctors 
ADD COLUMN IF NOT EXISTS return_policy_days INTEGER DEFAULT 30,
ADD COLUMN IF NOT EXISTS reimbursement_invoice_enabled BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS payment_methods JSONB DEFAULT '{"credit_card_installments": 4, "pix_enabled": true}'::jsonb,
ADD COLUMN IF NOT EXISTS confirmation_channel TEXT DEFAULT 'whatsapp' CHECK (confirmation_channel IN ('whatsapp', 'sms', 'email')),
ADD COLUMN IF NOT EXISTS sent_paymentlink BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS apply_discount_consultancy_pix BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS discount_percentage_pix INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS use_real_availability BOOLEAN DEFAULT false;

-- Add comments for documentation
COMMENT ON COLUMN doctors.return_policy_days IS 'Number of days for included follow-up consultation';
COMMENT ON COLUMN doctors.reimbursement_invoice_enabled IS 'If enabled, inform user invoice is available for insurance claims';
COMMENT ON COLUMN doctors.payment_methods IS 'Payment methods configuration (credit card installments, PIX enabled)';
COMMENT ON COLUMN doctors.confirmation_channel IS 'Channel for sending confirmations (whatsapp, sms, email)';
COMMENT ON COLUMN doctors.sent_paymentlink IS 'Whether to automatically send payment links after consultation booking';
COMMENT ON COLUMN doctors.apply_discount_consultancy_pix IS 'Whether to apply discount to consultation pricing for PIX payments';
COMMENT ON COLUMN doctors.discount_percentage_pix IS 'Discount percentage for PIX payments (0-100)';
COMMENT ON COLUMN doctors.use_real_availability IS 'If true, show real calendar slots; if false, use scarcity method (1 month ahead)';

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_doctors_return_policy ON doctors(return_policy_days);
CREATE INDEX IF NOT EXISTS idx_doctors_payment_methods ON doctors USING GIN (payment_methods);
CREATE INDEX IF NOT EXISTS idx_doctors_confirmation_channel ON doctors(confirmation_channel);
