-- Migration: Fix Beauty Clinic Setup
-- This migration ensures all required tables, triggers, and data are properly set up

-- 1. Create the updated_at trigger function if it doesn't exist
CREATE OR REPLACE FUNCTION trg_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Ensure service_type column exists in users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS service_type TEXT DEFAULT 'clinic' 
  CHECK (service_type IN ('clinic', 'beauty_clinic', 'real_estate', 'insurance', 'consortia'));

-- 3. Update existing users to have service_type
UPDATE users SET service_type = 'clinic' WHERE service_type IS NULL;

-- 4. Add service_config column if it doesn't exist
ALTER TABLE users ADD COLUMN IF NOT EXISTS service_config JSONB DEFAULT '{}'::jsonb;

-- 5. Create treatments table if it doesn't exist
CREATE TABLE IF NOT EXISTS treatments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  
  -- Treatment identification (Section 1)
  name TEXT NOT NULL, -- Treatment name
  main_category TEXT NOT NULL, -- Laser, Facial, Body, Harmonization, etc.
  subcategory TEXT, -- Ultraformer, Fotona, Pulsed Light, etc.
  description TEXT NOT NULL, -- Detailed description
  
  -- Application and technical details (Section 2)
  applicable_areas TEXT[] DEFAULT ARRAY[]::TEXT[], -- Face, Neck, Abdomen, Glutes, Thighs, Arms, Armpits, Intimate, Other
  main_indication TEXT, -- Primary indication/purpose
  recommended_sessions INTEGER, -- Number of sessions recommended
  interval_between_sessions TEXT, -- "7 days", "2 weeks", etc.
  average_duration INTEGER, -- Session duration in minutes
  recovery_time TEXT, -- "No downtime", "1-2 days", "3-5 days", etc.
  contraindications TEXT, -- Contraindications description
  
  -- Commercial information (Section 3)
  price NUMERIC(10,2) NOT NULL, -- Treatment price
  payment_methods TEXT[] DEFAULT ARRAY['Pix', 'Credit Card']::TEXT[], -- Pix, Credit Card, Installments, Cash
  promotional_discount_available BOOLEAN DEFAULT false,
  special_conditions TEXT, -- Special payment or promotional conditions
  offer_validity_period TEXT, -- Validity period of the offer
  
  -- Availability (similar to doctors table for scheduling)
  working_hours JSONB DEFAULT '{}'::jsonb, -- {"monday": {"enabled": true, "timeSlots": [{"id": "1", "start": "09:00", "end": "17:00"}]}, ...}
  date_specific_availability JSONB DEFAULT '[]'::jsonb, -- [{"date": "2024-01-15", "type": "unavailable", "reason": "Holiday"}, ...]
  timezone TEXT DEFAULT 'America/Sao_Paulo',
  
  -- Google Calendar integration (for booking sessions)
  google_calendar_id TEXT, -- Google Calendar ID
  google_refresh_token TEXT, -- Encrypted OAuth2 refresh token
  google_access_token TEXT, -- Temporary access token
  google_token_expires_at TIMESTAMPTZ, -- When the access token expires
  calendar_sync_enabled BOOLEAN DEFAULT false, -- Whether calendar sync is enabled
  last_calendar_sync TIMESTAMPTZ, -- Last successful calendar sync timestamp
  
  -- System fields
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 6. Create trigger for updated_at on treatments table
DROP TRIGGER IF EXISTS touch_treatments_updated_at ON treatments;
CREATE TRIGGER touch_treatments_updated_at
BEFORE UPDATE ON treatments FOR EACH ROW EXECUTE PROCEDURE trg_touch_updated_at();

-- 7. Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_treatments_owner ON treatments(owner_id);
CREATE INDEX IF NOT EXISTS idx_treatments_category ON treatments(main_category);
CREATE INDEX IF NOT EXISTS idx_treatments_active ON treatments(is_active);
CREATE INDEX IF NOT EXISTS idx_treatments_price ON treatments(price);
CREATE INDEX IF NOT EXISTS idx_treatments_areas ON treatments USING GIN (applicable_areas);
CREATE INDEX IF NOT EXISTS idx_users_service_type ON users(service_type);

-- 8. Add polymorphic resource fields to leads table if they don't exist
ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_resource_type TEXT 
  CHECK (assigned_resource_type IN ('doctor', 'treatment', 'property', 'plan'));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_resource_id UUID;

-- 9. Create a function to update user service_type (for admin use)
CREATE OR REPLACE FUNCTION update_user_service_type(user_id UUID, new_service_type TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  -- Validate service_type
  IF new_service_type NOT IN ('clinic', 'beauty_clinic', 'real_estate', 'insurance', 'consortia') THEN
    RAISE EXCEPTION 'Invalid service_type: %', new_service_type;
  END IF;
  
  -- Update user
  UPDATE users 
  SET service_type = new_service_type, updated_at = now()
  WHERE id = user_id;
  
  -- Return true if user was found and updated
  RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- 10. Insert some sample treatments for testing (optional)
-- Uncomment the following lines if you want to add sample data
/*
INSERT INTO treatments (owner_id, name, main_category, subcategory, description, applicable_areas, price, average_duration)
SELECT 
  u.id,
  'Laser Facial Rejuvenation',
  'Facial',
  'Ultraformer',
  'Advanced laser treatment for facial skin rejuvenation and tightening',
  ARRAY['Face', 'Neck'],
  450.00,
  60
FROM users u 
WHERE u.service_type = 'beauty_clinic' 
LIMIT 1;

INSERT INTO treatments (owner_id, name, main_category, subcategory, description, applicable_areas, price, average_duration)
SELECT 
  u.id,
  'Body Contouring',
  'Body',
  'Morpheus',
  'Non-invasive body contouring treatment for fat reduction and skin tightening',
  ARRAY['Abdomen', 'Thighs', 'Arms'],
  800.00,
  90
FROM users u 
WHERE u.service_type = 'beauty_clinic' 
LIMIT 1;
*/

-- 11. Grant necessary permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON treatments TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;

-- 12. Enable Row Level Security (RLS) for treatments table
ALTER TABLE treatments ENABLE ROW LEVEL SECURITY;

-- 13. Create RLS policy for treatments
CREATE POLICY "Users can manage their own treatments" ON treatments
  FOR ALL USING (auth.uid() = owner_id);

-- 14. Create RLS policy for users table (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'users' 
    AND policyname = 'Users can view their own data'
  ) THEN
    ALTER TABLE users ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "Users can view their own data" ON users
      FOR SELECT USING (auth.uid() = id);
  END IF;
END $$;

-- 15. Add helpful comments
COMMENT ON TABLE treatments IS 'Beauty clinic treatments and services';
COMMENT ON COLUMN treatments.owner_id IS 'Reference to the user who owns this treatment';
COMMENT ON COLUMN treatments.main_category IS 'Primary treatment category (Laser, Facial, Body, etc.)';
COMMENT ON COLUMN treatments.subcategory IS 'Specific treatment type (Ultraformer, Fotona, etc.)';
COMMENT ON COLUMN treatments.applicable_areas IS 'Body areas where this treatment can be applied';
COMMENT ON COLUMN treatments.price IS 'Treatment price in local currency';
COMMENT ON COLUMN treatments.average_duration IS 'Average session duration in minutes';

-- 16. Create a view for easy treatment management
CREATE OR REPLACE VIEW treatment_summary AS
SELECT 
  t.id,
  t.name,
  t.main_category,
  t.subcategory,
  t.price,
  t.average_duration,
  t.is_active,
  t.created_at,
  u.name as owner_name,
  u.email as owner_email
FROM treatments t
JOIN users u ON t.owner_id = u.id;

-- Grant access to the view
GRANT SELECT ON treatment_summary TO authenticated;
