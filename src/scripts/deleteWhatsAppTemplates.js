import { whatsappBusinessService } from '../services/whatsappBusiness.js';
import { log } from '../config/logger.js';

/**
 * Script to delete WhatsApp templates via API
 * 
 * Usage:
 *   Delete all templates: node src/scripts/deleteWhatsAppTemplates.js <userId> --all
 *   Delete specific templates: node src/scripts/deleteWhatsAppTemplates.js <userId> template1 template2 ...
 *   List templates first: node src/scripts/deleteWhatsAppTemplates.js <userId> --list
 */

async function listAllTemplates(userId) {
  try {
    log.info('Fetching all templates...');
    const result = await whatsappBusinessService.getAllTemplates(userId);
    
    if (!result.templates || result.templates.length === 0) {
      log.info('No templates found.');
      return [];
    }

    log.info(`\nFound ${result.templates.length} template(s):\n`);
    result.templates.forEach((template, index) => {
      log.info(`${index + 1}. ${template.name}`);
      log.info(`   Status: ${template.status}`);
      log.info(`   Language: ${template.language}`);
      log.info(`   Category: ${template.category}`);
      log.info(`   ID: ${template.id}`);
      log.info('');
    });

    return result.templates;
  } catch (error) {
    log.error('Error fetching templates:', error);
    throw error;
  }
}

async function deleteTemplates(userId, templateNames = null, deleteAll = false) {
  try {
    log.info('Starting WhatsApp template deletion process...');
    log.info(`User ID: ${userId}`);

    let templatesToDelete = [];

    if (deleteAll) {
      log.info('Fetching all templates to delete...');
      const allTemplates = await listAllTemplates(userId);
      templatesToDelete = allTemplates.map(t => t.name);
      log.info(`\n⚠️  WARNING: About to delete ${templatesToDelete.length} template(s)!`);
    } else if (templateNames && templateNames.length > 0) {
      templatesToDelete = templateNames;
      log.info(`\nTemplates to delete: ${templatesToDelete.join(', ')}`);
    } else {
      log.info('\nNo templates specified. Use --all to delete all, or specify template names.');
      log.info('Use --list to see all available templates.');
      return;
    }

    if (templatesToDelete.length === 0) {
      log.info('No templates to delete.');
      return;
    }

    log.info(`\nNumber of templates to delete: ${templatesToDelete.length}`);
    log.info('='.repeat(60));

    const results = [];

    for (const templateName of templatesToDelete) {
      try {
        log.info(`\n🗑️  Deleting template: ${templateName}`);
        
        const result = await whatsappBusinessService.deleteTemplate(userId, templateName);
        
        log.info(`✅ Template "${templateName}" deleted successfully!`);
        
        results.push({
          name: templateName,
          success: true
        });

        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        log.error(`❌ Failed to delete template "${templateName}":`, error.message);
        results.push({
          name: templateName,
          success: false,
          error: error.message
        });
      }
    }

    log.info('\n' + '='.repeat(60));
    log.info('TEMPLATE DELETION SUMMARY');
    log.info('='.repeat(60));
    
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    log.info(`\n✅ Successfully deleted: ${successful.length}/${templatesToDelete.length} templates`);
    successful.forEach(r => {
      log.info(`  - ${r.name}`);
    });

    if (failed.length > 0) {
      log.info(`\n❌ Failed to delete: ${failed.length}/${templatesToDelete.length} templates`);
      failed.forEach(r => {
        log.error(`  - ${r.name}: ${r.error}`);
      });
    }

    log.info('\n' + '='.repeat(60));
    log.info('📋 IMPORTANT NOTES:');
    log.info('='.repeat(60));
    log.info('1. Deleted templates cannot be recovered');
    log.info('2. You can create new templates with the same or different names');
    log.info('3. After deletion, you can create new templates using:');
    log.info('   node src/scripts/createWhatsAppTemplates.js <userId>');
    log.info('='.repeat(60));

    return results;

  } catch (error) {
    log.error('Fatal error during template deletion:', error);
    throw error;
  }
}

const userId = process.argv[2];
const args = process.argv.slice(3);

if (!userId) {
  console.error('❌ Error: User ID is required');
  console.error('\nUsage:');
  console.error('  List all templates:');
  console.error('    node src/scripts/deleteWhatsAppTemplates.js <userId> --list');
  console.error('\n  Delete all templates:');
  console.error('    node src/scripts/deleteWhatsAppTemplates.js <userId> --all');
  console.error('\n  Delete specific templates:');
  console.error('    node src/scripts/deleteWhatsAppTemplates.js <userId> template1 template2 ...');
  console.error('\nExample:');
  console.error('    node src/scripts/deleteWhatsAppTemplates.js 123e4567-e89b-12d3-a456-426614174000 --list');
  console.error('    node src/scripts/deleteWhatsAppTemplates.js 123e4567-e89b-12d3-a456-426614174000 --all');
  console.error('    node src/scripts/deleteWhatsAppTemplates.js 123e4567-e89b-12d3-a456-426614174000 appointment_confirmation_doc initial_welcome');
  process.exit(1);
}

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!uuidRegex.test(userId)) {
  console.error('❌ Error: Invalid User ID format. Must be a valid UUID.');
  process.exit(1);
}

if (args.includes('--list')) {
  listAllTemplates(userId)
    .then(() => {
      log.info('\n✅ Template listing completed!');
      process.exit(0);
    })
    .catch((error) => {
      log.error('\n❌ Failed to list templates:', error);
      process.exit(1);
    });
} else if (args.includes('--all')) {
  deleteTemplates(userId, null, true)
    .then(() => {
      log.info('\n✅ Template deletion process completed!');
      process.exit(0);
    })
    .catch((error) => {
      log.error('\n❌ Template deletion process failed:', error);
      process.exit(1);
    });
} else if (args.length > 0) {
  deleteTemplates(userId, args, false)
    .then(() => {
      log.info('\n✅ Template deletion process completed!');
      process.exit(0);
    })
    .catch((error) => {
      log.error('\n❌ Template deletion process failed:', error);
      process.exit(1);
    });
} else {
  console.error('❌ Error: No action specified');
  console.error('Use --list to see all templates, --all to delete all, or specify template names');
  process.exit(1);
}
