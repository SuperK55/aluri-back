-- Migration: Remove script column from agents table
-- This migration removes the script field since we're using predefined conversation flows

-- Remove the script column from agents table
ALTER TABLE agents DROP COLUMN IF EXISTS script;

-- Add comment for documentation
COMMENT ON TABLE agents IS 'Business-level AI agents with predefined conversation flows';
