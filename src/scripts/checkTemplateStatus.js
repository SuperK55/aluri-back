import { whatsappBusinessService } from '../services/whatsappBusiness.js';
import { log } from '../config/logger.js';

/**
 * Script to check WhatsApp template status
 * Run with: node src/scripts/checkTemplateStatus.js <userId> [templateName]
 */

async function checkTemplateStatus(userId, specificTemplateName = null) {
  try {
    log.info('Checking WhatsApp template status...');
    log.info(`User ID: ${userId}`);
    
    if (specificTemplateName) {
      log.info(`Template: ${specificTemplateName}`);
    } else {
      log.info('Fetching all templates...');
    }

    // Fetch templates
    const options = {};
    if (specificTemplateName) {
      options.name = specificTemplateName;
    }

    const result = await whatsappBusinessService.getAllTemplates(userId, options);

    if (!result.templates || result.templates.length === 0) {
      if (specificTemplateName) {
        log.warn(`\n⚠️  Template "${specificTemplateName}" not found!`);
      } else {
        log.warn('\n⚠️  No templates found for this account.');
      }
      log.info('\n💡 Create templates using: node src/scripts/createWhatsAppTemplates.js <userId>');
      return;
    }

    // Display results
    log.info('\n' + '='.repeat(80));
    log.info('WHATSAPP TEMPLATES STATUS');
    log.info('='.repeat(80));
    log.info(`\nTotal templates: ${result.total}`);

    // Group by status
    const byStatus = {
      APPROVED: [],
      PENDING: [],
      REJECTED: [],
      OTHER: []
    };

    result.templates.forEach(template => {
      const status = template.status || 'UNKNOWN';
      if (byStatus[status]) {
        byStatus[status].push(template);
      } else {
        byStatus.OTHER.push(template);
      }
    });

    // Display approved templates
    if (byStatus.APPROVED.length > 0) {
      log.info('\n✅ APPROVED TEMPLATES (Ready to use):');
      byStatus.APPROVED.forEach(template => {
        log.info(`\n  📋 ${template.name}`);
        log.info(`     Language: ${template.language || 'N/A'}`);
        log.info(`     Category: ${template.category || 'N/A'}`);
        log.info(`     ID: ${template.id || 'N/A'}`);
        
        // Show components summary
        if (template.components && template.components.length > 0) {
          const bodyComponent = template.components.find(c => c.type === 'BODY');
          if (bodyComponent) {
            // Count variables
            const variableCount = (bodyComponent.text || '').match(/\{\{\d+\}\}/g)?.length || 0;
            log.info(`     Variables: ${variableCount}`);
            
            // Show first 100 chars of text
            const preview = (bodyComponent.text || '').substring(0, 1000);
            log.info(`     Preview: ${preview}${bodyComponent.text.length > 1000 ? '...' : ''}`);
          }
        }
      });
    }

    // Display pending templates
    if (byStatus.PENDING.length > 0) {
      log.info('\n⏳ PENDING TEMPLATES (Awaiting approval):');
      byStatus.PENDING.forEach(template => {
        log.info(`\n  📋 ${template.name}`);
        log.info(`     Language: ${template.language || 'N/A'}`);
        log.info(`     Category: ${template.category || 'N/A'}`);
        log.info(`     ID: ${template.id || 'N/A'}`);
        log.info(`     Status: Waiting for Meta review (may take 24-48 hours)`);
      });
    }

    // Display rejected templates
    if (byStatus.REJECTED.length > 0) {
      log.info('\n❌ REJECTED TEMPLATES:');
      byStatus.REJECTED.forEach(template => {
        log.info(`\n  📋 ${template.name}`);
        log.info(`     Language: ${template.language || 'N/A'}`);
        log.info(`     Category: ${template.category || 'N/A'}`);
        log.info(`     ID: ${template.id || 'N/A'}`);
        log.info(`     ⚠️  Check Meta Business Manager for rejection reason`);
      });
    }

    // Display other status templates
    if (byStatus.OTHER.length > 0) {
      log.info('\n⚪ OTHER STATUS:');
      byStatus.OTHER.forEach(template => {
        log.info(`\n  📋 ${template.name}`);
        log.info(`     Language: ${template.language || 'N/A'}`);
        log.info(`     Category: ${template.category || 'N/A'}`);
        log.info(`     Status: ${template.status || 'UNKNOWN'}`);
        log.info(`     ID: ${template.id || 'N/A'}`);
      });
    }

    // Summary
    log.info('\n' + '='.repeat(80));
    log.info('SUMMARY');
    log.info('='.repeat(80));
    log.info(`✅ Approved: ${byStatus.APPROVED.length}`);
    log.info(`⏳ Pending: ${byStatus.PENDING.length}`);
    log.info(`❌ Rejected: ${byStatus.REJECTED.length}`);
    if (byStatus.OTHER.length > 0) {
      log.info(`⚪ Other: ${byStatus.OTHER.length}`);
    }

    // Next steps
    log.info('\n' + '='.repeat(80));
    log.info('NEXT STEPS');
    log.info('='.repeat(80));
    
    if (byStatus.PENDING.length > 0) {
      log.info('\n⏳ You have templates pending approval:');
      log.info('   - Wait 24-48 hours for Meta to review');
      log.info('   - Check Meta Business Manager for updates');
      log.info('   - Run this script again to check status');
    }
    
    if (byStatus.APPROVED.length > 0) {
      log.info('\n✅ You have approved templates ready to use:');
      log.info('   - Test sending: node src/scripts/testWhatsAppTemplates.js <userId> <phone> <templateName>');
      log.info('   - Start your WhatsApp agent');
      log.info('   - Send messages via API');
    }
    
    if (byStatus.REJECTED.length > 0) {
      log.info('\n❌ You have rejected templates:');
      log.info('   - Check Meta Business Manager for rejection reason');
      log.info('   - Review WhatsApp Business Policy');
      log.info('   - Modify and resubmit templates');
    }

    if (result.templates.length === 0) {
      log.info('\n📝 No templates found. Create templates:');
      log.info('   - Run: node src/scripts/createWhatsAppTemplates.js <userId>');
    }

    log.info('\n' + '='.repeat(80));
    log.info('🔗 USEFUL LINKS');
    log.info('='.repeat(80));
    log.info('Meta Business Manager: https://business.facebook.com');
    log.info('WhatsApp Templates Guide: See WHATSAPP_TEMPLATES_GUIDE.md');
    log.info('='.repeat(80));

    return result;

  } catch (error) {
    log.error('\n❌ Error checking template status:', error.message);
    
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
const templateName = process.argv[3] || null;

if (!userId) {
  console.error('❌ Error: User ID is required');
  console.error('\nUsage: node src/scripts/checkTemplateStatus.js <userId> [templateName]');
  console.error('\nExamples:');
  console.error('  # Check all templates');
  console.error('  node src/scripts/checkTemplateStatus.js 123e4567-e89b-12d3-a456-426614174000');
  console.error('\n  # Check specific template');
  console.error('  node src/scripts/checkTemplateStatus.js 123e4567-e89b-12d3-a456-426614174000 appointment_confirmation_doc');
  process.exit(1);
}

// Validate UUID format
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!uuidRegex.test(userId)) {
  console.error('❌ Error: Invalid User ID format. Must be a valid UUID.');
  process.exit(1);
}

checkTemplateStatus(userId, templateName)
  .then(() => {
    log.info('\n✅ Template status check completed!');
    process.exit(0);
  })
  .catch((error) => {
    log.error('\n❌ Template status check failed:', error);
    process.exit(1);
  });


