-- Add support for treatments in leads table
-- This allows leads to be assigned to either doctors (clinic) or treatments (beauty_clinic)

-- Add new column for treatment assignments
ALTER TABLE leads
ADD COLUMN IF NOT EXISTS assigned_treatment_id UUID REFERENCES treatments(id) ON DELETE SET NULL;

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_leads_assigned_treatment_id ON leads(assigned_treatment_id);

-- Make assigned_doctor_id nullable (it should already be, but ensuring it)
-- This allows leads to have either a doctor OR a treatment assigned, not both

-- Add a comment explaining the relationship
COMMENT ON COLUMN leads.assigned_doctor_id IS 'For medical clinic leads - references doctors table';
COMMENT ON COLUMN leads.assigned_treatment_id IS 'For beauty clinic leads - references treatments table';

-- Note: We keep both columns for flexibility
-- Medical clinics use assigned_doctor_id
-- Beauty clinics use assigned_treatment_id

