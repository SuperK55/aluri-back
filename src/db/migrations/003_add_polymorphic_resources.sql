-- Migration: Add polymorphic resource support for multi-service platform
-- This allows leads, appointments, and call_attempts to reference different resource types
-- (doctors, treatments, properties, insurance_plans, consortia_plans)

-- Update leads table
ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_resource_type TEXT 
  CHECK (assigned_resource_type IN ('doctor', 'treatment', 'property', 'insurance_plan', 'consortia_plan'));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_resource_id UUID;

-- Create index for polymorphic resource lookups
CREATE INDEX IF NOT EXISTS idx_leads_resource ON leads(assigned_resource_type, assigned_resource_id);

-- Update appointments table
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS resource_type TEXT DEFAULT 'doctor'
  CHECK (resource_type IN ('doctor', 'treatment', 'property', 'insurance_plan', 'consortia_plan'));
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS resource_id UUID;

-- Create index for polymorphic resource lookups
CREATE INDEX IF NOT EXISTS idx_appointments_resource ON appointments(resource_type, resource_id);

-- Update call_attempts table
ALTER TABLE call_attempts ADD COLUMN IF NOT EXISTS resource_type TEXT
  CHECK (resource_type IN ('doctor', 'treatment', 'property', 'insurance_plan', 'consortia_plan'));
ALTER TABLE call_attempts ADD COLUMN IF NOT EXISTS resource_id UUID;

-- Create index for polymorphic resource lookups
CREATE INDEX IF NOT EXISTS idx_call_attempts_resource ON call_attempts(resource_type, resource_id);

-- Add comments for clarity
COMMENT ON COLUMN leads.assigned_resource_type IS 'Type of resource assigned (doctor, treatment, property, etc.)';
COMMENT ON COLUMN leads.assigned_resource_id IS 'UUID of the assigned resource in its respective table';
COMMENT ON COLUMN appointments.resource_type IS 'Type of resource for this appointment (doctor, treatment, property, etc.)';
COMMENT ON COLUMN appointments.resource_id IS 'UUID of the resource in its respective table';
COMMENT ON COLUMN call_attempts.resource_type IS 'Type of resource discussed in this call (doctor, treatment, property, etc.)';
COMMENT ON COLUMN call_attempts.resource_id IS 'UUID of the resource in its respective table';

