# WhatsApp Templates Scripts

Quick reference for WhatsApp template management scripts.

## 📋 Available Scripts

### 1. Create Templates (Bash)
```bash
./create-templates.sh <USER_ID>
```
Creates all three WhatsApp templates defined in `template.md`.

**Example:**
```bash
./create-templates.sh 123e4567-e89b-12d3-a456-426614174000
```

**Or use Node.js directly:**
```bash
node src/scripts/createWhatsAppTemplates.js d9c6312b-bacc-4db0-b448-45ba3defad59
```

---

### 2. Check Template Status (Bash)
```bash
./check-template-status.sh <USER_ID> [TEMPLATE_NAME]
```
Check the approval status of your templates.

**Examples:**
```bash
# Check all templates
./check-template-status.sh 123e4567-e89b-12d3-a456-426614174000

# Check specific template
./check-template-status.sh 123e4567-e89b-12d3-a456-426614174000 appointment_confirmation_doctor
```

**Or use Node.js directly:**
```bash
node src/scripts/checkTemplateStatus.js d9c6312b-bacc-4db0-b448-45ba3defad59
```

---

### 3. Test Template (Bash)
```bash
./test-template.sh <USER_ID> <PHONE_NUMBER> <TEMPLATE_NAME>
```
Send a test message using a specific template.

**Examples:**
```bash
./test-template.sh 123e4567-e89b-12d3-a456-426614174000 +5511999999999 initial_contact_greeting
./test-template.sh 123e4567-e89b-12d3-a456-426614174000 +5511999999999 appointment_confirmation_doctor
./test-template.sh 123e4567-e89b-12d3-a456-426614174000 +5511999999999 earlier_slot_offer
```

**Or use Node.js directly:**
```bash
node src/scripts/testWhatsAppTemplates.js 123e4567-e89b-12d3-a456-426614174000 +5511999999999 initial_contact_greeting
```

---

## 🚀 Quick Workflow

### Initial Setup (One Time)
```bash
# 1. Create templates
./create-templates.sh YOUR_USER_ID

# 2. Wait 24-48 hours for Meta approval
```

### Check Status (After 24-48 hours)
```bash
# Check all templates
./check-template-status.sh YOUR_USER_ID

# Or check specific template
./check-template-status.sh YOUR_USER_ID appointment_confirmation_doctor
```

### Test Templates (After Approval)
```bash
# Test each template
./test-template.sh YOUR_USER_ID +5511999999999 initial_contact_greeting
./test-template.sh YOUR_USER_ID +5511999999999 appointment_confirmation_doctor
./test-template.sh YOUR_USER_ID +5511999999999 earlier_slot_offer
```

---

## 📝 Templates Included

| Template Name | Variables | Purpose |
|---------------|-----------|---------|
| `initial_contact_greeting` | 3 | First contact with patient |
| `appointment_confirmation_doctor` | 5 | Confirm appointment details |
| `earlier_slot_offer` | 6 | Offer earlier appointment slots |

---

## 🔧 Script Locations

```
geniumed.ai_backend/
├── create-templates.sh              (Bash wrapper)
├── check-template-status.sh         (Bash wrapper)
├── test-template.sh                 (Bash wrapper)
├── src/
│   └── scripts/
│       ├── createWhatsAppTemplates.js    (Node.js script)
│       ├── checkTemplateStatus.js        (Node.js script)
│       └── testWhatsAppTemplates.js      (Node.js script)
└── WHATSAPP_SCRIPTS_README.md       (This file)
```

---

## ⚠️ Prerequisites

Before running scripts:

1. ✅ WhatsApp Business connected in Geniumed
2. ✅ Valid User ID (UUID format)
3. ✅ WhatsApp Business Account ID configured
4. ✅ Valid access token
5. ✅ Node.js installed

---

## 🐛 Troubleshooting

### Permission Denied
```bash
# Make scripts executable
chmod +x create-templates.sh check-template-status.sh test-template.sh
```

### WhatsApp Business Not Connected
```bash
# Error: "WhatsApp Business not connected"
# Solution: Connect via Geniumed dashboard
```

### Invalid User ID
```bash
# Error: "Invalid User ID format"
# Solution: Use valid UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### Template Not Found
```bash
# Error: Template not found
# Solution: Create templates first using create-templates.sh
```

---

## 📚 Full Documentation

- **Comprehensive Guide:** `../WHATSAPP_TEMPLATES_GUIDE.md`
- **Quick Start:** `../QUICK_START_TEMPLATES.md`
- **Implementation Summary:** `../TEMPLATES_IMPLEMENTATION_SUMMARY.md`

---

## 🔗 Useful Links

- [Meta Business Manager](https://business.facebook.com)
- [WhatsApp API Docs](https://developers.facebook.com/docs/whatsapp/business-messaging)
- [WhatsApp Business Policy](https://www.whatsapp.com/legal/business-policy)

---

## 💡 Tips

1. **Use Bash Scripts:** Easier to remember and type
2. **Check Status Regularly:** Monitor template approval progress
3. **Test Before Production:** Always test templates after approval
4. **Keep Phone Numbers Valid:** Use E.164 format (+5511999999999)
5. **Save Your User ID:** You'll need it frequently

---

**Need help?** Check the full documentation or run scripts without arguments to see usage examples.


