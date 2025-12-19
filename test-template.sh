#!/bin/bash

# WhatsApp Template Testing Script
# Usage: ./test-template.sh <USER_ID> <PHONE_NUMBER> <TEMPLATE_NAME>

set -e

echo "=================================================="
echo "  WhatsApp Template Testing"
echo "=================================================="
echo ""

# Check if all required arguments are provided
if [ -z "$1" ] || [ -z "$2" ] || [ -z "$3" ]; then
    echo "❌ Error: Missing required arguments"
    echo ""
    echo "Usage: ./test-template.sh <USER_ID> <PHONE_NUMBER> <TEMPLATE_NAME>"
    echo ""
    echo "Examples:"
    echo "  ./test-template.sh 123e4567-e89b-12d3-a456-426614174000 +5511999999999 initial_contact_greeting"
    echo "  ./test-template.sh 123e4567-e89b-12d3-a456-426614174000 +5511999999999 appointment_confirmation_doctor"
    echo "  ./test-template.sh 123e4567-e89b-12d3-a456-426614174000 +5511999999999 earlier_slot_offer"
    echo ""
    echo "Available templates:"
    echo "  - initial_contact_greeting"
    echo "  - appointment_confirmation_doctor"
    echo "  - earlier_slot_offer"
    echo ""
    exit 1
fi

USER_ID=$1
PHONE_NUMBER=$2
TEMPLATE_NAME=$3

# Validate UUID format
if ! [[ $USER_ID =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
    echo "❌ Error: Invalid User ID format"
    echo "   User ID must be a valid UUID"
    exit 1
fi

# Validate phone number format (basic check)
if ! [[ $PHONE_NUMBER =~ ^\+?[1-9][0-9]{1,14}$ ]]; then
    echo "⚠️  Warning: Phone number may not be in valid E.164 format"
    echo "   Expected format: +5511999999999"
    echo "   Continuing anyway..."
    echo ""
fi

echo "User ID: $USER_ID"
echo "Phone Number: $PHONE_NUMBER"
echo "Template: $TEMPLATE_NAME"
echo ""

# Check if we're in the right directory
if [ ! -f "src/scripts/testWhatsAppTemplates.js" ]; then
    echo "⚠️  Warning: Not in backend directory"
    echo "   Changing to backend directory..."
    cd "$(dirname "$0")"
fi

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed"
    exit 1
fi

# Run the template testing script
echo "📤 Sending test template message..."
echo "=================================================="
echo ""

node src/scripts/testWhatsAppTemplates.js "$USER_ID" "$PHONE_NUMBER" "$TEMPLATE_NAME"

echo ""
echo "=================================================="
echo "✅ Template test completed!"
echo "=================================================="
echo ""
echo "📱 Check your WhatsApp at $PHONE_NUMBER"
echo "   You should receive the template message shortly"
echo ""


