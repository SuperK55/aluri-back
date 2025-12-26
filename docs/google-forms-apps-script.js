/**
 * Google Apps Script for Google Forms → Geniumed Lead Capture
 * 
 * SETUP INSTRUCTIONS:
 * 1. Replace YOUR_API_TOKEN_HERE with your actual API token from Geniumed dashboard
 * 2. Replace YOUR_WEBHOOK_URL with: https://app.aluri.ai/api/lead/submit/webhook
 * 3. Save the script
 * 4. Go to Triggers (clock icon) → Add Trigger
 *    - Choose function: onFormSubmit
 *    - Event source: From form
 *    - Event type: On form submit
 *    - Save
 * 5. Authorize the script when prompted
 */

// ⚠️ REPLACE THIS WITH YOUR API TOKEN FROM GENIUMED DASHBOARD
const API_TOKEN = 'YOUR_API_TOKEN_HERE';

// ⚠️ REPLACE THIS WITH YOUR WEBHOOK URL
const WEBHOOK_URL = 'https://app.aluri.ai/api/lead/submit/webhook';

/**
 * Triggered when form is submitted
 */
function onFormSubmit(e) {
  try {
    const form = FormApp.getActiveForm();
    const formResponses = form.getResponses();
    const latestResponse = formResponses[formResponses.length - 1];
    const itemResponses = latestResponse.getItemResponses();
    
    // Extract form data
    const formData = {};
    itemResponses.forEach(response => {
      const question = response.getItem().getTitle().toLowerCase();
      const answer = response.getResponse();
      
      // Map Google Form questions to API fields
      // Adjust these mappings based on your actual form field names
      if (question.includes('name') || question.includes('nome')) {
        formData.name = answer;
      } else if (question.includes('email') || question.includes('e-mail')) {
        formData.email = answer;
      } else if (question.includes('whatsapp') || question.includes('phone') || question.includes('telefone')) {
        formData.whatsapp_number = answer;
        formData.phone = answer; // Fallback
      } else if (question.includes('city') || question.includes('cidade')) {
        formData.city = answer;
      } else if (question.includes('specialty') || question.includes('especialidade')) {
        formData.specialty = answer;
      } else if (question.includes('reason') || question.includes('motivo') || question.includes('razão')) {
        formData.reason = answer;
      } else if (question.includes('treatment') || question.includes('tratamento')) {
        formData.treatment_name = answer;
      }
    });
    
    // Add API token to the request
    formData.api_token = API_TOKEN;
    formData.source = 'google_forms';
    
    // Send to webhook
    const options = {
      'method': 'post',
      'contentType': 'application/json',
      'payload': JSON.stringify(formData),
      'muteHttpExceptions': true
    };
    
    const response = UrlFetchApp.fetch(WEBHOOK_URL, options);
    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();
    
    if (responseCode === 200 || responseCode === 201) {
      Logger.log('✅ Lead submitted successfully: ' + responseText);
    } else {
      Logger.log('❌ Error submitting lead. Code: ' + responseCode + ', Response: ' + responseText);
      // Optional: Send email notification on error
      // MailApp.sendEmail('your-email@example.com', 'Form Submission Error', responseText);
    }
    
  } catch (error) {
    Logger.log('❌ Script error: ' + error.toString());
    // Optional: Send email notification on error
    // MailApp.sendEmail('your-email@example.com', 'Form Script Error', error.toString());
  }
}



