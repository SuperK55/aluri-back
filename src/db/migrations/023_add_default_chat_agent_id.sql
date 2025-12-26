-- Add default_chat_agent_id field to users table
-- This field stores the default WhatsApp chat agent ID for each business owner
-- Similar to default_agent_id which stores the default voice agent ID

ALTER TABLE users 
ADD COLUMN IF NOT EXISTS default_chat_agent_id UUID;

-- Add foreign key constraint for default chat agent
ALTER TABLE users ADD CONSTRAINT fk_users_default_chat_agent 
FOREIGN KEY (default_chat_agent_id) REFERENCES agents(id) ON DELETE SET NULL;

-- Add index for performance
CREATE INDEX IF NOT EXISTS idx_users_default_chat_agent ON users(default_chat_agent_id);

COMMENT ON COLUMN users.default_chat_agent_id IS 'Default WhatsApp chat agent for this business owner';

