import { whatsappBusinessService } from '../services/whatsappBusiness.js';
import { log } from '../config/logger.js';

/**
 * Script to create WhatsApp templates via API
 * Run with: node src/scripts/createWhatsAppTemplates.js <userId>
 */

// Define templates based on template.md
const templates = [
  // {
  //   name: 'initial_welcome',
  //   category: 'UTILITY',
  //   language: 'pt_BR',
  //   components: [
  //     {
  //       type: 'BODY',
  //       text: 'Olá, {{1}}! 👋\nSou a {{2}}, assistente da clínica {{3}}.\n\nTentamos entrar em contato por telefone para confirmar sua consulta, mas não conseguimos falar com você.\n\nPodemos continuar o atendimento por aqui? 😊',
  //       example: {
  //         body_text: [
  //           ['João Silva', 'Valentina', 'Geniumed']
  //         ]
  //       }
  //     }
  //   ]
  // },
    // {
    //   name: 'appointment_confirmation_doc',
    //   category: 'UTILITY',
    //   language: 'pt_BR',
    //   components: [
    //     {
    //       type: 'BODY',
    //       text: 'Perfeito, {{1}}! 🎉\nSua consulta com o {{2}} está confirmada para o dia {{3}}, às {{4}}.\n\n📍 Endereço / Link: {{5}}\n\nCaso precise remarcar, é só responder por aqui. 😊',
    //       example: {
    //         body_text: [
    //           ['João Silva', 'Dr. Thiago Salati', '15/11/2025', '12:30', 'Rua da Alegria, 100']
    //         ]
    //       }
    //     }
    //   ]
    // },
  {
    name: 'appointment_confirmation_treat',
    category: 'UTILITY',
    language: 'pt_BR',
    components: [
      {
        type: 'BODY',
        text: 'Perfeito, {{1}}! 🎉\nSeu atendimento com {{2}} está confirmado para o dia {{3}}, às {{4}}.\n\n📍 Endereço / Link: {{5}}\n\nCaso precise remarcar, é só responder por aqui. 😊',
        example: {
          body_text: [
            ['João Silva', 'Tratamento Facial', '15/11/2025', '12:30', 'Rua da Alegria, 100']
          ]
        }
      }
    ]
  },
  // {
  //   name: 'earlier_appointment_offer',
  //   category: 'UTILITY',
  //   language: 'pt_BR',
  //   components: [
  //     {
  //       type: 'BODY',
  //       text: 'Olá, {{1}}! 😊\nAqui é a {{2}}, da clínica {{3}}.\n\nConseguimos alguns horários disponíveis antes da data que você mencionou ({{4}}):\n\n👉 {{5}}\n👉 {{6}}\n\nAlgum desses horários funciona para você?\nSe preferir, posso reservar agora mesmo. 👍',
  //       example: {
  //         body_text: [
  //           ['João Silva', 'Valentina', 'Geniumed', '15/11/2025', '13/11/2025 às 10:00', '14/11/2025 às 08:30']
  //         ]
  //       }
  //     }
  //   ]
  // }
];

async function createTemplates(userId) {
  try {
    log.info('Starting WhatsApp template creation process...');
    log.info(`User ID: ${userId}`);
    log.info(`Number of templates to create: ${templates.length}`);

    const results = [];

    for (const template of templates) {
      try {
        log.info(`\n📝 Creating template: ${template.name}`);
        
        const result = await whatsappBusinessService.createTemplate(userId, template);
        
        log.info(`✅ Template "${template.name}" created successfully!`, {
          templateId: result.templateId,
          status: result.status
        });
        
        results.push({
          name: template.name,
          success: true,
          templateId: result.templateId,
          status: result.status
        });

        // Wait a bit between requests to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        log.error(`❌ Failed to create template "${template.name}":`, error.message);
        results.push({
          name: template.name,
          success: false,
          error: error.message
        });
      }
    }

    // Summary
    log.info('\n' + '='.repeat(60));
    log.info('TEMPLATE CREATION SUMMARY');
    log.info('='.repeat(60));
    
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    log.info(`\n✅ Successfully created: ${successful.length}/${templates.length} templates`);
    successful.forEach(r => {
      log.info(`  - ${r.name} (ID: ${r.templateId}, Status: ${r.status})`);
    });

    if (failed.length > 0) {
      log.info(`\n❌ Failed to create: ${failed.length}/${templates.length} templates`);
      failed.forEach(r => {
        log.error(`  - ${r.name}: ${r.error}`);
      });
    }

    log.info('\n' + '='.repeat(60));
    log.info('📋 IMPORTANT NOTES:');
    log.info('='.repeat(60));
    log.info('1. Templates are submitted for review by Meta/WhatsApp');
    log.info('2. It may take 24-48 hours for templates to be approved');
    log.info('3. You can check template status in Meta Business Manager');
    log.info('4. Templates must be approved before you can use them');
    log.info('5. UTILITY category templates usually get approved faster');
    log.info('='.repeat(60));

    return results;

  } catch (error) {
    log.error('Fatal error during template creation:', error);
    throw error;
  }
}

// Main execution
const userId = process.argv[2];

if (!userId) {
  console.error('❌ Error: User ID is required');
  console.error('Usage: node src/scripts/createWhatsAppTemplates.js <userId>');
  console.error('Example: node src/scripts/createWhatsAppTemplates.js 123e4567-e89b-12d3-a456-426614174000');
  process.exit(1);
}

// Validate UUID format
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!uuidRegex.test(userId)) {
  console.error('❌ Error: Invalid User ID format. Must be a valid UUID.');
  process.exit(1);
}

createTemplates(userId)
  .then(() => {
    log.info('\n✅ Template creation process completed!');
    process.exit(0);
  })
  .catch((error) => {
    log.error('\n❌ Template creation process failed:', error);
    process.exit(1);
  });


