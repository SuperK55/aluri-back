import { supa } from './src/lib/supabase.js';
import { whatsappBusinessService } from './src/services/whatsappBusiness.js';
import { log } from './src/config/logger.js';

/**
 * Verify WhatsApp credentials and create templates
 * Usage: node verify-and-create.js <userId>
 */

const userId = process.argv[2];

if (!userId) {
  console.error('❌ Error: User ID is required');
  console.error('Usage: node verify-and-create.js <userId>');
  console.error('Example: node verify-and-create.js d9c6312b-bacc-4db0-b448-45ba3defad5');
  process.exit(1);
}

async function verifyAndCreate() {
  try {
    console.log('================================================');
    console.log('  WhatsApp Credentials Verification');
    console.log('================================================\n');
    console.log(`User ID: ${userId}\n`);

    // Step 1: Get user info
    console.log('📋 Step 1: Checking user information...');
    const { data: user, error: userError } = await supa
      .from('users')
      .select('email, whatsapp_connected, whatsapp_verified, whatsapp_phone_number, whatsapp_phone_id, whatsapp_business_account_id, whatsapp_access_token')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      console.error('❌ User not found or error:', userError?.message);
      process.exit(1);
    }

    console.log(`✅ User found: ${user.email}`);
    console.log('');

    // Step 2: Check WhatsApp credentials
    console.log('📋 Step 2: Checking WhatsApp credentials...');
    console.log(`   Connected: ${user.whatsapp_connected ? '✅' : '❌'}`);
    console.log(`   Verified: ${user.whatsapp_verified ? '✅' : '⚠️'}`);
    console.log(`   Phone Number: ${user.whatsapp_phone_number || '❌ Missing'}`);
    console.log(`   Phone ID: ${user.whatsapp_phone_id ? '✅ Present' : '❌ Missing'}`);
    console.log(`   Business Account ID: ${user.whatsapp_business_account_id ? '✅ Present' : '❌ Missing'}`);
    console.log(`   Access Token: ${user.whatsapp_access_token ? `✅ Present (${user.whatsapp_access_token.substring(0, 20)}...)` : '❌ Missing'}`);
    console.log('');

    // Check if all required fields are present
    if (!user.whatsapp_connected) {
      console.error('❌ WhatsApp is not connected. Please connect via Geniumed dashboard.');
      process.exit(1);
    }

    if (!user.whatsapp_phone_id || !user.whatsapp_access_token || !user.whatsapp_business_account_id) {
      console.error('❌ Missing required WhatsApp credentials. Please reconnect your WhatsApp Business account.');
      process.exit(1);
    }

    console.log('✅ All WhatsApp credentials are present!\n');

    // Step 3: Check existing templates
    console.log('📋 Step 3: Checking existing templates...');
    try {
      const templates = await whatsappBusinessService.getAllTemplates(userId);
      console.log(`   Found ${templates.total} existing template(s)`);
      
      if (templates.templates && templates.templates.length > 0) {
        console.log('   Existing templates:');
        templates.templates.forEach(t => {
          console.log(`     - ${t.name} (${t.status})`);
        });
      }
      console.log('');
    } catch (err) {
      console.log(`   ⚠️  Could not fetch templates: ${err.message}\n`);
    }

    // Step 4: Ask to proceed
    console.log('================================================');
    console.log('  Ready to Create Templates');
    console.log('================================================\n');
    console.log('This will create 3 templates:');
    console.log('  1. initial_contact_greeting');
    console.log('  2. appointment_confirmation_doctor');
    console.log('  3. earlier_slot_offer\n');
    
    console.log('Creating templates now...\n');

    // Import and run the template creation
    const templates = [
      {
        name: 'appointment_confirmation_treatment',
        category: 'UTILITY',
        language: 'pt_BR',
        components: [
          {
            type: 'BODY',
            text: 'Perfeito, {{1}}! 🎉\nSeu atendimento com {{2}} está confirmado para {{3}} às {{4}}.\nEndereço / link: {{5}}\n\nSe precisar remarcar, é só responder aqui. 😊',
            example: {
              body_text: [
                ['João Silva', 'Depilação a Laser', '15/11/2025', '12:30', 'Rua da alegria 100']
              ]
            }
          }
        ]
      },
    ];

    const results = [];

    for (const template of templates) {
      try {
        console.log(`📝 Creating template: ${template.name}`);
        
        const result = await whatsappBusinessService.createTemplate(userId, template);
        
        console.log(`✅ Template "${template.name}" created successfully!`);
        console.log(`   Template ID: ${result.templateId}`);
        console.log(`   Status: ${result.status}\n`);
        
        results.push({
          name: template.name,
          success: true,
          templateId: result.templateId,
          status: result.status
        });

        // Wait a bit between requests
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        console.error(`❌ Failed to create template "${template.name}":`, error.message, '\n');
        results.push({
          name: template.name,
          success: false,
          error: error.message
        });
      }
    }

    // Summary
    console.log('================================================');
    console.log('  TEMPLATE CREATION SUMMARY');
    console.log('================================================\n');
    
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    console.log(`✅ Successfully created: ${successful.length}/${templates.length} templates`);
    successful.forEach(r => {
      console.log(`   - ${r.name} (ID: ${r.templateId}, Status: ${r.status})`);
    });

    if (failed.length > 0) {
      console.log(`\n❌ Failed to create: ${failed.length}/${templates.length} templates`);
      failed.forEach(r => {
        console.log(`   - ${r.name}: ${r.error}`);
      });
    }

    console.log('\n================================================');
    console.log('  IMPORTANT NOTES');
    console.log('================================================');
    console.log('1. Templates are submitted for review by Meta/WhatsApp');
    console.log('2. It may take 24-48 hours for templates to be approved');
    console.log('3. You can check template status in Meta Business Manager');
    console.log('4. Templates must be approved before you can use them');
    console.log('5. UTILITY category templates usually get approved faster');
    console.log('================================================\n');

    console.log('Next steps:');
    console.log(`  1. Check status: ./check-template-status.sh ${userId}`);
    console.log(`  2. Wait for approval (24-48 hours)`);
    console.log(`  3. Test templates once approved\n`);

    process.exit(0);

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  }
}

verifyAndCreate();

