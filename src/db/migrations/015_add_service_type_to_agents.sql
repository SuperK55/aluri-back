-- Add service_type column to agents table
ALTER TABLE agents 
ADD COLUMN service_type TEXT DEFAULT 'clinic' CHECK (service_type IN ('clinic', 'beauty_clinic', 'real_estate', 'consortia', 'insurance'));

-- Update existing agents with service_type from their owner
UPDATE agents 
SET service_type = users.service_type 
FROM users 
WHERE agents.owner_id = users.id;

-- Make service_type NOT NULL after updating existing records
ALTER TABLE agents 
ALTER COLUMN service_type SET NOT NULL;
