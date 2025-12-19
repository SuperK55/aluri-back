# WhatsApp Confirmation Flow

This document describes the automated WhatsApp confirmation flow after voice calls.

## Overview

After a successful call where the patient agrees to an appointment, the system automatically sends a WhatsApp confirmation template based on the clinic type. If the patient responds to the WhatsApp message, the system continues the conversation using the appropriate clinic agent.

## Flow

### 1. Post-Call Analysis (retell.js webhook)

After a Retell voice call ends, the webhook receives post-call analysis data:

```javascript
{
  should_send_confirmation: true,
  agreement_appointment: true,
  appointment_date: "2024-01-20",
  appointment_time: "14:00",
  preferred_service: "uuid-of-doctor-or-treatment"
}
```

### 2. Clinic Type Detection

The system determines clinic type from `leads.assigned_resource_type`:

- **`doctor`** → Medical clinic → Sends `appointment_confirmation_doctor` template
- **`treatment`** → Beauty clinic → Sends `appointment_confirmation_treatment` template

### 3. WhatsApp Template Sending

The template is sent via `whatsappBusinessService.sendAppointmentConfirmationTemplate()` with:

- **Patient name** from lead
- **Resource name** (doctor name or treatment name)
- **Appointment date and time** from analysis
- **Location** from clinic settings

The lead status is updated to `whatsapp_confirmation_sent` with the message ID stored.

### 4. Response Handling (whatsapp.js webhook)

When a patient responds to the WhatsApp message:

#### Button Responses
- **CONFIRMAR** → Appointment marked as `confirmed`
- **CANCELAR** → Appointment marked as `cancelled`
- **REMARCAR** → System asks for new date/time

#### Text Message Responses
1. Find lead by phone number
2. Determine clinic type (`assigned_resource_type`)
3. Get appropriate agent:
   - Medical clinic (`doctor`) → agent with `service_type='clinic'`
   - Beauty clinic (`treatment`) → agent with `service_type='beauty_clinic'`
4. Continue conversation with agent context

## Database Changes

### Lead Status Updates

- `whatsapp_confirmation_sent` - Template sent successfully
- `whatsapp_conversation` - User responded and conversation started

### Lead Fields Used

- `whatsapp_confirmation_message_id` - WhatsApp message ID
- `whatsapp_confirmation_sent_at` - Timestamp of template send
- `last_contact_channel` - Set to 'whatsapp'

## Templates

### Medical Clinic Template
**Name:** `appointment_confirmation_doctor`

Template should include:
- Patient name
- Doctor name
- Appointment date
- Appointment time
- Clinic location

### Beauty Clinic Template
**Name:** `appointment_confirmation_treatment`

Template should include:
- Patient name
- Treatment name
- Appointment date
- Appointment time
- Clinic location

## Agent Configuration

Each clinic must have agents configured in the `agents` table:

- **Medical clinic:** `service_type = 'clinic'`
- **Beauty clinic:** `service_type = 'beauty_clinic'`

The agent is matched by:
1. `owner_id` (clinic owner)
2. `service_type` (clinic type)

## Future Enhancements

### WhatsApp Conversational AI

Currently, the system sends basic acknowledgment messages when users respond. To implement full conversational AI:

1. **Integrate with AI Service** (e.g., OpenAI, Claude, or custom LLM)
2. **Context Management** - Store conversation history
3. **Agent Prompt** - Use clinic-specific agent configurations
4. **Multi-turn Conversations** - Handle complex scheduling flows
5. **Handoff to Human** - Transfer to staff when needed

### Recommended Architecture

```javascript
// Conversation service
class WhatsAppConversationService {
  async handleMessage(leadId, message, agentConfig) {
    // 1. Load conversation history
    // 2. Build context with agent prompt
    // 3. Call AI service for response
    // 4. Store message and response
    // 5. Send response via WhatsApp
    // 6. Update lead status
  }
}
```

## Testing

### Test Scenarios

1. **Medical clinic confirmation flow**
   - Complete voice call with doctor appointment
   - Verify `appointment_confirmation_doctor` template sent
   - Respond to WhatsApp → Should use medical clinic agent

2. **Beauty clinic confirmation flow**
   - Complete voice call with treatment appointment
   - Verify `appointment_confirmation_treatment` template sent
   - Respond to WhatsApp → Should use beauty clinic agent

3. **Button interactions**
   - Click CONFIRMAR → Appointment confirmed
   - Click CANCELAR → Appointment cancelled
   - Click REMARCAR → Receive rescheduling prompt

4. **Text responses**
   - Send text message → Receive acknowledgment with correct clinic context
   - Verify lead status updated to `whatsapp_conversation`

## Error Handling

The system gracefully handles:

- Missing WhatsApp credentials
- Template sending failures (logs error, continues call flow)
- Missing agent configuration (sends basic acknowledgment)
- Phone number matching issues (logs warning)
- Invalid message formats

All errors are logged for monitoring and debugging.

## Configuration Required

1. **WhatsApp Business API**
   - Connected and verified for each clinic
   - Templates approved by Meta

2. **Templates Created**
   - `appointment_confirmation_doctor` (pt_BR)
   - `appointment_confirmation_treatment` (pt_BR)

3. **Agents Configured**
   - At least one agent per clinic with correct `service_type`

4. **Clinic Settings**
   - `clinic_name` or `clinic_address` for location info

