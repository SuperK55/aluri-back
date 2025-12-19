-- Migration: Remove confirmation_channel column from doctors table
-- This migration removes the confirmation_channel field as it's no longer needed

-- Remove the confirmation_channel column from doctors table
ALTER TABLE doctors DROP COLUMN IF EXISTS confirmation_channel;

-- Drop the index if it exists
DROP INDEX IF EXISTS idx_doctors_confirmation_channel;
