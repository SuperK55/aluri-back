import { Router } from 'express';
import { verifyJWT } from '../middleware/verifyJWT.js';
import { whatsappBusinessService } from '../services/whatsappBusiness.js';
import { normalizePhoneNumber, retellCreateChat, retellSendChatMessage } from '../lib/retell.js';
import { supa } from '../lib/supabase.js';
import { log } from '../config/logger.js';
import { env } from '../config/env.js';
import { agentManager } from '../services/agentManager.js';

const router = Router();

/**
 * WhatsApp templates to create automatically
 * These templates are created when a user connects their WhatsApp Business account
 */
const WHATSAPP_TEMPLATES = [
  {
    name: 'initial_welcome',
    category: 'UTILITY',
    language: 'pt_BR',
    components: [
      {
        type: 'BODY',
        text: 'Olá, {{1}}! 👋\nSou a {{2}}, assistente da clínica {{3}}.\n\nTentamos entrar em contato por telefone para confirmar sua consulta, mas não conseguimos falar com você.\n\nPodemos continuar o atendimento por aqui? 😊',
        example: {
          body_text: [
            ['João Silva', 'Valentina', 'Geniumed']
          ]
        }
      }
    ]
  },
  {
    name: 'appointment_confirmation_doc',
    category: 'UTILITY',
    language: 'pt_BR',
    components: [
      {
        type: 'BODY',
        text: 'Perfeito, {{1}}! 🎉\nSua consulta com o {{2}} está confirmada para o dia {{3}}, às {{4}}.\n\n📍 Endereço / Link: {{5}}\n\nCaso precise remarcar, é só responder por aqui. 😊',
        example: {
          body_text: [
            ['João Silva', 'Dr. Thiago Salati', '15/11/2025', '12:30', 'Rua da Alegria, 100']
          ]
        }
      }
    ]
  },
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
  {
    name: 'earlier_appointment_offer',
    category: 'UTILITY',
    language: 'pt_BR',
    components: [
      {
        type: 'BODY',
        text: 'Olá, {{1}}! 😊\nAqui é a {{2}}, da clínica {{3}}.\n\nConseguimos alguns horários disponíveis antes da data que você mencionou ({{4}}):\n\n👉 {{5}}\n👉 {{6}}\n\nAlgum desses horários funciona para você?\nSe preferir, posso reservar agora mesmo. 👍',
        example: {
          body_text: [
            ['João Silva', 'Valentina', 'Geniumed', '15/11/2025', '13/11/2025 às 10:00', '14/11/2025 às 08:30']
          ]
        }
      }
    ]
  }
];

/**
 * Automatically create WhatsApp templates for a user after they connect their account
 * This runs in the background and doesn't block the connection response
 * @param {string} userId - User ID
 */
async function createWhatsAppTemplatesForUser(userId) {
  try {
    log.info(`Starting automatic template creation for user ${userId}...`);

    // Get existing templates to avoid duplicates
    let existingTemplates = [];
    try {
      const templatesResponse = await whatsappBusinessService.getAllTemplates(userId, {
        limit: 100
      });
      existingTemplates = templatesResponse.data || [];
      log.info(`Found ${existingTemplates.length} existing templates`);
    } catch (error) {
      log.warn('Could not fetch existing templates, will attempt to create all:', error.message);
      // Continue anyway - if template exists, API will return an error we can handle
    }

    const existingTemplateNames = new Set(
      existingTemplates.map(t => t.name?.toLowerCase())
    );

    const results = [];
    let createdCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const template of WHATSAPP_TEMPLATES) {
      try {
        // Check if template already exists
        if (existingTemplateNames.has(template.name.toLowerCase())) {
          log.info(`Template "${template.name}" already exists, skipping...`);
          results.push({
            name: template.name,
            success: true,
            skipped: true,
            reason: 'Template already exists'
          });
          skippedCount++;
          continue;
        }

        log.info(`Creating template: ${template.name}`);
        
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
        createdCount++;

        // Wait between requests to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        // Check if error is because template already exists
        const errorMessage = error.message?.toLowerCase() || '';
        if (errorMessage.includes('already exists') || 
            errorMessage.includes('duplicate') ||
            errorMessage.includes('name already in use')) {
          log.info(`Template "${template.name}" already exists (detected from error), skipping...`);
          results.push({
            name: template.name,
            success: true,
            skipped: true,
            reason: 'Template already exists'
          });
          skippedCount++;
        } else {
          log.error(`❌ Failed to create template "${template.name}":`, error.message);
          results.push({
            name: template.name,
            success: false,
            error: error.message
          });
          failedCount++;
        }
      }
    }

    // Summary log
    log.info('='.repeat(60));
    log.info('AUTOMATIC TEMPLATE CREATION SUMMARY');
    log.info('='.repeat(60));
    log.info(`✅ Created: ${createdCount}/${WHATSAPP_TEMPLATES.length} templates`);
    log.info(`⏭️  Skipped (already exist): ${skippedCount}/${WHATSAPP_TEMPLATES.length} templates`);
    if (failedCount > 0) {
      log.info(`❌ Failed: ${failedCount}/${WHATSAPP_TEMPLATES.length} templates`);
    }
    log.info('='.repeat(60));
    log.info('📋 Note: Templates are submitted for Meta/WhatsApp review.');
    log.info('   It may take 24-48 hours for templates to be approved.');
    log.info('='.repeat(60));

    return results;

  } catch (error) {
    log.error('Fatal error during automatic template creation:', error);
    // Don't throw - this is a background process
    return [];
  }
}

/**
 * Get WhatsApp Business connection status
 * GET /api/whatsapp/status
 */
router.get('/status', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;

    const status = await whatsappBusinessService.getConnectionStatus(userId);

    res.json({
      ok: true,
      whatsapp: status
    });

  } catch (error) {
    log.error('Get WhatsApp status error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to get WhatsApp connection status'
    });
  }
});

/**
 * Connect WhatsApp Business account
 * POST /api/whatsapp/connect
 * 
 * Body: {
 *   phone_id: "string",
 *   access_token: "string",
 *   business_account_id: "string",
 *   phone_number: "+1234567890",
 *   display_phone_number: "+1 (234) 567-8900",
 *   verified: boolean
 * }
 */
router.post('/connect', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      phone_id,
      access_token,
      business_account_id,
      phone_number,
      display_phone_number,
      verified
    } = req.body;

    // Validate required fields
    if (!phone_id || !access_token || !business_account_id || !phone_number) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: phone_id, access_token, business_account_id, phone_number'
      });
    }

    // Verify the access token is valid by making a test API call
    try {
      const testResponse = await fetch(
        `https://graph.facebook.com/v18.0/${phone_id}`,
        {
          headers: {
            'Authorization': `Bearer ${access_token}`
          }
        }
      );

      if (!testResponse.ok) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid WhatsApp Business credentials. Please check your access token.'
        });
      }
    } catch (verifyError) {
      log.error('Error verifying WhatsApp credentials:', verifyError);
      return res.status(400).json({
        ok: false,
        error: 'Failed to verify WhatsApp Business credentials'
      });
    }

    // Store credentials
    const result = await whatsappBusinessService.storeWhatsAppCredentials(userId, {
      phoneId: phone_id,
      accessToken: access_token,
      businessAccountId: business_account_id,
      phoneNumber: phone_number,
      displayPhoneNumber: display_phone_number,
      verified: verified || false
    });

    // Automatically create WhatsApp templates after successful connection
    // Run in background - don't block the response
    createWhatsAppTemplatesForUser(userId).catch(error => {
      log.error('Failed to create WhatsApp templates after connection:', error);
      // Don't throw - connection was successful, templates can be created later
    });

    res.json({
      ok: true,
      message: 'WhatsApp Business connected successfully',
      whatsapp: {
        connected: true,
        phoneNumber: display_phone_number || phone_number,
        verified: verified || false,
        webhookVerifyToken: result.webhookVerifyToken
      }
    });

  } catch (error) {
    log.error('Connect WhatsApp error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to connect WhatsApp Business account'
    });
  }
});

/**
 * Disconnect WhatsApp Business account
 * POST /api/whatsapp/disconnect
 */
router.post('/disconnect', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;

    await whatsappBusinessService.disconnectWhatsApp(userId);

    res.json({
      ok: true,
      message: 'WhatsApp Business disconnected successfully'
    });

  } catch (error) {
    log.error('Disconnect WhatsApp error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to disconnect WhatsApp Business account'
    });
  }
});

/**
 * Send appointment confirmation via WhatsApp (plain text)
 * POST /api/whatsapp/send-appointment-confirmation
 * 
 * Body: {
 *   patient_phone: "+1234567890",
 *   patient_name: "John Doe",
 *   doctor_name: "Dr. Smith",
 *   appointment_date: "January 20, 2024",
 *   appointment_time: "2:00 PM",
 *   location: "123 Main St"
 * }
 */
router.post('/send-appointment-confirmation', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      patient_phone,
      patient_name,
      doctor_name,
      appointment_date,
      appointment_time,
      location
    } = req.body;

    // Validate required fields
    if (!patient_phone || !patient_name || !doctor_name || !appointment_date || !appointment_time) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields'
      });
    }

    // Normalize phone number (handles Brazilian format and converts to E.164)
    let normalizedPhone;
    try {
      normalizedPhone = normalizePhoneNumber(patient_phone);
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: `Invalid phone number format: ${error.message}`
      });
    }

    const result = await whatsappBusinessService.sendAppointmentConfirmation(userId, normalizedPhone, {
      patientName: patient_name,
      doctorName: doctor_name,
      appointmentDate: appointment_date,
      appointmentTime: appointment_time,
      location: location || 'Our clinic'
    });

    res.json({
      ok: true,
      message: 'Appointment confirmation sent successfully',
      messageId: result.messageId
    });

  } catch (error) {
    log.error('Send appointment confirmation error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to send appointment confirmation'
    });
  }
});

/**
 * Send appointment confirmation template via WhatsApp with buttons
 * POST /api/whatsapp/send-appointment-confirmation-template
 * 
 * Body: {
 *   appointment_id: "uuid", // Optional: if provided, message ID will be stored in appointment
 *   patient_phone: "+1234567890",
 *   patient_name: "John Doe",
 *   doctor_name: "Dr. Smith",
 *   appointment_date: "20 de Janeiro de 2024",
 *   appointment_time: "14:00",
 *   location: "Clínica Geniumed - Sala 5",
 *   template_name: "appointment_confirmation_with_button", // Optional
 *   language_code: "pt_BR" // Optional
 * }
 */
router.post('/send-appointment-confirmation-template', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      appointment_id,
      patient_phone,
      patient_name,
      doctor_name,
      appointment_date,
      appointment_time,
      location,
      template_name,
      language_code
    } = req.body;

    // Validate required fields
    if (!patient_phone || !patient_name || !doctor_name || !appointment_date || !appointment_time) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: patient_phone, patient_name, doctor_name, appointment_date, appointment_time'
      });
    }

    // Normalize phone number (handles Brazilian format and converts to E.164)
    let normalizedPhone;
    try {
      normalizedPhone = normalizePhoneNumber(patient_phone);
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: `Invalid phone number format: ${error.message}`
      });
    }

    // If appointment_id is provided, verify it belongs to the user
    if (appointment_id) {
      const { data: appointment, error: appointmentError } = await supa
        .from('appointments')
        .select('id, owner_id')
        .eq('id', appointment_id)
        .eq('owner_id', userId)
        .single();

      if (appointmentError || !appointment) {
        return res.status(404).json({
          ok: false,
          error: 'Appointment not found or access denied'
        });
      }
    }

    let formattedDate = appointment_date;
    if (/^\d{4}-\d{2}-\d{2}$/.test(appointment_date)) {
      const [year, month, day] = appointment_date.split('-');
      formattedDate = `${day}/${month}/${year}`;
    }

    const result = await whatsappBusinessService.sendAppointmentConfirmationTemplate(
      userId,
      normalizedPhone,
      {
        patientName: patient_name,
        doctorName: doctor_name,
        appointmentDate: formattedDate,
        appointmentTime: appointment_time,
        location: location || 'Nossa clínica',
        templateName: template_name,
        languageCode: language_code
      },
      appointment_id || null
    );

    res.json({
      ok: true,
      message: 'Appointment confirmation template sent successfully',
      messageId: result.messageId,
      appointmentId: appointment_id || null
    });

  } catch (error) {
    log.error('Send appointment confirmation template error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to send appointment confirmation template',
      details: error.message
    });
  }
});

/**
 * Send telemedicine meeting link via WhatsApp
 * POST /api/whatsapp/send-meeting-link
 * 
 * Body: {
 *   patient_phone: "+1234567890",
 *   patient_name: "John Doe",
 *   doctor_name: "Dr. Smith",
 *   meeting_link: "https://meet.google.com/...",
 *   appointment_time: "2:00 PM"
 * }
 */
router.post('/send-meeting-link', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      patient_phone,
      patient_name,
      doctor_name,
      meeting_link,
      appointment_time
    } = req.body;

    // Validate required fields
    if (!patient_phone || !patient_name || !doctor_name || !meeting_link || !appointment_time) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields'
      });
    }

    // Normalize phone number (handles Brazilian format and converts to E.164)
    let normalizedPhone;
    try {
      normalizedPhone = normalizePhoneNumber(patient_phone);
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: `Invalid phone number format: ${error.message}`
      });
    }

    const result = await whatsappBusinessService.sendMeetingLink(userId, normalizedPhone, {
      patientName: patient_name,
      doctorName: doctor_name,
      meetingLink: meeting_link,
      appointmentTime: appointment_time
    });

    res.json({
      ok: true,
      message: 'Meeting link sent successfully',
      messageId: result.messageId
    });

  } catch (error) {
    log.error('Send meeting link error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to send meeting link'
    });
  }
});

/**
 * Send WhatsApp template message
 * POST /api/whatsapp/send-template
 * 
 * Body: {
 *   to: "+1234567890",
 *   template_name: "welcome_message",
 *   language_code: "en",
 *   components: [
 *     {
 *       type: "body",
 *       parameters: [
 *         {
 *           type: "text",
 *           text: "John"
 *         }
 *       ]
 *     },
 *     {
 *       type: "button",
 *       sub_type: "url",
 *       index: 0,
 *       parameters: [
 *         {
 *           type: "text",
 *           text: "https://example.com"
 *         }
 *       ]
 *     }
 *   ]
 * }
 */
router.post('/send-template', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      to,
      template_name,
      language_code,
      components
    } = req.body;

    // Validate required fields
    if (!to || !template_name) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: to, template_name'
      });
    }

    // Normalize phone number (handles Brazilian format and converts to E.164)
    let normalizedPhone;
    try {
      normalizedPhone = normalizePhoneNumber(to);
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: `Invalid phone number format: ${error.message}`
      });
    }

    const result = await whatsappBusinessService.sendTemplateMessage(
      userId,
      normalizedPhone,
      template_name,
      language_code || 'en',
      components || []
    );

    res.json({
      ok: true,
      message: 'WhatsApp template message sent successfully',
      messageId: result.messageId,
      data: result.data
    });

  } catch (error) {
    log.error('Send WhatsApp template error:', error);
    
    if (error.message.includes('not connected')) {
      return res.status(400).json({
        ok: false,
        error: 'WhatsApp Business not connected. Please connect your account first.'
      });
    }

    res.status(500).json({
      ok: false,
      error: 'Failed to send WhatsApp template message',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Get all WhatsApp templates
 * GET /api/whatsapp/templates
 */
router.get('/templates', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit, status, name, language } = req.query;

    const options = {};
    if (limit) options.limit = parseInt(limit);
    if (status) options.status = status;
    if (name) options.name = name;
    if (language) options.language = language;

    const result = await whatsappBusinessService.getAllTemplates(userId, options);

    res.json({
      ok: true,
      templates: result.templates,
      total: result.total,
      paging: result.paging
    });

  } catch (error) {
    log.error('Get WhatsApp templates error:', error);
    
    if (error.message.includes('not connected') || error.message.includes('not found')) {
      return res.status(400).json({
        ok: false,
        error: error.message
      });
    }

    res.status(500).json({
      ok: false,
      error: 'Failed to get WhatsApp templates',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Create a new WhatsApp template
 * POST /api/whatsapp/templates
 * 
 * Body: {
 *   name: "template_name",
 *   language: "pt_BR",
 *   category: "UTILITY",
 *   components: [
 *     {
 *       type: "BODY",
 *       text: "Hello {{1}}! Your appointment is on {{2}}.",
 *       example: {
 *         body_text: [["John", "January 20"]]
 *       }
 *     }
 *   ],
 *   allowCategoryChange: false
 * }
 */
router.post('/templates', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const templateData = req.body;

    // Validate required fields
    if (!templateData.name) {
      return res.status(400).json({
        ok: false,
        error: 'Template name is required'
      });
    }

    if (!templateData.components || templateData.components.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Template must have at least one component'
      });
    }

    const result = await whatsappBusinessService.createTemplate(userId, templateData);

    res.status(201).json({
      ok: true,
      message: 'WhatsApp template created successfully. It will be reviewed by Meta and may take 24-48 hours to be approved.',
      templateId: result.templateId,
      status: result.status,
      name: result.name,
      data: result.data
    });

  } catch (error) {
    log.error('Create WhatsApp template error:', error);
    
    if (error.message.includes('not connected') || error.message.includes('not found')) {
      return res.status(400).json({
        ok: false,
        error: error.message
      });
    }

    res.status(500).json({
      ok: false,
      error: 'Failed to create WhatsApp template',
      details: error.message
    });
  }
});

/**
 * Delete a WhatsApp template
 * DELETE /api/whatsapp/templates/:templateName
 */
router.delete('/templates/:templateName', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const { templateName } = req.params;

    if (!templateName) {
      return res.status(400).json({
        ok: false,
        error: 'Template name is required'
      });
    }

    const result = await whatsappBusinessService.deleteTemplate(userId, templateName);

    res.json({
      ok: true,
      message: 'WhatsApp template deleted successfully',
      data: result.data
    });

  } catch (error) {
    log.error('Delete WhatsApp template error:', error);
    
    if (error.message.includes('not connected') || error.message.includes('not found')) {
      return res.status(400).json({
        ok: false,
        error: error.message
      });
    }

    res.status(500).json({
      ok: false,
      error: 'Failed to delete WhatsApp template',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * WhatsApp webhook verification
 * GET /api/whatsapp/webhook
 */
router.get('/webhook', async (req, res) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    // Check if webhook verification request
    if (mode === 'subscribe' && token) {
      // Find user by their WhatsApp verify token
      // const { data: user, error } = await supa
      //   .from('users')
      //   .select('id, whatsapp_webhook_verify_token')
      //   .eq('whatsapp_webhook_verify_token', token)
      //   .single();

      // if (error || !user) {
      //   log.warn('WhatsApp webhook verification failed: invalid token or user not found');
      //   return res.sendStatus(403);
      // }

      // log.info(`WhatsApp webhook verified successfully for user ${user.id}`);
      return res.status(200).send(challenge);
    }

    res.sendStatus(400);

  } catch (error) {
    log.error('WhatsApp webhook verification error:', error);
    res.sendStatus(500);
  }
});

/**
 * WhatsApp webhook handler (incoming messages)
 * POST /api/whatsapp/webhook
 */
router.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // Verify webhook signature
    const signature = req.headers['x-hub-signature-256'];
    if (signature && env.WHATSAPP_APP_SECRET) {
      const isValid = whatsappBusinessService.verifyWebhookSignature(
        signature,
        JSON.stringify(body),
        env.WHATSAPP_APP_SECRET
      );

      if (!isValid) {
        log.warn('WhatsApp webhook signature verification failed');
        return res.sendStatus(403);
      }
    }

    // Process webhook payload
    if (body.object === 'whatsapp_business_account') {
      if (body.entry) {
        for (const entry of body.entry) {
          if (entry.changes) {
            for (const change of entry.changes) {
              if (change.field === 'messages') {
                const value = change.value;
                
                // Handle incoming messages
                if (value.messages) {
                  for (const message of value.messages) {
                    const phoneNumber = message.from;
                    const messageId = message.id;
                    
                    log.info('Received WhatsApp message:', {
                      from: phoneNumber,
                      type: message.type,
                      messageId: messageId
                    });

                    // Handle button clicks (Quick Reply buttons from templates)
                    if (message.type === 'button' && message.button) {
                      const buttonText = message.button.text; // e.g., "CONFIRMAR", "CANCELAR", "CONFIRM"
                      const buttonPayload = message.button.payload;
                      const originalMessageId = message.context?.id; // The ID of the template message we sent
                      
                      log.info('Button clicked:', {
                        from: phoneNumber,
                        buttonText: buttonText,
                        buttonPayload: buttonPayload,
                        messageId: messageId,
                        originalMessageId: originalMessageId
                      });

                      // Find appointment by phone number and optionally by message ID
                      // First, try to find by message ID (most accurate)
                      let appointment = null;
                      
                      if (originalMessageId) {
                        const { data: appointmentByMessage, error: msgError } = await supa
                          .from('appointments')
                          .select(`
                            id,
                            status,
                            owner_id,
                            lead_id,
                            start_at,
                            leads(phone)
                          `)
                          .eq('whatsapp_confirmation_message_id', originalMessageId)
                          .eq('status', 'scheduled')
                          .order('start_at', { ascending: true })
                          .limit(1)
                          .maybeSingle();
                        
                        if (!msgError && appointmentByMessage) {
                          appointment = appointmentByMessage;
                        }
                      }
                      
                      // If not found by message ID, find by phone number (most recent scheduled appointment)
                      if (!appointment) {
                        // Normalize phone number (remove + and spaces for comparison)
                        const normalizedPhone = phoneNumber.replace(/[\s\+]/g, '');
                        
                        const { data: appointmentsByPhone, error: phoneError } = await supa
                          .from('appointments')
                          .select(`
                            id,
                            status,
                            owner_id,
                            lead_id,
                            start_at,
                            leads(phone)
                          `)
                          .eq('status', 'scheduled')
                          .order('start_at', { ascending: true })
                          .limit(10);
                        
                        if (!phoneError && appointmentsByPhone) {
                          // Find matching phone number (handle different formats)
                          appointment = appointmentsByPhone.find(apt => {
                            const leadPhone = apt.leads?.phone?.replace(/[\s\+]/g, '') || '';
                            return leadPhone === normalizedPhone || 
                                   leadPhone.endsWith(normalizedPhone.slice(-8)) || // Last 8 digits
                                   normalizedPhone.endsWith(leadPhone.slice(-8));
                          });
                        }
                      }
                      
                      if (!appointment) {
                        log.warn('Appointment not found for button click:', {
                          phoneNumber,
                          buttonText,
                          originalMessageId
                        });
                        // Optionally send a message to the user
                        // await whatsappBusinessService.sendTextMessage(ownerId, phoneNumber, 'Sorry, we could not find your appointment. Please contact us directly.');
                        return;
                      }
                      
                      const appointmentId = appointment.id;
                      const ownerId = appointment.owner_id;
                      
                      // Handle different button actions
                      if (buttonText === 'CONFIRMAR' || buttonText === 'CONFIRM') {
                        // Update appointment status to confirmed
                        const { error: updateError } = await supa
                          .from('appointments')
                          .update({ 
                            status: 'confirmed',
                            updated_at: new Date().toISOString()
                          })
                          .eq('id', appointmentId);
                        
                        if (updateError) {
                          log.error('Error confirming appointment:', updateError);
                        } else {
                          log.info('Appointment confirmed via WhatsApp button:', {
                            appointmentId,
                            phoneNumber
                          });
                          
                          // Send acknowledgment message
                          try {
                            await whatsappBusinessService.sendTextMessage(
                              ownerId,
                              phoneNumber,
                              '✅ Perfeito! Sua consulta está confirmada. Te esperamos! 😊'
                            );
                          } catch (msgError) {
                            log.error('Error sending confirmation acknowledgment:', msgError);
                          }
                        }
                      } 
                      else if (buttonText === 'CANCELAR' || buttonText === 'CANCEL') {
                        // Update appointment status to cancelled
                        const { error: updateError } = await supa
                          .from('appointments')
                          .update({ 
                            status: 'cancelled',
                            updated_at: new Date().toISOString()
                          })
                          .eq('id', appointmentId);
                        
                        if (updateError) {
                          log.error('Error cancelling appointment:', updateError);
                        } else {
                          log.info('Appointment cancelled via WhatsApp button:', {
                            appointmentId,
                            phoneNumber
                          });
                          
                          // Send acknowledgment message
                          try {
                            await whatsappBusinessService.sendTextMessage(
                              ownerId,
                              phoneNumber,
                              'Entendido! Sua consulta foi cancelada. Se precisar remarcar, é só avisar! 😊'
                            );
                          } catch (msgError) {
                            log.error('Error sending cancellation acknowledgment:', msgError);
                          }
                        }
                      }
                      else if (buttonText === 'REMARCAR' || buttonText === 'RESCHEDULE') {
                        // Keep appointment as scheduled but mark for rescheduling
                        log.info('Appointment reschedule requested via WhatsApp button:', {
                          appointmentId,
                          phoneNumber
                        });
                        
                        // Send message asking for new date/time
                        try {
                          await whatsappBusinessService.sendTextMessage(
                            ownerId,
                            phoneNumber,
                            'Sem problema! Qual data e horário funcionam melhor para você? 📅'
                          );
                        } catch (msgError) {
                          log.error('Error sending reschedule message:', msgError);
                        }
                      }
                    }
                    else if (message.type === 'text') {
                      const messageText = message.text?.body;
                      
                      log.info('Received text message:', {
                        from: phoneNumber,
                        text: messageText,
                        messageId: messageId
                      });

                      try {
                        const waPhone = phoneNumber.replace(/[^\d]/g, '');
                        
                        // #region agent log
                        fetch('http://localhost:7243/ingest/fa704248-e3dd-4b0a-ab9f-643803e5688c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'whatsapp.js:879',message:'Processing WhatsApp text message',data:{phoneNumber,waPhone,messageId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
                        // #endregion
                        
                        const { data: existingOpenChat } = await supa
                          .from('whatsapp_chats')
                          .select('*')
                          .eq('wa_phone', waPhone)
                          .in('status', ['open', 'pending_response'])
                          .order('created_at', { ascending: false })
                          .limit(1)
                          .maybeSingle();

                        const { data: existingEndedChat } = await supa
                          .from('whatsapp_chats')
                          .select('*')
                          .eq('wa_phone', waPhone)
                          .in('status', ['ended', 'completed'])
                          .order('updated_at', { ascending: false })
                          .limit(1)
                          .maybeSingle();

                        let existingChat = existingOpenChat;
                        let needsNewRetellSession = false;
                        
                        if (!existingOpenChat && existingEndedChat) {
                          existingChat = existingEndedChat;
                          needsNewRetellSession = true;
                          log.info('Found ended chat, will create new Retell session:', { chatId: existingEndedChat.id });
                        }

                        let chat = existingChat;
                        let lead = null;
                        let ownerId = null;
                        let serviceType = 'clinic';
                        let chatAgent = null;

                        if (existingChat) {
                          ownerId = existingChat.owner_id;
                          
                          fetch('http://localhost:7243/ingest/fa704248-e3dd-4b0a-ab9f-643803e5688c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'whatsapp.js:896',message:'Found existing chat',data:{chatId:existingChat.id,existingLeadId:existingChat.lead_id,waPhone,needsNewRetellSession},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
                          
                          if (existingChat.lead_id) {
                            const { data: leadData } = await supa
                          .from('leads')
                              .select('*, agent_variables')
                              .eq('id', existingChat.lead_id)
                              .single();
                            lead = leadData;
                            
                            fetch('http://localhost:7243/ingest/fa704248-e3dd-4b0a-ab9f-643803e5688c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'whatsapp.js:905',message:'Loaded lead from existing chat',data:{leadId:lead?.id,leadPhone:lead?.phone},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
                          }

                          serviceType = existingChat.metadata?.service_type || 
                            (lead?.assigned_resource_type === 'treatment' ? 'beauty_clinic' : 'clinic');

                          if (needsNewRetellSession) {
                            chatAgent = await agentManager.getChatAgentForOwner(ownerId, serviceType);
                            
                            if (chatAgent) {
                              try {
                                const { data: ownerData } = await supa
                                  .from('users')
                                  .select('name, location')
                                  .eq('id', ownerId)
                                  .single();

                              // Get available slots from existing chat if it exists
                              let slotVariables = {};
                              // Use chat object which should have agent_variables from the whatsapp_chats table
                              if (chat?.agent_variables) {
                                const chatVars = chat.agent_variables;
                                if (chatVars.slot_1) slotVariables.slot_1 = String(chatVars.slot_1);
                                if (chatVars.slot_1_date) slotVariables.slot_1_date = String(chatVars.slot_1_date);
                                if (chatVars.slot_1_time) slotVariables.slot_1_time = String(chatVars.slot_1_time);
                                if (chatVars.slot_2) slotVariables.slot_2 = String(chatVars.slot_2);
                                if (chatVars.slot_2_date) slotVariables.slot_2_date = String(chatVars.slot_2_date);
                                if (chatVars.slot_2_time) slotVariables.slot_2_time = String(chatVars.slot_2_time);
                                if (chatVars.available_slots) slotVariables.available_slots = String(chatVars.available_slots);
                                if (chatVars.suggested_date) slotVariables.suggested_date = String(chatVars.suggested_date);
                              }
                              
                              if (Object.keys(slotVariables).length > 0) {
                                log.info('Including available slots in Retell chat (followup):', {
                                  slot_1: slotVariables.slot_1,
                                  slot_2: slotVariables.slot_2,
                                  available_slots: slotVariables.available_slots
                                });
                              }

                                const chatVariables = {
                                  ...(lead?.agent_variables || {}),
                                  ...slotVariables, // Include available slots from WhatsApp chat
                                  chat_type: 'followup',
                                  name: String(lead?.name || 'Cliente'),
                                  lead_id: String(lead?.id || ''),
                                  business_name: ownerData?.name || '',
                                  location: ownerData?.location || ''
                                };

                                Object.keys(chatVariables).forEach(key => {
                                  if (chatVariables[key] !== null && chatVariables[key] !== undefined) {
                                    chatVariables[key] = String(chatVariables[key]);
                                  }
                                });

                                const retellChat = await retellCreateChat({
                                  agent_id: chatAgent.retell_agent_id,
                                  retell_llm_dynamic_variables: chatVariables,
                                  metadata: {
                                    lead_id: lead?.id || null,
                                    owner_id: ownerId,
                                    chat_type: 'followup',
                                    wa_phone: waPhone,
                                    previous_chat_id: existingChat.id
                                  }
                                });

                                await supa
                                  .from('whatsapp_chats')
                                  .update({ 
                                    status: 'open',
                                    retell_chat_id: retellChat.chat_id,
                                    agent_id: chatAgent.retell_agent_id,
                                    last_message_at: new Date().toISOString(),
                                    updated_at: new Date().toISOString(),
                                    metadata: {
                                      ...existingChat.metadata,
                                      chat_type: 'followup',
                                      previous_retell_chat_id: existingChat.retell_chat_id
                                    }
                                  })
                                  .eq('id', existingChat.id);

                                chat = { ...existingChat, retell_chat_id: retellChat.chat_id, status: 'open' };
                                log.info('Created new Retell session for ended chat:', { chatId: existingChat.id, newRetellChatId: retellChat.chat_id });
                              } catch (retellError) {
                                log.error('Failed to create new Retell session:', retellError.message);
                              }
                            }
                          } else {
                            await supa
                              .from('whatsapp_chats')
                              .update({ 
                                status: 'open',
                                last_message_at: new Date().toISOString(),
                                updated_at: new Date().toISOString()
                              })
                              .eq('id', existingChat.id);
                          }

                        } else {
                          const normalizedPhone = phoneNumber.replace(/[\s\+]/g, '');
                          
                          // #region agent log
                          fetch('http://localhost:7243/ingest/fa704248-e3dd-4b0a-ab9f-643803e5688c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'whatsapp.js:920',message:'No existing chat, searching for lead',data:{phoneNumber,normalizedPhone,waPhone},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
                          // #endregion
                          
                          const { data: leads } = await supa
                            .from('leads')
                            .select('*, agent_variables')
                            .order('updated_at', { ascending: false })
                            .limit(50);

                          // #region agent log
                          fetch('http://localhost:7243/ingest/fa704248-e3dd-4b0a-ab9f-643803e5688c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'whatsapp.js:927',message:'Lead search results',data:{leadsChecked:leads?.length||0,normalizedPhone,waPhone},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
                          // #endregion

                          lead = leads?.find(l => {
                          const leadPhone = l.phone?.replace(/[\s\+]/g, '') || '';
                          const exactMatch = leadPhone === normalizedPhone;
                          const endsWithMatch = leadPhone.endsWith(normalizedPhone.slice(-8)) || normalizedPhone.endsWith(leadPhone.slice(-8));
                          
                          // #region agent log
                          fetch('http://localhost:7243/ingest/fa704248-e3dd-4b0a-ab9f-643803e5688c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'whatsapp.js:930',message:'Checking lead phone match',data:{leadId:l.id,leadPhone,normalizedPhone,exactMatch,endsWithMatch,matched:exactMatch||endsWithMatch},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
                          // #endregion
                          
                          return exactMatch || endsWithMatch;
                        });

                          // #region agent log
                          fetch('http://localhost:7243/ingest/fa704248-e3dd-4b0a-ab9f-643803e5688c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'whatsapp.js:936',message:'Lead lookup result',data:{leadFound:!!lead,leadId:lead?.id||null,leadPhone:lead?.phone||null,normalizedPhone},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
                          // #endregion

                          if (lead) {
                            ownerId = lead.owner_id;
                            serviceType = lead.assigned_resource_type === 'treatment' ? 'beauty_clinic' : 'clinic';
                          } else {
                            const { data: owners } = await supa
                              .from('users')
                              .select('id')
                              .limit(1);
                            
                            if (owners && owners.length > 0) {
                              ownerId = owners[0].id;
                              
                              // #region agent log
                              fetch('http://localhost:7243/ingest/fa704248-e3dd-4b0a-ab9f-643803e5688c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'whatsapp.js:946',message:'No lead found, using default owner',data:{ownerId,phoneNumber,normalizedPhone},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
                              // #endregion
                            } else {
                              log.warn('No owner found for unknown WhatsApp message');
                          return;
                        }
                          }
                        }

                        if (!ownerId) {
                          log.warn('Cannot determine owner for WhatsApp message:', { phoneNumber });
                          return;
                        }

                        chatAgent = await agentManager.getChatAgentForOwner(ownerId, serviceType);

                        if (!chatAgent) {
                          log.warn('No chat agent found:', { ownerId, serviceType });
                          await whatsappBusinessService.sendTextMessage(
                            ownerId,
                            phoneNumber,
                            `Olá! Recebemos sua mensagem e vamos te responder em breve. 😊`
                          );
                          return;
                        }

                        if (!chat) {
                          let retellChatId = null;
                          
                          try {
                            const { data: ownerData } = await supa
                              .from('users')
                              .select('name, location')
                              .eq('id', ownerId)
                              .single();

                            // Get available slots from existing chat if it exists
                            // First try to get from existingChat (if found earlier), otherwise query for it
                            let slotVariables = {};
                            let chatWithSlots = existingChat;
                            
                            if (!chatWithSlots && waPhone) {
                              // Query for existing chat to get slot information
                              const { data: chatData } = await supa
                                .from('whatsapp_chats')
                                .select('agent_variables')
                                .eq('wa_phone', waPhone)
                                .order('last_message_at', { ascending: false })
                                .limit(1)
                                .maybeSingle();
                              chatWithSlots = chatData;
                            }
                            
                            if (chatWithSlots?.agent_variables) {
                              const chatVars = chatWithSlots.agent_variables;
                              if (chatVars.slot_1) slotVariables.slot_1 = String(chatVars.slot_1);
                              if (chatVars.slot_1_date) slotVariables.slot_1_date = String(chatVars.slot_1_date);
                              if (chatVars.slot_1_time) slotVariables.slot_1_time = String(chatVars.slot_1_time);
                              if (chatVars.slot_2) slotVariables.slot_2 = String(chatVars.slot_2);
                              if (chatVars.slot_2_date) slotVariables.slot_2_date = String(chatVars.slot_2_date);
                              if (chatVars.slot_2_time) slotVariables.slot_2_time = String(chatVars.slot_2_time);
                              if (chatVars.available_slots) slotVariables.available_slots = String(chatVars.available_slots);
                              if (chatVars.suggested_date) slotVariables.suggested_date = String(chatVars.suggested_date);
                            }

                            const chatVariables = {
                              ...(lead?.agent_variables || {}),
                              ...slotVariables, // Include available slots from WhatsApp chat
                              chat_type: lead ? 'welcome' : 'other',
                              name: String(lead?.name || 'Cliente'),
                              lead_id: String(lead?.id || ''),
                              business_name: ownerData?.name || '',
                              location: ownerData?.location || ''
                            };

                            Object.keys(chatVariables).forEach(key => {
                              if (chatVariables[key] !== null && chatVariables[key] !== undefined) {
                                chatVariables[key] = String(chatVariables[key]);
                              }
                            });

                            const retellChat = await retellCreateChat({
                              agent_id: chatAgent.retell_agent_id,
                              retell_llm_dynamic_variables: chatVariables,
                              metadata: {
                                lead_id: lead?.id || null,
                                owner_id: ownerId,
                                chat_type: lead ? 'welcome' : 'other',
                                wa_phone: waPhone
                              }
                            });

                            retellChatId = retellChat.chat_id;
                            log.info('Created new Retell chat:', { chatId: retellChatId, waPhone });
                          } catch (chatCreateError) {
                            log.error('Failed to create Retell chat:', chatCreateError.message);
                          }

                          const chatLeadId = lead?.id || null;
                          
                          // #region agent log
                          fetch('http://localhost:7243/ingest/fa704248-e3dd-4b0a-ab9f-643803e5688c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'whatsapp.js:1013',message:'Creating new chat record',data:{ownerId,leadId:chatLeadId,waPhone,hasLead:!!lead,phoneNumber},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
                          // #endregion
                          
                          // Check for existing active chat for this phone number
                          const { data: existingChat } = await supa
                            .from('whatsapp_chats')
                            .select('id')
                            .eq('wa_phone', waPhone)
                            .in('status', ['open', 'pending_response'])
                            .single();

                          let newChat;
                          if (existingChat) {
                            // Update existing active chat
                            const { data: updatedChat, error: updateError } = await supa
                              .from('whatsapp_chats')
                              .update({
                                lead_id: chatLeadId,
                                retell_chat_id: retellChatId,
                                agent_id: chatAgent.retell_agent_id,
                                status: 'open',
                                metadata: {
                                  chat_type: lead ? 'welcome' : 'other',
                                  service_type: serviceType
                                },
                                last_message_at: new Date().toISOString()
                              })
                              .eq('id', existingChat.id)
                              .select()
                              .single();

                            if (updateError) {
                              log.error('Error updating whatsapp_chats record:', updateError.message);
                              
                              // #region agent log
                              fetch('http://localhost:7243/ingest/fa704248-e3dd-4b0a-ab9f-643803e5688c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'whatsapp.js:1032',message:'Chat update error',data:{error:updateError.message,leadId:chatLeadId,waPhone},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
                              // #endregion
                              
                              return;
                            }
                            newChat = updatedChat;
                          } else {
                            // Insert new chat record
                            const { data: insertedChat, error: insertError } = await supa
                            .from('whatsapp_chats')
                            .insert({
                              owner_id: ownerId,
                              lead_id: chatLeadId,
                              wa_phone: waPhone,
                              retell_chat_id: retellChatId,
                              agent_id: chatAgent.retell_agent_id,
                              status: 'open',
                              metadata: {
                                chat_type: lead ? 'welcome' : 'other',
                                service_type: serviceType
                              },
                              last_message_at: new Date().toISOString()
                            })
                            .select()
                            .single();

                          if (insertError) {
                            log.error('Error creating whatsapp_chats record:', insertError.message);
                            
                            // #region agent log
                            fetch('http://localhost:7243/ingest/fa704248-e3dd-4b0a-ab9f-643803e5688c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'whatsapp.js:1032',message:'Chat insert error',data:{error:insertError.message,leadId:chatLeadId,waPhone},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
                            // #endregion
                            
                            return;
                            }
                            newChat = insertedChat;
                          }

                          chat = newChat;
                          
                          // #region agent log
                          fetch('http://localhost:7243/ingest/fa704248-e3dd-4b0a-ab9f-643803e5688c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'whatsapp.js:1036',message:'Chat created successfully',data:{chatId:newChat.id,leadId:newChat.lead_id,waPhone,phoneNumber},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
                          // #endregion

                          if (lead) {
                          await supa
                            .from('leads')
                            .update({
                              status: 'whatsapp_conversation',
                              last_contact_channel: 'whatsapp',
                              updated_at: new Date().toISOString()
                            })
                            .eq('id', lead.id);
                          }
                        }

                        await supa
                          .from('whatsapp_messages')
                          .insert({
                            chat_id: chat.id,
                            direction: 'inbound',
                            sender: 'user',
                            wa_message_id: messageId,
                            body: messageText,
                            message_type: 'text',
                            is_template: false
                          });

                        if (chat.retell_chat_id) {
                          try {
                            const completion = await retellSendChatMessage(
                              chat.retell_chat_id,
                              messageText
                            );

                            const messages = completion.messages || [];
                            const agentMessages = messages.filter(m => m.role === 'agent' && m.content);
                            const agentReply = agentMessages.map(m => m.content).join('\n') || '';

                            if (agentReply) {
                              const sendResult = await whatsappBusinessService.sendTextMessage(
                          ownerId,
                          phoneNumber,
                                agentReply
                        );

                        await supa
                                .from('whatsapp_messages')
                                .insert({
                                  chat_id: chat.id,
                                  direction: 'outbound',
                                  sender: 'agent',
                                  wa_message_id: sendResult?.messageId || null,
                                  body: agentReply,
                                  message_type: 'text',
                                  is_template: false
                                });

                              await supa
                                .from('whatsapp_chats')
                          .update({
                                  last_message_at: new Date().toISOString(),
                                  last_agent_message_id: sendResult?.messageId || null,
                            updated_at: new Date().toISOString()
                          })
                                .eq('id', chat.id);

                              log.info('Agent reply sent:', {
                                chatId: chat.id,
                                replyLength: agentReply.length
                              });
                            }

                          } catch (retellError) {
                            log.error('Retell chat completion error, trying to create new chat:', retellError.message);
                            
                            try {
                              const { data: ownerData } = await supa
                                .from('users')
                                .select('name, location')
                                .eq('id', ownerId)
                                .single();

                              // Get available slots from existing chat if it exists
                              let slotVariables = {};
                              // Use chat object which should have agent_variables from the whatsapp_chats table
                              if (chat?.agent_variables) {
                                const chatVars = chat.agent_variables;
                                if (chatVars.slot_1) slotVariables.slot_1 = String(chatVars.slot_1);
                                if (chatVars.slot_1_date) slotVariables.slot_1_date = String(chatVars.slot_1_date);
                                if (chatVars.slot_1_time) slotVariables.slot_1_time = String(chatVars.slot_1_time);
                                if (chatVars.slot_2) slotVariables.slot_2 = String(chatVars.slot_2);
                                if (chatVars.slot_2_date) slotVariables.slot_2_date = String(chatVars.slot_2_date);
                                if (chatVars.slot_2_time) slotVariables.slot_2_time = String(chatVars.slot_2_time);
                                if (chatVars.available_slots) slotVariables.available_slots = String(chatVars.available_slots);
                                if (chatVars.suggested_date) slotVariables.suggested_date = String(chatVars.suggested_date);
                              }
                              
                              if (Object.keys(slotVariables).length > 0) {
                                log.info('Including available slots in Retell chat (error recovery):', {
                                  slot_1: slotVariables.slot_1,
                                  slot_2: slotVariables.slot_2,
                                  available_slots: slotVariables.available_slots
                                });
                              }

                              const chatVariables = {
                                ...(lead?.agent_variables || {}),
                                ...slotVariables, // Include available slots from WhatsApp chat
                                chat_type: 'other',
                                name: String(lead?.name || 'Cliente'),
                                lead_id: String(lead?.id || ''),
                                business_name: ownerData?.name || '',
                                location: ownerData?.location || ''
                              };

                              Object.keys(chatVariables).forEach(key => {
                                if (chatVariables[key] !== null && chatVariables[key] !== undefined) {
                                  chatVariables[key] = String(chatVariables[key]);
                                }
                              });

                              const newRetellChat = await retellCreateChat({
                                agent_id: chatAgent.retell_agent_id,
                                retell_llm_dynamic_variables: chatVariables,
                                metadata: {
                                  lead_id: lead?.id || null,
                                  owner_id: ownerId,
                                  chat_type: 'other',
                                  wa_phone: waPhone
                                }
                              });

                              const newRetellChatId = newRetellChat.chat_id;
                              log.info('Created new Retell chat after error:', { chatId: newRetellChatId, waPhone });

                              await supa
                                .from('whatsapp_chats')
                                .update({
                                  retell_chat_id: newRetellChatId,
                                  status: 'open',
                                  updated_at: new Date().toISOString()
                                })
                                .eq('id', chat.id);

                              const retryCompletion = await retellSendChatMessage(newRetellChatId, messageText);
                              const retryMessages = retryCompletion.messages || [];
                              const retryAgentMessages = retryMessages.filter(m => m.role === 'agent' && m.content);
                              const retryAgentReply = retryAgentMessages.map(m => m.content).join('\n') || '';

                              if (retryAgentReply) {
                                const retrySendResult = await whatsappBusinessService.sendTextMessage(
                                  ownerId,
                                  phoneNumber,
                                  retryAgentReply
                                );

                                await supa
                                  .from('whatsapp_messages')
                                  .insert({
                                    chat_id: chat.id,
                                    direction: 'outbound',
                                    sender: 'agent',
                                    wa_message_id: retrySendResult?.messageId || null,
                                    body: retryAgentReply,
                                    message_type: 'text',
                                    is_template: false
                                  });

                                await supa
                                  .from('whatsapp_chats')
                                  .update({
                                    last_message_at: new Date().toISOString(),
                                    last_agent_message_id: retrySendResult?.messageId || null,
                                    updated_at: new Date().toISOString()
                                  })
                                  .eq('id', chat.id);

                                log.info('Agent reply sent after retry:', {
                                  chatId: chat.id,
                                  replyLength: retryAgentReply.length
                                });
                              }
                            } catch (retryError) {
                              log.error('Failed to create new Retell chat on retry:', retryError.message);
                              // Don't try to send another message if the previous one failed - it will likely fail too
                              try {
                                await whatsappBusinessService.sendTextMessage(
                                  ownerId,
                                  phoneNumber,
                                  'Desculpe, estou tendo dificuldades técnicas. Por favor, tente novamente em alguns instantes. 🙏'
                                );
                              } catch (fallbackError) {
                                log.error('Failed to send fallback message:', fallbackError.message);
                                // Silently fail - we've already logged the error
                              }
                            }
                          }
                        } else {
                          await whatsappBusinessService.sendTextMessage(
                            ownerId,
                            phoneNumber,
                            `Olá! Recebemos sua mensagem e vamos te responder em breve. 😊`
                          );
                        }

                        log.info('WhatsApp message processed:', {
                          chatId: chat.id,
                          leadId: lead?.id,
                          messageText: messageText.substring(0, 50)
                        });

                      } catch (error) {
                        log.error('Error processing WhatsApp text message:', error);
                      }
                    }
                  }
                }

                // Handle message status updates
                if (value.statuses) {
                  for (const status of value.statuses) {
                    log.info('WhatsApp message status update:', {
                      messageId: status.id,
                      status: status.status,
                      timestamp: status.timestamp
                    });

                    // TODO: Update message delivery status in database
                  }
                }
              }
            }
          }
        }
      }
    }

    // Always respond with 200 to acknowledge receipt
    res.sendStatus(200);

  } catch (error) {
    log.error('WhatsApp webhook handler error:', error);
    // Still return 200 to avoid Meta retrying
    res.sendStatus(200);
  }
});

export default router;
