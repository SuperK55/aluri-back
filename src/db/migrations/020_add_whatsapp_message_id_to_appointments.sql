-- Add WhatsApp confirmation message ID to appointments table
-- This allows us to track which WhatsApp message was sent for appointment confirmation
-- and link button clicks back to the correct appointment

ALTER TABLE appointments 
ADD COLUMN IF NOT EXISTS whatsapp_confirmation_message_id TEXT;

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_appointments_whatsapp_message_id 
ON appointments(whatsapp_confirmation_message_id) 
WHERE whatsapp_confirmation_message_id IS NOT NULL;

