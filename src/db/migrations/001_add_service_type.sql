-- Migration: Add service_type to users table
-- This enables multi-service platform support (clinic, beauty_clinic, real_estate, insurance, consortia)

-- Add service_type column with constraint
ALTER TABLE users ADD COLUMN IF NOT EXISTS service_type TEXT DEFAULT 'clinic' 
  CHECK (service_type IN ('clinic', 'beauty_clinic', 'real_estate', 'insurance', 'consortia'));

-- Update existing users to 'clinic' (for backward compatibility)
UPDATE users SET service_type = 'clinic' WHERE service_type IS NULL;

-- Add service-specific configuration JSONB field
ALTER TABLE users ADD COLUMN IF NOT EXISTS service_config JSONB DEFAULT '{}'::jsonb;

-- Update comment on specialty field to reflect service-agnostic usage
COMMENT ON COLUMN users.specialty IS 'Service category (medical specialty for clinic, treatment category for beauty, property type for real estate, etc.)';

-- Create index for faster service_type queries
CREATE INDEX IF NOT EXISTS idx_users_service_type ON users(service_type);

