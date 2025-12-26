# RD Station Integration Guide

## Overview

RD Station can send lead data to Geniumed via webhook when a new lead is created or when specific events occur (form submission, landing page conversion, etc.).

## Step 1: Get Your API Token

1. Log into your **Geniumed dashboard**
2. Go to **Settings** → **API Tokens**
3. Create a new token or copy an existing one
4. Save it securely (you'll need it in Step 3)

## Step 2: Configure RD Station Webhook

RD Station supports webhooks through **Automation** workflows. You can trigger the webhook when:
- A new lead is created
- A form is submitted
- A landing page conversion occurs
- A specific score is reached
- Any custom event

### Option A: Using RD Station Automation (Recommended)

1. **Log into RD Station**
2. Go to **Automações** (Automations) → **Criar automação** (Create automation)
3. **Set the trigger:**
   - Choose: **"Novo lead criado"** (New lead created) or
   - Choose: **"Formulário preenchido"** (Form submitted) or
   - Choose: **"Página de destino convertida"** (Landing page converted)
4. **Add action:** Search for **"Webhook"** or **"Chamada HTTP"**
5. **Configure the webhook:**

   **Method:** `POST`
   
   **URL:** 
   ```
   https://app.aluri.ai/api/lead/submit/webhook?api_token=YOUR_API_TOKEN_HERE
   ```
   (Replace `YOUR_API_TOKEN_HERE` with your actual token)

   **Headers:**
   ```
   Content-Type: application/json
   ```

   **Body (JSON):**
   ```json
   {
     "name": "{{lead.name}}",
     "email": "{{lead.email}}",
     "whatsapp_number": "{{lead.mobile_phone}}",
     "phone": "{{lead.mobile_phone}}",
     "city": "{{lead.city}}",
     "specialty": "{{lead.specialty}}",
     "reason": "{{lead.reason}}",
     "treatment_name": "{{lead.treatment_name}}",
     "source": "rd_station",
     "campaign": "{{lead.origin}}",
     "utm_source": "{{lead.utm_source}}",
     "utm_medium": "{{lead.utm_medium}}",
     "utm_campaign": "{{lead.utm_campaign}}",
     "notes": "Lead from RD Station - ID: {{lead.id}}"
   }
   ```

6. **Test the automation** with a test lead
7. **Activate** the automation

### Option B: Using RD Station API + Zapier/Make.com

If RD Station doesn't have a direct webhook action, you can use:

1. **RD Station** → **Zapier/Make.com** → **Geniumed Webhook**

   **Zapier/Make.com Configuration:**
   - **Trigger:** RD Station - New Lead
   - **Action:** Webhook by Zapier/Make.com
   - **Method:** POST
   - **URL:** `https://app.aluri.ai/api/lead/submit/webhook?api_token=YOUR_TOKEN`
   - **Body:** Map RD Station fields to Geniumed fields (see field mapping below)

## Step 3: Field Mapping

Map RD Station lead fields to Geniumed API fields:

| RD Station Field | Geniumed API Field | Required | Notes |
|-----------------|-------------------|----------|-------|
| `lead.name` or `lead.first_name` + `lead.last_name` | `name` | ✅ Yes | Full name or first + last |
| `lead.email` | `email` | ✅ Yes | |
| `lead.mobile_phone` or `lead.phone` | `whatsapp_number`, `phone` | ✅ Yes | Use mobile_phone if available |
| `lead.city` | `city` | ❌ Optional | |
| `lead.specialty` or custom field | `specialty` | ✅ Medical Clinic | Required for medical clinics |
| `lead.reason` or custom field | `reason` | ✅ Medical Clinic | Required for medical clinics |
| `lead.treatment_name` or custom field | `treatment_name` | ✅ Beauty Clinic | Required for beauty clinics |
| `lead.origin` | `campaign` | ❌ Optional | |
| `lead.utm_source` | `utm_source` | ❌ Optional | |
| `lead.utm_medium` | `utm_medium` | ❌ Optional | |
| `lead.utm_campaign` | `utm_campaign` | ❌ Optional | |

### RD Station Custom Fields

If you need to capture **specialty**, **reason**, or **treatment_name**, create custom fields in RD Station:

1. Go to **Configurações** (Settings) → **Campos personalizados** (Custom fields)
2. Create fields:
   - **Especialidade** (Specialty) - for medical clinic
   - **Motivo da consulta** (Reason) - for medical clinic
   - **Tratamento** (Treatment) - for beauty clinic
3. Add these fields to your forms/landing pages
4. Map them in the webhook body using `{{lead.custom_field_name}}`

## Step 4: Alternative - Using Query Parameter for Token

If RD Station doesn't support custom headers, you can include the token in the URL:

**URL Format:**
```
https://app.aluri.ai/api/lead/submit/webhook?api_token=YOUR_API_TOKEN_HERE
```

**Body (without token):**
```json
{
  "name": "{{lead.name}}",
  "email": "{{lead.email}}",
  "whatsapp_number": "{{lead.mobile_phone}}",
  "specialty": "{{lead.specialty}}",
  "reason": "{{lead.reason}}",
  "source": "rd_station"
}
```

## Step 5: Testing

1. **Create a test lead** in RD Station (manually or via form)
2. **Check the automation execution log** in RD Station
3. **Check Geniumed dashboard** to see if the lead was created
4. **Check the webhook logs** in Geniumed (if available)

## Troubleshooting

### Webhook not triggering
- Verify the automation is **active** in RD Station
- Check the trigger conditions match your test scenario
- Review RD Station automation execution logs

### Authentication error (401)
- Verify the API token is correct
- Check if the token is active in Geniumed dashboard
- Ensure the token is included in the URL query parameter or request body

### Lead not created
- Check the webhook response in RD Station logs
- Verify all required fields are mapped correctly
- Check Geniumed logs for error messages
- Ensure phone number format is correct (should include country code, e.g., +5511999999999)

### Field mapping issues
- Verify RD Station field names match exactly (case-sensitive)
- Use `{{lead.field_name}}` syntax for dynamic values
- Test with static values first, then switch to dynamic

## Security Best Practices

⚠️ **Important:**
- Keep your API token **secret** - don't share it publicly
- Use **query parameter** method if RD Station doesn't support headers (less secure but works)
- Consider creating a **separate API token** for RD Station integration
- **Rotate tokens** periodically for security
- **Monitor** webhook calls in Geniumed dashboard

## Example: Complete Webhook Configuration

**URL:**
```
https://app.aluri.ai/api/lead/submit/webhook?api_token=abc123xyz789...
```

**Headers:**
```
Content-Type: application/json
```

**Body (Medical Clinic Example):**
```json
{
  "name": "{{lead.name}}",
  "email": "{{lead.email}}",
  "whatsapp_number": "{{lead.mobile_phone}}",
  "phone": "{{lead.mobile_phone}}",
  "city": "{{lead.city}}",
  "specialty": "{{lead.especialidade}}",
  "reason": "{{lead.motivo_consulta}}",
  "source": "rd_station",
  "campaign": "{{lead.origin}}",
  "utm_source": "{{lead.utm_source}}",
  "utm_medium": "{{lead.utm_medium}}",
  "utm_campaign": "{{lead.utm_campaign}}"
}
```

**Body (Beauty Clinic Example):**
```json
{
  "name": "{{lead.name}}",
  "email": "{{lead.email}}",
  "whatsapp_number": "{{lead.mobile_phone}}",
  "phone": "{{lead.mobile_phone}}",
  "city": "{{lead.city}}",
  "treatment_name": "{{lead.tratamento}}",
  "source": "rd_station",
  "campaign": "{{lead.origin}}"
}
```

## Need Help?

If you encounter issues:
1. Check RD Station automation execution logs
2. Check Geniumed webhook endpoint logs
3. Verify API token is active
4. Test with a simple static payload first


