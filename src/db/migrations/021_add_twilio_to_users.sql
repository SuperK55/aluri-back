-- Add Twilio sub-account and phone number fields to users table
-- Each business owner (user) will have their own Twilio sub-account and phone number
-- This phone number will be used for all agents owned by this user

ALTER TABLE users 
ADD COLUMN IF NOT EXISTS twilio_subaccount_sid TEXT,
ADD COLUMN IF NOT EXISTS twilio_subaccount_auth_token TEXT,
ADD COLUMN IF NOT EXISTS twilio_phone_sid TEXT,
ADD COLUMN IF NOT EXISTS twilio_phone_number TEXT;

-- Add index for phone number lookups
CREATE INDEX IF NOT EXISTS idx_users_twilio_phone_number ON users(twilio_phone_number);
CREATE INDEX IF NOT EXISTS idx_users_twilio_subaccount_sid ON users(twilio_subaccount_sid);

-- Add unique constraint on twilio_phone_number (each phone number should be unique)
ALTER TABLE users ADD CONSTRAINT unique_user_twilio_phone_number UNIQUE (twilio_phone_number);

COMMENT ON COLUMN users.twilio_subaccount_sid IS 'Twilio sub-account SID for this business owner';
COMMENT ON COLUMN users.twilio_subaccount_auth_token IS 'Twilio sub-account auth token';
COMMENT ON COLUMN users.twilio_phone_sid IS 'Twilio phone number resource SID';
COMMENT ON COLUMN users.twilio_phone_number IS 'Dedicated phone number for outbound calls (E.164 format)';




