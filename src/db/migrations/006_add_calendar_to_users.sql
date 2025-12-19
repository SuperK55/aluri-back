-- Migration: Add Google Calendar integration to users table
-- This allows beauty clinic owners to connect their Google Calendar

-- Add Google Calendar fields to users table
ALTER TABLE users
ADD COLUMN IF NOT EXISTS google_calendar_id TEXT,
ADD COLUMN IF NOT EXISTS google_refresh_token TEXT,
ADD COLUMN IF NOT EXISTS google_access_token TEXT,
ADD COLUMN IF NOT EXISTS google_token_expires_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS calendar_sync_enabled BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS last_calendar_sync TIMESTAMPTZ;

-- Add index for calendar sync queries
CREATE INDEX IF NOT EXISTS idx_users_calendar_sync ON users(calendar_sync_enabled) WHERE calendar_sync_enabled = true;

-- Verify the structure
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'users' AND column_name LIKE '%calendar%'
-- ORDER BY ordinal_position;

