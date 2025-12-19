import { whatsappBusinessService } from '../services/whatsappBusiness.js';
import { log } from '../config/logger.js';

/**
 * Script to test WhatsApp template sending
 * Run with: node src/scripts/testWhatsAppTemplates.js <userId> <phoneNumber> <templateName>
 */

async function sendTestTemplate(userId, phoneNumber, templateName) {
  try {
    log.info('Testing WhatsApp template sending...');
    log.info(`User ID: ${userId}`);
    log.info(`Phone Number: ${phoneNumber}`);
    log.info(`Template: ${templateName}`);

    // Define test data for each template
    const templateTestData = {
      'initial_welcome': {
        languageCode: 'pt_BR',
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'João Silva' },
              { type: 'text', text: 'Valentina' },
              { type: 'text', text: 'Geniumed' }
            ]
          }
        ]
      },
      'appointment_confirmation_doc': {
        languageCode: 'pt_BR',
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'João Silva' },
              { type: 'text', text: 'Dr. Thiago Salati' },
              { type: 'text', text: '15/11/2025' },
              { type: 'text', text: '14:30' },
              { type: 'text', text: 'Rua da Alegria 100' }
            ]
          }
        ]
      },
      'appointment_confirmation_treat': {
        languageCode: 'pt_BR',
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'João Silva' },
              { type: 'text', text: 'Tratamento Facial' },
              { type: 'text', text: '15/11/2025' },
              { type: 'text', text: '14:30' },
              { type: 'text', text: 'Rua da Alegria 100' }
            ]
          }
        ]
      },
      'earlier_appointment_offer': {
        languageCode: 'pt_BR',
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'João Silva' },
              { type: 'text', text: 'Valentina' },
              { type: 'text', text: 'Geniumed' },
              { type: 'text', text: '15/11/2025' },
              { type: 'text', text: '13/11/2025 às 10:00' },
              { type: 'text', text: '14/11/2025 às 08:30' }
            ]
          }
        ]
      }
    };

    // Check if template test data exists
    if (!templateTestData[templateName]) {
      log.error(`Unknown template: ${templateName}`);
      log.info('\nAvailable templates:');
      Object.keys(templateTestData).forEach(name => {
        log.info(`  - ${name}`);
      });
      process.exit(1);
    }

    // First, check if template exists and is approved
    log.info('\n📋 Checking template status...');
    try {
      const templates = await whatsappBusinessService.getAllTemplates(userId, {
        name: templateName
      });

      if (!templates.templates || templates.templates.length === 0) {
        log.error(`❌ Template "${templateName}" not found!`);
        log.info('\n💡 Tips:');
        log.info('1. Create the template first using: node src/scripts/createWhatsAppTemplates.js <userId>');
        log.info('2. Wait for Meta approval (24-48 hours)');
        process.exit(1);
      }

      const template = templates.templates[0];
      log.info(`✅ Template found: ${template.name}`);
      log.info(`   Status: ${template.status}`);
      log.info(`   Language: ${template.language}`);
      log.info(`   Category: ${template.category}`);

      if (template.status !== 'APPROVED') {
        log.warn(`\n⚠️  Template status is "${template.status}" (not APPROVED)`);
        log.info('\n💡 Template must be APPROVED before you can send messages with it.');
        log.info('   Check Meta Business Manager for approval status.');
        process.exit(1);
      }
    } catch (checkError) {
      log.error('Error checking template:', checkError.message);
    }

    // Send test template message
    log.info('\n📤 Sending test template message...');
    
    const testData = templateTestData[templateName];
    const result = await whatsappBusinessService.sendTemplateMessage(
      userId,
      phoneNumber,
      templateName,
      testData.languageCode,
      testData.components
    );

    log.info('\n✅ Template message sent successfully!');
    log.info(`   Message ID: ${result.messageId}`);
    log.info(`   To: ${phoneNumber}`);
    log.info(`   Template: ${templateName}`);

    // Show what was sent
    log.info('\n📝 Template parameters sent:');
    testData.components.forEach((component, idx) => {
      if (component.type === 'body') {
        log.info(`   Body parameters:`);
        component.parameters.forEach((param, paramIdx) => {
          log.info(`     {{${paramIdx + 1}}} = "${param.text}"`);
        });
      }
    });

    log.info('\n🎉 Test completed successfully!');
    return result;

  } catch (error) {
    log.error('\n❌ Template test failed:', error.message);
    
    if (error.message.includes('not connected')) {
      log.info('\n💡 WhatsApp Business is not connected.');
      log.info('   Connect your WhatsApp Business account first via the Geniumed dashboard.');
    } else if (error.message.includes('Account ID not found')) {
      log.info('\n💡 WhatsApp Business Account ID not found.');
      log.info('   Reconnect your WhatsApp Business account via the Geniumed dashboard.');
    }
    
    throw error;
  }
}

// Main execution
const userId = process.argv[2];
const phoneNumber = process.argv[3];
const templateName = process.argv[4];

if (!userId || !phoneNumber || !templateName) {
  console.error('❌ Error: Missing required arguments');
  console.error('\nUsage: node src/scripts/testWhatsAppTemplates.js <userId> <phoneNumber> <templateName>');
  console.error('\nExamples:');
  console.error('  node src/scripts/testWhatsAppTemplates.js 123e4567-e89b-12d3-a456-426614174000 +5511999999999 initial_welcome');
  console.error('  node src/scripts/testWhatsAppTemplates.js 123e4567-e89b-12d3-a456-426614174000 +5511999999999 appointment_confirmation_doc');
  console.error('  node src/scripts/testWhatsAppTemplates.js 123e4567-e89b-12d3-a456-426614174000 +5511999999999 appointment_confirmation_treat');
  console.error('  node src/scripts/testWhatsAppTemplates.js 123e4567-e89b-12d3-a456-426614174000 +5511999999999 earlier_appointment_offer');
  console.error('\nAvailable templates:');
  console.error('  - initial_welcome');
  console.error('  - appointment_confirmation_doc');
  console.error('  - appointment_confirmation_treat');
  console.error('  - earlier_appointment_offer');
  process.exit(1);
}

// Validate UUID format
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!uuidRegex.test(userId)) {
  console.error('❌ Error: Invalid User ID format. Must be a valid UUID.');
  process.exit(1);
}

// Validate phone number format (basic check for E.164)
if (!phoneNumber.match(/^\+?[1-9]\d{1,14}$/)) {
  console.error('❌ Error: Invalid phone number format.');
  console.error('   Use E.164 format: +5511999999999');
  process.exit(1);
}

sendTestTemplate(userId, phoneNumber, templateName)
  .then(() => {
    log.info('\n✅ Template test completed!');
    process.exit(0);
  })
  .catch((error) => {
    log.error('\n❌ Template test failed:', error);
    process.exit(1);
  });


