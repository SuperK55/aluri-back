-- WhatsApp Chat Sessions Table
-- Tracks active WhatsApp conversations linked to Retell chat agents
CREATE TABLE whatsapp_chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Owner and Lead relationships
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  
  -- WhatsApp identification
  wa_phone TEXT NOT NULL, -- User's WhatsApp number (E.164 format: +5511999999999)
  
  -- Retell Chat Agent integration
  retell_chat_id TEXT UNIQUE, -- Retell chat_id returned from create-chat API
  agent_id TEXT NOT NULL, -- Retell chat agent ID to use for this conversation
  
  -- Chat status and lifecycle
  status TEXT NOT NULL DEFAULT 'pending_response' CHECK (status IN ('pending_response', 'open', 'closed', 'pending_handoff', 'error')),
  
  -- Metadata and tracking
  metadata JSONB DEFAULT '{}'::jsonb, -- Store additional context (chat_type, appointment_id, etc.)
  last_message_at TIMESTAMPTZ, -- Last activity timestamp
  last_agent_message_id TEXT, -- Last message ID from Retell for tracking
  
  -- Retell chat analysis (populated after chat ends)
  retell_chat_analysis JSONB, -- Store chat_analysis from Retell webhook
  retell_chat_cost JSONB, -- Store chat_cost from Retell webhook
  retell_collected_variables JSONB, -- Store collected_dynamic_variables from Retell
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- WhatsApp Messages Table
-- Stores all messages exchanged in WhatsApp conversations
CREATE TABLE whatsapp_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id UUID NOT NULL REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
  
  -- Message direction and source
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender TEXT NOT NULL CHECK (sender IN ('user', 'agent', 'system')),
  
  -- WhatsApp message identification
  wa_message_id TEXT, -- WhatsApp message ID from webhook (for deduplication)
  
  -- Retell message identification (for agent messages)
  retell_message_id TEXT, -- Retell message_id if this came from Retell chat completion
  
  -- Message content
  body TEXT NOT NULL, -- Message text content
  payload JSONB, -- Additional data (buttons, media metadata, location, etc.)
  
  -- Message metadata
  message_type TEXT DEFAULT 'text' CHECK (message_type IN ('text', 'button', 'template', 'media', 'location')),
  is_template BOOLEAN DEFAULT false, -- True if sent via WhatsApp template
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT now(),
  
  -- Indexes for performance
  CONSTRAINT unique_wa_message_id UNIQUE (wa_message_id) -- Prevent duplicate message processing
);

-- Indexes for performance
CREATE INDEX idx_whatsapp_chats_wa_phone ON whatsapp_chats(wa_phone);
CREATE INDEX idx_whatsapp_chats_owner_id ON whatsapp_chats(owner_id);
CREATE INDEX idx_whatsapp_chats_lead_id ON whatsapp_chats(lead_id);
CREATE INDEX idx_whatsapp_chats_retell_chat_id ON whatsapp_chats(retell_chat_id);
CREATE INDEX idx_whatsapp_chats_status ON whatsapp_chats(status);
CREATE INDEX idx_whatsapp_chats_last_message_at ON whatsapp_chats(last_message_at DESC);
-- Enforce single active/pending chat per phone via partial unique index
CREATE UNIQUE INDEX idx_unique_active_chat_per_phone
  ON whatsapp_chats(wa_phone)
  WHERE status IN ('open', 'pending_response');

CREATE INDEX idx_whatsapp_messages_chat_id ON whatsapp_messages(chat_id);
CREATE INDEX idx_whatsapp_messages_created_at ON whatsapp_messages(created_at DESC);
CREATE INDEX idx_whatsapp_messages_direction ON whatsapp_messages(direction);
CREATE INDEX idx_whatsapp_messages_retell_message_id ON whatsapp_messages(retell_message_id);

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_whatsapp_chat_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update updated_at on whatsapp_chats
CREATE TRIGGER trigger_update_whatsapp_chat_updated_at
  BEFORE UPDATE ON whatsapp_chats
  FOR EACH ROW
  EXECUTE FUNCTION update_whatsapp_chat_updated_at();

-- Function to update last_message_at when a message is inserted
CREATE OR REPLACE FUNCTION update_chat_last_message_at()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE whatsapp_chats
  SET last_message_at = NEW.created_at
  WHERE id = NEW.chat_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update last_message_at on message insert
CREATE TRIGGER trigger_update_chat_last_message_at
  AFTER INSERT ON whatsapp_messages
  FOR EACH ROW
  EXECUTE FUNCTION update_chat_last_message_at();

-- Comments for documentation
COMMENT ON TABLE whatsapp_chats IS 'Tracks WhatsApp chat sessions integrated with Retell chat agents';
COMMENT ON TABLE whatsapp_messages IS 'Stores all messages exchanged in WhatsApp conversations';
COMMENT ON COLUMN whatsapp_chats.retell_chat_id IS 'Retell chat_id from create-chat API response';
COMMENT ON COLUMN whatsapp_chats.agent_id IS 'Retell chat agent ID to use for this conversation';
COMMENT ON COLUMN whatsapp_chats.metadata IS 'Additional context: chat_type (welcome/confirm/other), appointment_id, etc.';
COMMENT ON COLUMN whatsapp_messages.wa_message_id IS 'WhatsApp message ID for deduplication';
COMMENT ON COLUMN whatsapp_messages.retell_message_id IS 'Retell message_id from chat completion response';

