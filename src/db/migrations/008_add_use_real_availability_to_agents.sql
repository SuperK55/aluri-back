-- Migration: Add use_real_availability field to agents table
-- This allows agents to choose between scarcity method (1 month booking) or real calendar availability

-- Add use_real_availability column to agents table
ALTER TABLE agents 
ADD COLUMN IF NOT EXISTS use_real_availability BOOLEAN DEFAULT false;

-- Update existing agents to use scarcity method (false) by default
UPDATE agents 
SET use_real_availability = false 
WHERE use_real_availability IS NULL;

-- Create index for faster filtering
CREATE INDEX IF NOT EXISTS idx_agents_use_real_availability ON agents(use_real_availability);

-- Add comment to column for documentation
COMMENT ON COLUMN agents.use_real_availability IS 'If true, agent shows real available timeslots from calendar. If false, uses scarcity method (1 month booking)';

