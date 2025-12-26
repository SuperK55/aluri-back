# Google Forms Integration Guide

## Quick Setup (Method 1: Google Apps Script - Recommended)

### Step 1: Get Your API Token
1. Log into Geniumed dashboard
2. Go to **Settings** → **API Tokens**
3. Create a new token or copy an existing one
4. Save it securely

### Step 2: Create Your Google Form

**For Medical Clinic:**
- Name (Short answer) - Required
- Email (Short answer) - Required
- WhatsApp Number (Short answer) - Required
- Specialty (Dropdown or Short answer) - Required
- Reason (Paragraph) - Required
- City (Short answer) - Optional

**For Beauty Clinic:**
- Name (Short answer) - Required
- Email (Short answer) - Required
- WhatsApp Number (Short answer) - Required
- Treatment Name (Short answer) - Required
- City (Short answer) - Optional

### Step 3: Add Apps Script

1. In your Google Form, click **⋮ (three dots)** → **Script editor**
2. Copy the code from `google-forms-apps-script.js`
3. Replace `YOUR_API_TOKEN_HERE` with your actual token
4. Replace `YOUR_WEBHOOK_URL` with: `https://app.aluri.ai/api/lead/submit/webhook`
5. **Save** the script (Ctrl+S or Cmd+S)

### Step 4: Set Up Trigger

1. In the Script Editor, click **Triggers** (clock icon) on the left
2. Click **+ Add Trigger** (bottom right)
3. Configure:
   - **Function to run:** `onFormSubmit`
   - **Event source:** `From form`
   - **Event type:** `On form submit`
4. Click **Save**
5. **Authorize** the script when prompted (allow it to send HTTP requests)

### Step 5: Test

1. Submit a test form response
2. Check the **Execution log** in Script Editor to see if it worked
3. Check your Geniumed dashboard to see if the lead was created

---

## Alternative: Method 2 (Hidden Field - Less Secure)

If you don't want to use Apps Script:

1. Add a **Short answer** question named "API Token"
2. Set it as **Required**
3. Set **Default value** to your API token
4. Use a third-party service (Zapier, Make.com) to forward submissions to:
   ```
   https://app.aluri.ai/api/lead/submit/webhook?api_token=YOUR_TOKEN_HERE
   ```

---

## Field Mapping

The script maps Google Form fields to API fields. Adjust the mapping in the script if your form uses different field names:

| Google Form Question Contains | Maps To API Field |
|-------------------------------|-------------------|
| "name" or "nome" | `name` |
| "email" or "e-mail" | `email` |
| "whatsapp" or "phone" or "telefone" | `whatsapp_number`, `phone` |
| "city" or "cidade" | `city` |
| "specialty" or "especialidade" | `specialty` |
| "reason" or "motivo" or "razão" | `reason` |
| "treatment" or "tratamento" | `treatment_name` |

---

## Troubleshooting

### Script doesn't run
- Check that the trigger is set up correctly
- Make sure you authorized the script
- Check Execution log for errors

### Lead not created
- Check the Execution log in Script Editor
- Verify your API token is correct
- Verify the webhook URL is correct
- Check that all required fields are filled

### Token error
- Make sure the API token is active in Geniumed dashboard
- Verify the token hasn't been revoked
- Check that you copied the full token (it's long!)

---

## Security Notes

⚠️ **Method 1 (Apps Script)** is more secure because:
- Token is stored in the script (not visible to form users)
- Token is sent server-side (not exposed in browser)

⚠️ **Method 2 (Hidden Field)** is less secure because:
- Token is visible in form HTML source
- Token could be extracted by users

**Recommendation:** Use Method 1 (Apps Script) for production use.



