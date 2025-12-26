import { supa } from '../lib/supabase.js';
import { log } from '../config/logger.js';
import { env } from '../config/env.js';
import { normalizePhoneNumber } from '../lib/retell.js';
import crypto from 'crypto';

/**
 * WhatsApp Business API Service
 * Handles sending messages and managing WhatsApp Business API integration
 */
class WhatsAppBusinessService {
  constructor() {
    this.apiVersion = 'v24.0';
    this.baseUrl = 'https://graph.facebook.com';
  }

  /**
   * Get WhatsApp Business credentials for a user
   */
  async getWhatsAppCredentials(userId) {
    try {
      const { data: user, error } = await supa
        .from('users')
        .select('whatsapp_phone_id, whatsapp_access_token, whatsapp_phone_number, whatsapp_business_account_id, whatsapp_connected, whatsapp_verified')
        .eq('id', userId)
        .single();

      if (error) {
        throw new Error(`Failed to get WhatsApp credentials: ${error.message}`);
      }

      if (!user.whatsapp_connected) {
        throw new Error('WhatsApp Business not connected for this user');
      }

      if (!user.whatsapp_phone_id || !user.whatsapp_access_token) {
        throw new Error('WhatsApp Business credentials missing');
      }

      return {
        phoneId: user.whatsapp_phone_id,
        accessToken: user.whatsapp_access_token,
        phoneNumber: user.whatsapp_phone_number,
        businessAccountId: user.whatsapp_business_account_id,
        verified: user.whatsapp_verified
      };
    } catch (error) {
      log.error('Error getting WhatsApp credentials:', error);
      throw error;
    }
  }

  /**
   * Send a text message via WhatsApp Business API
   */
  async sendTextMessage(userId, toNumber, message) {
    try {
      const credentials = await this.getWhatsAppCredentials(userId);

      const normalizedPhone = normalizePhoneNumber(toNumber);

      const response = await fetch(
        `${this.baseUrl}/${this.apiVersion}/${credentials.phoneId}/messages`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${credentials.accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: normalizedPhone,
            type: 'text',
            text: {
              preview_url: false,
              body: message
            }
          })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        const errorCode = data.error?.code;
        const errorMessage = data.error?.message || 'Unknown error';
        const errorDetails = data.error?.error_data?.details || '';
        
        log.error('WhatsApp API error details:', {
          code: errorCode,
          message: errorMessage,
          details: errorDetails,
          toNumber: normalizedPhone,
          responseStatus: response.status
        });
        
        // Error 131000 usually means the 24-hour window has closed or recipient issue
        if (errorCode === 131000) {
          throw new Error(`WhatsApp API error: Message failed - the 24-hour messaging window may have closed or recipient cannot receive messages. (${errorMessage})`);
        }
        
        throw new Error(`WhatsApp API error: (${errorCode}) ${errorMessage}`);
      }

      log.info(`WhatsApp message sent successfully to ${normalizedPhone}`, {
        messageId: data.messages?.[0]?.id,
        userId
      });

      return {
        success: true,
        messageId: data.messages?.[0]?.id,
        data
      };

    } catch (error) {
      log.error('Error sending WhatsApp message:', error);
      throw error;
    }
  }

  /**
   * Send a template message via WhatsApp Business API
   */
  async sendTemplateMessage(userId, toNumber, templateName, languageCode = 'en', components = []) {
    try {
      const credentials = await this.getWhatsAppCredentials(userId);

      const normalizedPhone = normalizePhoneNumber(toNumber);

      const response = await fetch(
        `${this.baseUrl}/${this.apiVersion}/${credentials.phoneId}/messages`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${credentials.accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: normalizedPhone,
            type: 'template',
            template: {
              name: templateName,
              language: {
                code: languageCode
              },
              components: components
            }
          })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(`WhatsApp API error: ${data.error?.message || 'Unknown error'}`);
      }

      log.info(`WhatsApp template message sent successfully to ${normalizedPhone}`, {
        messageId: data.messages?.[0]?.id,
        template: templateName,
        userId
      });

      return {
        success: true,
        messageId: data.messages?.[0]?.id,
        data
      };

    } catch (error) {
      log.error('Error sending WhatsApp template message:', error);
      throw error;
    }
  }

  /**
   * Send appointment confirmation via WhatsApp (plain text message)
   */
  async sendAppointmentConfirmation(userId, patientPhone, appointmentDetails) {
    try {
      const { patientName, doctorName, appointmentDate, appointmentTime, location } = appointmentDetails;

      const message = `Hi ${patientName}! 👋\n\nYour appointment is confirmed:\n\n📅 Date: ${appointmentDate}\n⏰ Time: ${appointmentTime}\n👨‍⚕️ Doctor: ${doctorName}\n📍 Location: ${location}\n\nPlease arrive 10 minutes early. If you need to reschedule, please let us know.\n\nSee you soon!`;

      return await this.sendTextMessage(userId, patientPhone, message);

    } catch (error) {
      log.error('Error sending appointment confirmation:', error);
      throw error;
    }
  }

  /**
   * Send appointment confirmation template via WhatsApp with buttons
   * Returns the message ID so it can be stored in the appointment record
   */
  async sendAppointmentConfirmationTemplate(userId, patientPhone, appointmentDetails, appointmentId = null) {
    try {
      const { 
        patientName, 
        doctorName, 
        appointmentDate, 
        appointmentTime, 
        location,
        templateName = 'appointment_confirmation_with_button',
        languageCode = 'pt_BR'
      } = appointmentDetails;

      // Format date and time for template
      const formattedDate = appointmentDate || '';
      const formattedTime = appointmentTime || '';
      const formattedLocation = location || 'Nossa clínica';

      // Send template message with body parameters
      // Template format: 'Perfeito, {{1}}! 🎉\nSua consulta com o(a) {{2}} está confirmada para {{3}} às {{4}}.\nEndereço / link: {{5}}\n\nSe precisar remarcar, é só responder aqui. 😊'
      // {{1}} = patientName, {{2}} = doctorName, {{3}} = date, {{4}} = time, {{5}} = location
      const components = [
        {
          type: 'body',
          parameters: [
            {
              type: 'text',
              text: patientName || 'Cliente'
            },
            {
              type: 'text',
              text: doctorName || 'Médico'
            },
            {
              type: 'text',
              text: formattedDate
            },
            {
              type: 'text',
              text: formattedTime
            },
            {
              type: 'text',
              text: formattedLocation
            }
          ]
        }
      ];

      const result = await this.sendTemplateMessage(
        userId,
        patientPhone,
        templateName,
        languageCode,
        components
      );

      // Store message ID in appointment if appointmentId is provided
      if (appointmentId && result.messageId) {
        try {
          const { supa } = await import('../lib/supabase.js');
          await supa
            .from('appointments')
            .update({ 
              whatsapp_confirmation_message_id: result.messageId,
              confirmation_sent_at: new Date().toISOString()
            })
            .eq('id', appointmentId);
          
          log.info('Stored WhatsApp message ID in appointment:', {
            appointmentId,
            messageId: result.messageId
          });
        } catch (dbError) {
          log.error('Error storing WhatsApp message ID in appointment:', dbError);
          // Don't throw - message was sent successfully
        }
      }

      return result;

    } catch (error) {
      log.error('Error sending appointment confirmation template:', error);
      throw error;
    }
  }

  /**
   * Send appointment reminder via WhatsApp
   */
  async sendAppointmentReminder(userId, patientPhone, reminderDetails) {
    try {
      const { patientName, doctorName, appointmentTime, location } = reminderDetails;

      const message = `Hi ${patientName}! 🔔\n\nReminder: You have an appointment tomorrow with Dr. ${doctorName}\n\n⏰ Time: ${appointmentTime}\n📍 Location: ${location}\n\nWe look forward to seeing you!`;

      return await this.sendTextMessage(userId, patientPhone, message);

    } catch (error) {
      log.error('Error sending appointment reminder:', error);
      throw error;
    }
  }

  /**
   * Send telemedicine meeting link via WhatsApp
   */
  async sendMeetingLink(userId, patientPhone, meetingDetails) {
    try {
      const { patientName, doctorName, meetingLink, appointmentTime } = meetingDetails;

      const message = `Hi ${patientName}! 💻\n\nYour telemedicine appointment with Dr. ${doctorName} is scheduled for ${appointmentTime}\n\n🔗 Join the meeting: ${meetingLink}\n\nPlease join 5 minutes before the scheduled time.\n\nSee you online!`;

      return await this.sendTextMessage(userId, patientPhone, message);

    } catch (error) {
      log.error('Error sending meeting link:', error);
      throw error;
    }
  }

  /**
   * Store WhatsApp Business credentials
   */
  async storeWhatsAppCredentials(userId, credentials) {
    try {
      const { phoneId, accessToken, businessAccountId, phoneNumber, displayPhoneNumber, verified } = credentials;

      // Generate webhook verify token
      const webhookVerifyToken = crypto.randomBytes(32).toString('hex');

      const { data, error } = await supa
        .from('users')
        .update({
          whatsapp_phone_id: phoneId,
          whatsapp_access_token: accessToken,
          whatsapp_business_account_id: businessAccountId,
          whatsapp_phone_number: phoneNumber,
          whatsapp_phone_number_display: displayPhoneNumber || phoneNumber,
          whatsapp_verified: verified || false,
          whatsapp_connected: true,
          whatsapp_connected_at: new Date().toISOString(),
          whatsapp_webhook_verify_token: webhookVerifyToken
        })
        .eq('id', userId)
        .select()
        .single();

      if (error) {
        throw new Error(`Failed to store WhatsApp credentials: ${error.message}`);
      }

      log.info(`WhatsApp Business connected successfully for user ${userId}`, {
        phoneNumber,
        phoneId
      });

      return {
        success: true,
        webhookVerifyToken,
        data
      };

    } catch (error) {
      log.error('Error storing WhatsApp credentials:', error);
      throw error;
    }
  }

  /**
   * Disconnect WhatsApp Business account
   */
  async disconnectWhatsApp(userId) {
    try {
      const { data, error } = await supa
        .from('users')
        .update({
          whatsapp_phone_id: null,
          whatsapp_access_token: null,
          whatsapp_business_account_id: null,
          whatsapp_phone_number: null,
          whatsapp_phone_number_display: null,
          whatsapp_verified: false,
          whatsapp_connected: false,
          whatsapp_connected_at: null,
          whatsapp_webhook_verify_token: null
        })
        .eq('id', userId)
        .select()
        .single();

      if (error) {
        throw new Error(`Failed to disconnect WhatsApp: ${error.message}`);
      }

      log.info(`WhatsApp Business disconnected for user ${userId}`);

      return { success: true, data };

    } catch (error) {
      log.error('Error disconnecting WhatsApp:', error);
      throw error;
    }
  }

  /**
   * Get WhatsApp connection status
   */
  async getConnectionStatus(userId) {
    try {
      const { data: user, error } = await supa
        .from('users')
        .select('whatsapp_connected, whatsapp_verified, whatsapp_phone_number_display, whatsapp_connected_at')
        .eq('id', userId)
        .single();

      if (error) {
        throw new Error(`Failed to get connection status: ${error.message}`);
      }

      return {
        connected: user.whatsapp_connected || false,
        verified: user.whatsapp_verified || false,
        phoneNumber: user.whatsapp_phone_number_display || null,
        connectedAt: user.whatsapp_connected_at || null
      };

    } catch (error) {
      log.error('Error getting WhatsApp connection status:', error);
      throw error;
    }
  }

  /**
   * Create a new WhatsApp message template
   * @param {string} userId - User ID
   * @param {object} templateData - Template configuration
   * @returns {Promise<object>} - Created template details
   */
  async createTemplate(userId, templateData) {
    try {
      const credentials = await this.getWhatsAppCredentials(userId);

      if (!credentials.businessAccountId) {
        throw new Error('WhatsApp Business Account ID not found. Please reconnect your WhatsApp Business account.');
      }

      const {
        name,
        language = 'pt_BR',
        category = 'MARKETING', // MARKETING, UTILITY, AUTHENTICATION
        components = [],
        allowCategoryChange = false
      } = templateData;

      // Validate required fields
      if (!name) {
        throw new Error('Template name is required');
      }

      if (!components || components.length === 0) {
        throw new Error('Template must have at least one component');
      }

      const url = `${this.baseUrl}/${this.apiVersion}/${credentials.businessAccountId}/message_templates`;

      const requestBody = {
        name,
        language,
        category,
        components,
        allow_category_change: allowCategoryChange
      };

      log.info('Creating WhatsApp template:', {
        userId,
        templateName: name,
        language,
        category
      });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${credentials.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      const data = await response.json();

      if (!response.ok) {
        log.error('WhatsApp template creation failed:', {
          error: data.error,
          templateName: name
        });
        throw new Error(`WhatsApp API error: ${data.error?.message || 'Unknown error'} (Code: ${data.error?.code || 'N/A'})`);
      }

      log.info(`WhatsApp template created successfully for user ${userId}`, {
        templateId: data.id,
        templateName: name,
        status: data.status
      });

      return {
        success: true,
        templateId: data.id,
        status: data.status,
        name: name,
        data
      };

    } catch (error) {
      log.error('Error creating WhatsApp template:', error);
      throw error;
    }
  }

  /**
   * Get all WhatsApp message templates
   * @param {string} userId - User ID
   * @param {object} options - Optional query parameters (limit, status, etc.)
   * @returns {Promise<object>} - List of templates
   */
  async getAllTemplates(userId, options = {}) {
    try {
      const credentials = await this.getWhatsAppCredentials(userId);

      if (!credentials.businessAccountId) {
        throw new Error('WhatsApp Business Account ID not found. Please reconnect your WhatsApp Business account.');
      }

      // Build query parameters
      const queryParams = new URLSearchParams();
      if (options.limit) {
        queryParams.append('limit', options.limit.toString());
      }
      if (options.status) {
        queryParams.append('status', options.status); // APPROVED, PENDING, REJECTED
      }
      if (options.name) {
        queryParams.append('name', options.name);
      }
      if (options.language) {
        queryParams.append('language', options.language);
      }

      const queryString = queryParams.toString();
      const url = `${this.baseUrl}/${this.apiVersion}/${credentials.businessAccountId}/message_templates${queryString ? `?${queryString}` : ''}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${credentials.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(`WhatsApp API error: ${data.error?.message || 'Unknown error'}`);
      }

      log.info(`Retrieved WhatsApp templates for user ${userId}`, {
        count: data.data?.length || 0,
        total: data.paging?.total || 0
      });

      return {
        success: true,
        templates: data.data || [],
        paging: data.paging || null,
        total: data.paging?.total || (data.data?.length || 0)
      };

    } catch (error) {
      log.error('Error getting WhatsApp templates:', error);
      throw error;
    }
  }

  /**
   * Delete a WhatsApp message template
   * @param {string} userId - User ID
   * @param {string} templateName - Template name to delete
   * @returns {Promise<object>} - Deletion result
   */
  async deleteTemplate(userId, templateName) {
    try {
      const credentials = await this.getWhatsAppCredentials(userId);

      if (!credentials.businessAccountId) {
        throw new Error('WhatsApp Business Account ID not found. Please reconnect your WhatsApp Business account.');
      }

      const url = `${this.baseUrl}/${this.apiVersion}/${credentials.businessAccountId}/message_templates?name=${encodeURIComponent(templateName)}`;

      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${credentials.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(`WhatsApp API error: ${data.error?.message || 'Unknown error'}`);
      }

      log.info(`WhatsApp template deleted successfully for user ${userId}`, {
        templateName
      });

      return {
        success: true,
        data
      };

    } catch (error) {
      log.error('Error deleting WhatsApp template:', error);
      throw error;
    }
  }

  /**
   * Verify webhook signature from Meta
   */
  verifyWebhookSignature(signature, body, appSecret) {
    const expectedSignature = crypto
      .createHmac('sha256', appSecret)
      .update(body)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(`sha256=${expectedSignature}`)
    );
  }
}

export const whatsappBusinessService = new WhatsAppBusinessService();

