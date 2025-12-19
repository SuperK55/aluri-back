-- Migration: Add service_type column to agents table
-- This migration adds a service_type field to track which service type each agent was created for

-- Add service_type column to agents table
ALTER TABLE agents 
ADD COLUMN IF NOT EXISTS service_type TEXT DEFAULT 'clinic' CHECK (
  service_type IN ('clinic', 'beauty_clinic', 'real_estate', 'insurance', 'consortia')
);

-- Update existing agents to have the default service_type based on their owner's service_type
UPDATE agents a
SET service_type = COALESCE(u.service_type, 'clinic')
FROM users u
WHERE a.owner_id = u.id
AND a.service_type IS NULL;

-- Create index for faster filtering by service_type
CREATE INDEX IF NOT EXISTS idx_agents_service_type ON agents(service_type);

-- Add comment to column for documentation
COMMENT ON COLUMN agents.service_type IS 'Type of service this agent is configured for (clinic, beauty_clinic, real_estate, insurance, consortia)';

