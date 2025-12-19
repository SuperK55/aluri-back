-- Migration: Remove 'copy' script style from beauty clinic agents
-- Beauty clinics don't use marketing-style scripts, only 'persuasivo' and 'rapport'

-- Update any existing beauty clinic agents with 'copy' style to 'persuasivo'
UPDATE agents
SET script_style = 'persuasivo'
WHERE service_type = 'beauty_clinic' 
  AND script_style = 'copy';

-- Add comment to document the business rule
COMMENT ON COLUMN agents.script_style IS 'Script style for the agent: persuasivo, rapport, copy. Note: Beauty clinic agents (service_type = beauty_clinic) should only use persuasivo or rapport, not copy.';



