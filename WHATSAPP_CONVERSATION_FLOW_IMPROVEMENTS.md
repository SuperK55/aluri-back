# WhatsApp Conversation Flow Improvements

## Overview
Converted voice call conversation flow to WhatsApp chat agent with improved structure for handling appointments, callbacks, and real-time availability.

---

## Key Changes Made

### 1. **Removed Voice-Specific Elements**
- ❌ Removed all SSML tags (`<break time='500ms'/>`, `<emphasis>`, etc.)
- ❌ Removed voice pacing instructions ("speak slowly", "with enthusiasm")
- ❌ Removed speaking/listening terminology
- ✅ Adapted tone for text-based messaging

### 2. **WhatsApp-Optimized Messaging Style**
- **Short, scannable messages**: Break long text into digestible chunks
- **Formatting**: Use bold (*text*), line breaks, and bullet points
- **Emojis**: Strategic use for warmth (✅ 📅 ⏰ 👨‍⚕️ 😊)
- **Visual hierarchy**: Clear sections with headers and lists
- **Conversational but professional**: Text-friendly language

### 3. **Three Main Flow Types**

#### A. **Welcome Flow** (`chat_type: "welcome"`)
Initial contact with users who expressed interest in scheduling:
1. Warm greeting with emoji
2. Contextualize the conversation
3. Understand their needs
4. Confirm user information
5. Route to doctor presentation

#### B. **Appointment Confirmation Flow** (`chat_type: "appointment_confirm"`)
For users with existing appointments needing confirmation:
1. Greet and identify the appointment
2. Present appointment details (date, time, doctor, location)
3. Handle confirmation/reschedule/cancellation
4. Send reminder information
5. Offer help with questions

#### C. **Real Available Time Flow** (`chat_type: "real_available_time"`)
For users who requested earlier dates - follow-up with actual availability:
1. Remind user of their earlier request
2. Present real available slots found
3. Handle slot selection or alternative requests
4. Route to confirmation or further availability checks

### 4. **Improved Message Formatting**

**Before (Voice):**
```
"Oi, {{name}}! Aqui é a {{agent_name}}, sou assistente da Clínica MEDD. Como você está hoje? <break time='300ms'/>"
```

**After (WhatsApp):**
```
"Oi {{name}}! 👋

Aqui é a {{agent_name}} da Clínica MEDD. Tudo bem?"
```

### 5. **Enhanced Date/Time Handling**

#### Time vs Date Distinction:
- **Earlier TIME (same day)**: "horário mais cedo" → Check availability for same date
- **Earlier DATE (different day)**: "data mais cedo" → Offer callback or check different date
- **Specific date request**: "tem no dia 25?" → Check that specific date
- **General date request**: "tem outra data?" → Show multiple options

### 6. **Callback System**
When users request earlier dates not immediately available:
1. Acknowledge the request empathetically
2. Offer to check and follow up
3. **Set clear expectation**: "entre hoje e amanhã"
4. Answer any questions user has
5. Confirm callback agreement

### 7. **Doctor Presentation**

**Copy Script Style** (Single suggested date):
- Present doctor with credentials and bio
- Explain consultation details (duration, investment)
- Present single suggested date
- Handle agreement, date changes, or concerns

**Regular Style** (Multiple slots):
- Present doctor with credentials
- Explain consultation details
- Show 2-3 available slots
- Let user choose or request alternatives

### 8. **Improved User Response Recognition**

#### Positive Responses (proceed to confirmation):
- "sim", "pode", "quero", "bem", "ok", "claro", "está bom", "perfeito", "aceito"

#### Hesitation (offer alternatives):
- "talvez", "não sei", "vou pensar", "deixa eu pensar"

#### Date/Time Changes:
- Route to appropriate availability check function

### 9. **Question Handling Strategy**
Before closing any conversation:
1. Ask: "Tem mais alguma coisa que eu possa te ajudar?"
2. Answer all questions completely
3. Loop until user indicates they're done
4. Only then proceed to final goodbye

### 10. **Other Services Handling**
When user asks about other services:
- Inform about availability: {{other_services}}
- Can only book ONE appointment per conversation
- Direct to WhatsApp for additional bookings
- Keep focus on current appointment

---

## Flow Structure

```
Entry Point (chat_type routing)
    ├─→ appointment_confirm → Confirmation Flow → End
    ├─→ welcome → Greeting → Discovery → Doctor Presentation
    │                                    ├─→ Agreement → Confirmation → End
    │                                    ├─→ Date Request → Check Availability
    │                                    ├─→ Earlier Date → Callback Offer
    │                                    └─→ Decline → Polite Close → End
    └─→ real_available_time → Present Real Slots
                               ├─→ Agreement → Confirmation → End
                               ├─→ Other Date → Check Availability
                               └─→ Decline → Polite Close → End
```

---

## Key Functions

### 1. **check-availability**
- Called when user requests specific dates or times
- Returns: `{{available}}`, `{{availableSlots}}`, `{{timezone}}`
- Used for dynamic scheduling based on user requests

### 2. **Maybe_recommend_doctor**
- Called when user doesn't like current doctor
- Returns: New doctor info or indication no other doctors available
- Updates all doctor-related variables

### 3. **Check-identity**
- Called when user information doesn't match
- Logs mismatched reason for team review

---

## Best Practices for WhatsApp

1. **Message Length**: 1-3 sentences per message ideal
2. **Response Time**: Quick, immediate feel
3. **Formatting**: Use lists, bold, and emojis strategically
4. **Clarity**: Be direct and clear about next steps
5. **Empathy**: Show understanding in text form
6. **Professional**: Maintain clinic's reputation while being friendly
7. **Complete Information**: Include all necessary details (date, time, location, price)

---

## Variables Used

### User Information:
- `{{name}}`, `{{phone}}`, `{{phone_last4}}`, `{{city}}`
- `{{specialty}}`, `{{reason}}`, `{{need}}`

### Doctor Information:
- `{{doctor_name}}`, `{{doctor_specialty}}`, `{{doctor_bio}}`
- `{{doctor_city}}`, `{{doctor_address}}`, `{{doctor_tags}}`
- `{{doctor_languages}}`, `{{doctor_id}}`

### Appointment Details:
- `{{consultation_duration}}`, `{{consultation_price}}`
- `{{return_consultation_price}}`, `{{return_policy}}`
- `{{payment_methods}}`, `{{cancellation_policy_days}}`

### Availability:
- `{{suggested_date}}`, `{{available_slots}}`, `{{script_availability}}`
- `{{has_multiple_slots}}`, `{{available}}`, `{{availableSlots}}`
- `{{telemedicine}}`, `{{telemedicine_available}}`

### Business:
- `{{business_specialty}}`, `{{social_proof}}`, `{{other_services}}`
- `{{agent_name}}`, `{{agent_id}}`, `{{owner_id}}`

### System:
- `{{chat_type}}`, `{{script_style}}`, `{{current_year}}`
- `{{another_doctor_available}}`, `{{lead_id}}`

---

## Next Steps for Implementation

1. **Test All Three Flow Types**: 
   - Welcome flow (new users)
   - Appointment confirmation (existing appointments)
   - Real available time (callback with actual slots)

2. **Verify Function Integrations**:
   - check-availability endpoint works correctly
   - Maybe_recommend_doctor returns proper doctor data
   - All variables are being set properly

3. **Monitor User Responses**:
   - Track common user questions
   - Identify areas of confusion
   - Optimize based on actual usage

4. **A/B Testing**:
   - Test emoji usage levels
   - Test message length variations
   - Test different presentation styles

5. **Edge Cases to Handle**:
   - User doesn't respond for extended time
   - User switches topics mid-conversation
   - Technical errors from backend functions

---

## Summary of Improvements

✅ **Adapted for WhatsApp**: Removed voice elements, optimized for text
✅ **Three clear flows**: Welcome, Confirmation, Real Available Time
✅ **Better formatting**: Short messages, emojis, bold text, lists
✅ **Improved routing**: Clear chat_type-based routing at entry
✅ **Enhanced availability checking**: Distinguishes time vs date requests
✅ **Callback system**: Clear expectations for follow-up
✅ **Question handling**: Always asks if user needs more help
✅ **Concise but complete**: All necessary info without overwhelming

This conversation flow is now fully optimized for WhatsApp chat interactions while maintaining the ability to handle complex appointment scheduling scenarios.

