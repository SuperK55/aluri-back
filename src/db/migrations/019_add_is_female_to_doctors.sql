-- Add is_female field to doctors table
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS is_female BOOLEAN DEFAULT false;

