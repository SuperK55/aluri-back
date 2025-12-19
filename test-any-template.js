import { whatsappBusinessService } from './src/services/whatsappBusiness.js';
import { log } from './src/config/logger.js';

/**
 * Test any WhatsApp template with custom parameters
 * Usage: node test-any-template.js <userId> <phoneNumber> <templateName> [param1] [param2] ...
 */

const userId = process.argv[2];
const phoneNumber = process.argv[3];
const templateName = process.argv[4];
const params = process.argv.slice(5);

if (!userId || !phoneNumber || !templateName) {
  console.error('❌ Error: Missing required arguments\n');
  console.error('Usage: node test-any-template.js <userId> <phoneNumber> <templateName> [param1] [param2] ...\n');
  console.error('Examples:\n');
  console.error('  # Template with no variables (hello_world)');
  console.error('  node test-any-template.js d9c6312b-bacc-4db0-b448-45ba3defad59 +5511999999999 hello_world\n');
  console.error('  # Template with 2 variables (aviso_de_consulta)');
  console.error('  node test-any-template.js d9c6312b-bacc-4db0-b448-45ba3defad59 +5511999999999 aviso_de_consulta "João Silva" "Clínica Geniumed"\n');
  console.error('  # Template with 3 variables (boas_vindas_mensagem)');
  console.error('  node test-any-template.js d9c6312b-bacc-4db0-b448-45ba3defad59 +5511999999999 boas_vindas_mensagem "João Silva" "Clara" "Geniumed"\n');
  console.error('  # Template with 4 variables (confirmao_de_consulta)');
  console.error('  node test-any-template.js d9c6312b-bacc-4db0-b448-45ba3defad59 +5511999999999 confirmao_de_consulta "Dr. Thiago" "15/11/2025" "14:30" "Rua da Alegria 100"\n');
  process.exit(1);
}

// Validate phone number format
if (!phoneNumber.match(/^\+?[1-9]\d{1,14}$/)) {
  console.error('❌ Error: Invalid phone number format.');
  console.error('   Use E.164 format: +5511999999999');
  process.exit(1);
}

async function testTemplate() {
  try {
    console.log('================================================');
    console.log('  WhatsApp Template Test');
    console.log('================================================\n');
    console.log(`User ID: ${userId}`);
    console.log(`Phone: ${phoneNumber}`);
    console.log(`Template: ${templateName}`);
    console.log(`Parameters: ${params.length > 0 ? params.join(', ') : 'None'}\n`);

    // First, check if template exists and get its details
    console.log('📋 Checking template status...\n');
    const templates = await whatsappBusinessService.getAllTemplates(userId, {
      name: templateName
    });

    if (!templates.templates || templates.templates.length === 0) {
      console.error(`❌ Template "${templateName}" not found!`);
      console.log('\n💡 Available templates:');
      const allTemplates = await whatsappBusinessService.getAllTemplates(userId);
      allTemplates.templates.forEach(t => {
        console.log(`   - ${t.name} (${t.status})`);
      });
      process.exit(1);
    }

    const template = templates.templates[0];
    console.log(`✅ Template found:`);
    console.log(`   Name: ${template.name}`);
    console.log(`   Status: ${template.status}`);
    console.log(`   Language: ${template.language}`);
    console.log(`   Category: ${template.category}`);

    if (template.status !== 'APPROVED') {
      console.error(`\n❌ Template status is "${template.status}" (not APPROVED)`);
      console.log('   Template must be APPROVED before you can send messages.');
      console.log('   Check Meta Business Manager for approval status.');
      process.exit(1);
    }

    // Count expected variables
    const bodyComponent = template.components?.find(c => c.type === 'BODY');
    const expectedVars = bodyComponent?.text?.match(/\{\{\d+\}\}/g)?.length || 0;
    
    console.log(`   Expected variables: ${expectedVars}`);
    console.log(`   Provided parameters: ${params.length}\n`);

    if (params.length !== expectedVars) {
      console.error(`❌ Parameter mismatch!`);
      console.error(`   Expected: ${expectedVars} parameters`);
      console.error(`   Provided: ${params.length} parameters\n`);
      
      if (bodyComponent?.text) {
        console.log('Template text:');
        console.log(`   "${bodyComponent.text.substring(0, 200)}${bodyComponent.text.length > 200 ? '...' : ''}"\n`);
      }
      
      console.log('💡 Provide the correct number of parameters in order.');
      process.exit(1);
    }

    // Build components array
    const components = [];
    
    if (params.length > 0) {
      components.push({
        type: 'body',
        parameters: params.map(param => ({
          type: 'text',
          text: param
        }))
      });
    }

    // Send template message
    console.log('📤 Sending template message...\n');
    
    const result = await whatsappBusinessService.sendTemplateMessage(
      userId,
      phoneNumber,
      templateName,
      template.language,
      components
    );

    console.log('✅ Template message sent successfully!\n');
    console.log(`   Message ID: ${result.messageId}`);
    console.log(`   To: ${phoneNumber}`);
    console.log(`   Template: ${templateName}`);

    if (params.length > 0) {
      console.log('\n📝 Parameters sent:');
      params.forEach((param, idx) => {
        console.log(`   {{${idx + 1}}} = "${param}"`);
      });
    }

    console.log('\n🎉 Test completed successfully!');
    console.log(`📱 Check WhatsApp at ${phoneNumber} for the message.\n`);

  } catch (error) {
    console.error('\n❌ Template test failed:', error.message);
    
    if (error.message.includes('not connected')) {
      console.log('\n💡 WhatsApp Business is not connected.');
      console.log('   Connect your WhatsApp Business account first.');
    } else if (error.message.includes('Account ID not found')) {
      console.log('\n💡 WhatsApp Business Account ID not found.');
      console.log('   Reconnect your WhatsApp Business account.');
    }
    
    process.exit(1);
  }
}

testTemplate();


