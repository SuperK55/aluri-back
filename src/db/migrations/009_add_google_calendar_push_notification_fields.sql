-- Migration: Add Google Calendar push notification fields to doctors table
-- These fields store information about the active push notification channel

-- Add push notification channel fields
ALTER TABLE doctors 
ADD COLUMN IF NOT EXISTS google_calendar_channel_id TEXT,
ADD COLUMN IF NOT EXISTS google_calendar_resource_id TEXT,
ADD COLUMN IF NOT EXISTS google_calendar_channel_expiration TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS google_calendar_channel_token TEXT;

-- Create index for fast channel lookups
CREATE INDEX IF NOT EXISTS idx_doctors_google_calendar_channel_id 
  ON doctors(google_calendar_channel_id) 
  WHERE google_calendar_channel_id IS NOT NULL;

-- Add comments for documentation
COMMENT ON COLUMN doctors.google_calendar_channel_id IS 'Google Calendar push notification channel ID';
COMMENT ON COLUMN doctors.google_calendar_resource_id IS 'Google Calendar resource ID for the watch';
COMMENT ON COLUMN doctors.google_calendar_channel_expiration IS 'When the push notification channel expires (max 7 days)';
COMMENT ON COLUMN doctors.google_calendar_channel_token IS 'Token for verifying webhook notifications';

