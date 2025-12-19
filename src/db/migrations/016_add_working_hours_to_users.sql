-- Migration: Add working hours to users table for beauty clinic service availability
-- For beauty clinics, working hours are at the owner level (not per treatment)

-- Add working hours fields to users table
ALTER TABLE users
ADD COLUMN IF NOT EXISTS working_hours JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS date_specific_availability JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'America/Sao_Paulo';

-- Add comments for clarity
COMMENT ON COLUMN users.working_hours IS 'Owner-level working hours. For beauty clinics, this applies to all treatments. Format: {"monday": {"enabled": true, "timeSlots": [{"id": "1", "start": "09:00", "end": "17:00"}]}, ...}';
COMMENT ON COLUMN users.date_specific_availability IS 'Owner-level specific date availability. For beauty clinics, this applies to all treatments. Format: [{"date": "2024-01-15", "type": "unavailable", "reason": "Holiday"}, ...]';
COMMENT ON COLUMN users.timezone IS 'Timezone for the owner. Used for scheduling and availability calculations.';

-- Example working_hours structure:
-- {
--   "monday": {
--     "enabled": true,
--     "timeSlots": [
--       {"id": "1", "start": "09:00", "end": "17:00"}
--     ]
--   },
--   "tuesday": {"enabled": true, "timeSlots": [{"id": "1", "start": "09:00", "end": "17:00"}]},
--   ...
-- }

-- Example date_specific_availability structure:
-- [
--   {"date": "2024-12-25", "type": "unavailable", "reason": "Christmas"},
--   {"date": "2024-01-01", "type": "unavailable", "reason": "New Year"}
-- ]

