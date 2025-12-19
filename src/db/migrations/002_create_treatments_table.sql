-- Migration: Create treatments table for beauty clinic service
-- Based on specifications from beauty clinic form requirements

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

-- Create trigger for updated_at
CREATE TRIGGER touch_treatments_updated_at
BEFORE UPDATE ON treatments FOR EACH ROW EXECUTE PROCEDURE trg_touch_updated_at();

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_treatments_owner ON treatments(owner_id);
CREATE INDEX IF NOT EXISTS idx_treatments_category ON treatments(main_category);
CREATE INDEX IF NOT EXISTS idx_treatments_active ON treatments(is_active);
CREATE INDEX IF NOT EXISTS idx_treatments_price ON treatments(price);
CREATE INDEX IF NOT EXISTS idx_treatments_areas ON treatments USING GIN (applicable_areas);

