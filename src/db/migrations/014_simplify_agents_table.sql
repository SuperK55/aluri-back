-- Migration: Simplify agents table to match new 3-field form
-- Remove unnecessary fields and add voice_tone and script_style

-- Add new fields
ALTER TABLE agents 
ADD COLUMN voice_tone TEXT DEFAULT 'caloroso' CHECK (voice_tone IN ('profissional', 'amigavel', 'caloroso', 'energetico')),
ADD COLUMN script_style TEXT DEFAULT 'persuasivo' CHECK (script_style IN ('persuasivo', 'rapport', 'copy'));

-- Remove unnecessary fields that are no longer used in the simplified form
ALTER TABLE agents 
DROP COLUMN IF EXISTS agent_role,
DROP COLUMN IF EXISTS service_description,
DROP COLUMN IF EXISTS assistant_name;

-- Update existing records with default values if they don't have them
UPDATE agents 
SET voice_tone = 'caloroso' 
WHERE voice_tone IS NULL;

UPDATE agents 
SET script_style = 'persuasivo' 
WHERE script_style IS NULL;

-- Add comments for the new fields
COMMENT ON COLUMN agents.voice_tone IS 'Voice tone for the agent: profissional, amigavel, caloroso, energetico';
COMMENT ON COLUMN agents.script_style IS 'Script style for the agent: persuasivo, rapport, copy';
