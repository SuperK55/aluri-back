-- Migration: Update treatments table to new client-focused schema
-- This migration transforms the treatments table from technical/administrative focus to marketing/client focus

-- Drop old columns that are no longer needed
ALTER TABLE treatments 
DROP COLUMN IF EXISTS name,
DROP COLUMN IF EXISTS main_category,
DROP COLUMN IF EXISTS subcategory,
DROP COLUMN IF EXISTS description,
DROP COLUMN IF EXISTS applicable_areas,
DROP COLUMN IF EXISTS main_indication,
DROP COLUMN IF EXISTS average_duration,
DROP COLUMN IF EXISTS recovery_time,
DROP COLUMN IF EXISTS contraindications,
DROP COLUMN IF EXISTS price,
DROP COLUMN IF EXISTS payment_methods,
DROP COLUMN IF EXISTS promotional_discount_available,
DROP COLUMN IF EXISTS special_conditions,
DROP COLUMN IF EXISTS offer_validity_period,
DROP COLUMN IF EXISTS working_hours,
DROP COLUMN IF EXISTS date_specific_availability,
DROP COLUMN IF EXISTS timezone,
DROP COLUMN IF EXISTS google_calendar_id,
DROP COLUMN IF EXISTS google_refresh_token,
DROP COLUMN IF EXISTS google_access_token,
DROP COLUMN IF EXISTS google_token_expires_at,
DROP COLUMN IF EXISTS calendar_sync_enabled,
DROP COLUMN IF EXISTS last_calendar_sync,
DROP COLUMN IF EXISTS return_policy_days,
DROP COLUMN IF EXISTS reimbursement_invoice_enabled,
DROP COLUMN IF EXISTS confirmation_channel,
DROP COLUMN IF EXISTS sent_paymentlink,
DROP COLUMN IF EXISTS apply_discount_consultancy_pix,
DROP COLUMN IF EXISTS discount_percentage_pix,
DROP COLUMN IF EXISTS use_real_availability;

-- Add new columns for the updated schema
ALTER TABLE treatments
ADD COLUMN IF NOT EXISTS treatment_name TEXT,
ADD COLUMN IF NOT EXISTS treatment_benefit TEXT,
ADD COLUMN IF NOT EXISTS pain_point_1 TEXT,
ADD COLUMN IF NOT EXISTS pain_point_2 TEXT,
ADD COLUMN IF NOT EXISTS pain_point_3 TEXT,
ADD COLUMN IF NOT EXISTS treatment_effects TEXT,
ADD COLUMN IF NOT EXISTS treatment_result TEXT,
ADD COLUMN IF NOT EXISTS client_feedback TEXT,
ADD COLUMN IF NOT EXISTS session_duration INTEGER,
ADD COLUMN IF NOT EXISTS recommended_sessions INTEGER,
ADD COLUMN IF NOT EXISTS interval_between_sessions TEXT,
ADD COLUMN IF NOT EXISTS offer_type TEXT DEFAULT 'single_session' CHECK (offer_type IN ('single_session', 'package')),
ADD COLUMN IF NOT EXISTS single_session_price NUMERIC(10,2),
ADD COLUMN IF NOT EXISTS package_sessions_count INTEGER,
ADD COLUMN IF NOT EXISTS package_price NUMERIC(10,2),
ADD COLUMN IF NOT EXISTS installment_options TEXT,
ADD COLUMN IF NOT EXISTS pix_discount_percentage INTEGER DEFAULT 0;

-- Make treatment_name NOT NULL after adding the column
ALTER TABLE treatments ALTER COLUMN treatment_name SET NOT NULL;

-- Update any existing records (if there are any) - this is a safety measure
-- In production, you'd want to migrate data appropriately
UPDATE treatments SET treatment_name = 'Legacy Treatment' WHERE treatment_name IS NULL;

-- Recreate the trigger if it was dropped
DROP TRIGGER IF EXISTS touch_treatments_updated_at ON treatments;
CREATE TRIGGER touch_treatments_updated_at
BEFORE UPDATE ON treatments FOR EACH ROW EXECUTE PROCEDURE trg_touch_updated_at();

-- Update indexes
DROP INDEX IF EXISTS idx_treatments_owner;
DROP INDEX IF EXISTS idx_treatments_active;
DROP INDEX IF EXISTS idx_treatments_offer_type;

CREATE INDEX IF NOT EXISTS idx_treatments_owner ON treatments(owner_id);
CREATE INDEX IF NOT EXISTS idx_treatments_active ON treatments(is_active);
CREATE INDEX IF NOT EXISTS idx_treatments_offer_type ON treatments(offer_type);

-- Verify the structure
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'treatments'
-- ORDER BY ordinal_position;

