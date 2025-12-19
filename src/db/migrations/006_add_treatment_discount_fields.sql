-- Migration: Add discount fields to treatments table
-- This migration adds fields for promotional discount configuration

-- Add new columns to treatments table
ALTER TABLE treatments 
ADD COLUMN IF NOT EXISTS apply_discount_for_pix BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS discount_percentage INTEGER CHECK (discount_percentage >= 1 AND discount_percentage <= 100);

-- Update existing records to have default values
UPDATE treatments 
SET apply_discount_for_pix = false 
WHERE apply_discount_for_pix IS NULL;

-- Add comment to columns for documentation
COMMENT ON COLUMN treatments.apply_discount_for_pix IS 'Whether to apply discount for PIX payments';
COMMENT ON COLUMN treatments.discount_percentage IS 'Discount percentage (1-100) when promotional discount is enabled';

