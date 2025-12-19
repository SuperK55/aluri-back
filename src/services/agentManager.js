
import { supa } from '../lib/supabase.js';
import { retellCreatePhoneCall } from '../lib/retell.js';
import { Retell } from 'retell-sdk';
import { env } from '../config/env.js';
import { log } from '../config/logger.js';
import { pickDoctorForLead } from './doctors.js';
import { getServiceTerminology } from '../config/serviceConfig.js';
import { 
  createTwilioSubAccount, 
  purchasePhoneNumber, 
  registerPhoneNumberWithRetell 
} from './twilioService.js';
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';

const retellClient = new Retell({ apiKey: env.RETELL_API_KEY });

/**
 * Normalize date string to YYYY-MM-DD format
 * Handles both YYYY-MM-DD and MM/DD/YYYY formats
 * @param {string} dateStr - Date string in any format
 * @returns {string} - Date string in YYYY-MM-DD format
 */
function normalizeDateString(dateStr) {
  if (!dateStr) return dateStr;
  // If already in YYYY-MM-DD format, return as is
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }
  // If in MM/DD/YYYY format, convert to YYYY-MM-DD
  if (dateStr.includes('/')) {
    const parts = dateStr.split('/');
    if (parts.length === 3) {
      const [month, day, year] = parts;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
  }
  return dateStr;
}

/**
 * Get date string in YYYY-MM-DD format for a given date in a specific timezone
 * @param {Date} date - The date object
 * @param {string} timezone - The timezone (default: 'America/Sao_Paulo')
 * @returns {string} - Date string in YYYY-MM-DD format
 */
function getDateStringInTimezone(date, timezone = 'America/Sao_Paulo') {
  // Use Intl.DateTimeFormat to get date components in the specified timezone
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const formatted = formatter.format(date);
  // en-CA locale should return YYYY-MM-DD, but let's ensure it's correct
  // If it doesn't match, extract parts manually
  if (/^\d{4}-\d{2}-\d{2}$/.test(formatted)) {
    return formatted;
  }
  // Fallback: extract parts manually
  const parts = formatter.formatToParts(date);
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value.padStart(2, '0');
  const day = parts.find(p => p.type === 'day').value.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format date and time in humanized Portuguese format
 * Example: "14 de dezembro às 9 horas" or "22 de janeiro de 2025 às 14 horas"
 * @param {Date} date - The date to format (should be in UTC or ISO format)
 * @param {boolean} includeYear - Whether to include the year in the output
 * @param {string} timezone - The timezone to use for formatting (default: 'America/Sao_Paulo')
 */
function formatHumanizedDateTime(date, includeYear = false, timezone = 'America/Sao_Paulo') {
  const monthNames = [
    'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
  ];
  
  // Get all date and time components in the specified timezone using Intl.DateTimeFormat
  const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });
  
  const parts = dateTimeFormatter.formatToParts(date);
  const day = parseInt(parts.find(part => part.type === 'day').value);
  const month = parseInt(parts.find(part => part.type === 'month').value);
  const year = parseInt(parts.find(part => part.type === 'year').value);
  const hour = parseInt(parts.find(part => part.type === 'hour').value);
  const minutes = parseInt(parts.find(part => part.type === 'minute').value);
  
  // Format hour (use "horas" for full hours, or include minutes)
  let timeStr = '';
  if (minutes === 0) {
    timeStr = `${hour} horas`;
  } else {
    timeStr = `${hour}h${minutes.toString().padStart(2, '0')}`;
  }
  
  // Build date string
  let dateStr = `${day} de ${monthNames[month - 1]}`;
  if (includeYear) {
    dateStr += ` de ${year}`;
  }
  
  return `${dateStr} às ${timeStr}`;
}

class AgentManager {
  /**
   * Create a new agent for a business owner (independent of doctors)
   */
  async createAgentForOwner(ownerId, agentData = {}) {
    try {
      // Get owner details including service_type
      const { data: owner, error: ownerError } = await supa
        .from('users')
        .select('id, name, twilio_phone_number, service_type')
        .eq('id', ownerId)
        .single();

      if (ownerError || !owner) {
        throw new Error('Business owner not found');
      }

      // Get service-specific terminology
      const serviceType = owner.service_type || 'clinic';
      const terminology = getServiceTerminology(serviceType);

      const {
        agent_name,
        voice_tone = 'caloroso',
        script_style = 'persuasivo',
        channel = 'voice', // Default to voice for backward compatibility
      } = agentData;

      // Validation
      if (!agent_name) {
        throw new Error('Agent name is required');
      }

      if (!['voice', 'chat'].includes(channel)) {
        throw new Error('Invalid channel. Must be "voice" or "chat"');
      }

      // Validate script_style: beauty clinics cannot use 'copy' style
      if (serviceType === 'beauty_clinic' && script_style === 'copy') {
        throw new Error('Copy script style is not available for beauty clinic agents');
      }

      // Load templates based on service type and channel
      const agentTemplate = await this.loadAgentTemplate(serviceType, channel);
      const conversationFlowTemplate = await this.loadConversationFlowTemplate(serviceType, channel);

      // Generate agent configuration
      const agentConfigOptions = {
        agent_name,
        language: 'pt-BR',
        phone_number: owner.twilio_phone_number,
        service_type: serviceType,
        channel: channel,
        ...agentData
      };

      // Add channel-specific defaults
      if (channel === 'voice') {
        agentConfigOptions.voice_id = '11labs-Jenny';
        agentConfigOptions.ambient_sound = 'coffee-shop';
      }

      const agentConfig = await this.generateAgentConfig(owner, agentTemplate, agentConfigOptions);

      const conversationFlow = await this.generateConversationFlow(owner, conversationFlowTemplate, {
        service_type: serviceType,
        // Inject service-specific terminology
        resource_type: terminology.resource.singular,
        resource_type_plural: terminology.resource.plural,
        client_type: terminology.client.singular,
        client_type_plural: terminology.client.plural,
        meeting_type: terminology.meeting.singular,
        meeting_type_plural: terminology.meeting.plural,
        // Inject service-specific function URLs
        recommend_function_url: `${env.APP_BASE_URL}/fn/recommend_${serviceType === 'beauty_clinic' ? 'treatment' : 'doctor'}`
      });

      // Create conversation flow in Retell
      const conversationFlowResponse = await retellClient.conversationFlow.create(conversationFlow);
      
      // Update agent config with conversation flow ID
      agentConfig.response_engine.conversation_flow_id = conversationFlowResponse.conversation_flow_id;

      // Create agent in Retell
      const agentResponse = await retellClient.agent.create(agentConfig);

      // // Publish the agent to make it available for calls
      // try {
      //   await retellClient.agent.publish(agentResponse.agent_id);
      //   log.info(`Retell agent published: ${agentResponse.agent_id}`);
      // } catch (publishError) {
      //   log.error('Error publishing Retell agent:', publishError);
      //   // Continue even if publish fails - agent might already be published
      // }

      // Save to database (without Twilio configuration - that's Step 2)
      const insertData = {
          owner_id: ownerId,
          agent_name: agent_name.trim(),
          voice_tone,
          script_style,
          service_type: serviceType,
        channel: channel,
          retell_agent_id: agentResponse.agent_id,
          conversation_flow_id: conversationFlowResponse.conversation_flow_id,
          language: 'pt-BR',
          custom_variables: {},
          is_active: true,
          is_published: true
      };

      // Add channel-specific fields
      if (channel === 'voice') {
        insertData.voice_id = '11labs-Jenny';
        insertData.ambient_sound = 'coffee-shop';
      }

      const { data: dbAgent, error: dbError } = await supa
        .from('agents')
        .insert(insertData)
        .select()
        .single();

      if (dbError) {
        throw new Error(`Database error: ${dbError.message}`);
      }

      let chatAgent = null;
      if (channel === 'voice' && !agentData.skipChatAgentCreation) {
        try {
          log.info(`Auto-creating WhatsApp chat agent for voice agent: ${agent_name}`);
          
          // Load chat templates
          const chatAgentTemplate = await this.loadAgentTemplate(serviceType, 'chat');
          const chatConversationFlowTemplate = await this.loadConversationFlowTemplate(serviceType, 'chat');

          // Generate chat agent configuration
          const chatAgentConfigOptions = {
            language: 'pt-BR',
            phone_number: owner.twilio_phone_number,
            service_type: serviceType,
            channel: 'chat',
            voice_tone,
            script_style,
            skipChatAgentCreation: true // Prevent recursion
          };

          const chatAgentConfig = await this.generateAgentConfig(owner, chatAgentTemplate, chatAgentConfigOptions);
          const chatConversationFlow = await this.generateConversationFlow(owner, chatConversationFlowTemplate, {
            service_type: serviceType,
            resource_type: terminology.resource.singular,
            resource_type_plural: terminology.resource.plural,
            client_type: terminology.client.singular,
            client_type_plural: terminology.client.plural,
            meeting_type: terminology.meeting.singular,
            meeting_type_plural: terminology.meeting.plural,
            recommend_function_url: `${env.APP_BASE_URL}/fn/recommend_${serviceType === 'beauty_clinic' ? 'treatment' : 'doctor'}`
          });

          // Create chat conversation flow in Retell
          const chatConversationFlowResponse = await retellClient.conversationFlow.create(chatConversationFlow);
          chatAgentConfig.response_engine.conversation_flow_id = chatConversationFlowResponse.conversation_flow_id;

          // Prepare chat agent config for API call
          // Remove channel field as it's not needed for chat agent creation endpoint
          const { channel, ...chatAgentPayload } = chatAgentConfig;
          
          log.info('Creating WhatsApp chat agent in Retell');

          // Create chat agent in Retell using direct HTTP API call
          // The SDK doesn't support chatAgent.create(), so we use the REST API directly
          let chatAgentResponse;
          try {
            const response = await axios.post(
              'https://api.retellai.com/create-chat-agent',
              chatAgentPayload,
              {
                headers: {
                  'Authorization': `Bearer ${env.RETELL_API_KEY}`,
                  'Content-Type': 'application/json'
                }
              }
            );
            chatAgentResponse = response.data;
            log.info(`Chat agent created successfully in Retell: ${chatAgentResponse.agent_id}`);
          } catch (error) {
            log.error('Error creating chat agent in Retell:', error.response?.data || error.message);
            throw new Error(`Failed to create chat agent in Retell: ${error.response?.data?.message || error.message}`);
          }

          // Save chat agent to database
          const { data: dbChatAgent, error: dbChatError } = await supa
            .from('agents')
            .insert({
              owner_id: ownerId,
              agent_name: agent_name,
              voice_tone,
              script_style,
              service_type: serviceType,
              channel: 'chat',
              retell_agent_id: chatAgentResponse.agent_id,
              conversation_flow_id: chatConversationFlowResponse.conversation_flow_id,
              language: 'pt-BR',
              custom_variables: {},
              is_active: true,
              is_published: true
            })
            .select()
            .single();

          if (dbChatError) {
            throw new Error(`Database error creating chat agent: ${dbChatError.message}`);
          }

          chatAgent = dbChatAgent;
          log.info(`Successfully created WhatsApp chat agent: ${chatAgent.id}`);
        } catch (chatAgentError) {
          log.error('Error auto-creating WhatsApp chat agent:', chatAgentError);
          // Don't fail the voice agent creation if chat agent creation fails
          // Just log the error and continue
        }
      }

      // Set as default agent if owner doesn't have one
      const { data: currentUser } = await supa
        .from('users')
        .select('default_agent_id')
        .eq('id', ownerId)
        .single();

      if (!currentUser?.default_agent_id) {
        await supa
          .from('users')
          .update({ default_agent_id: dbAgent.id })
          .eq('id', ownerId);
      }

      log.info(`Created agent ${dbAgent.id} for owner ${ownerId} (${owner.name})${dbAgent.phone_number ? ` with phone number ${dbAgent.phone_number}` : ''}`);
      
      // Return voice agent with chat agent info if it was created
      return {
        voiceAgent: dbAgent,
        chatAgent: chatAgent || null
      };

    } catch (error) {
      log.error('Error creating agent:', error);
      throw error;
    }
  }

  /**
   * Find the best resource (doctor/treatment) and agent for a lead based on owner's selection and service type
   */
  async findDoctorAndAgentForLead(lead) {
    try {
      // Get owner's service type
      const { data: owner, error: ownerError } = await supa
        .from('users')
        .select('service_type')
        .eq('id', lead.owner_id)
        .single();

      if (ownerError) {
        log.error('Error fetching owner for service type:', ownerError);
        throw new Error('Could not determine service type for lead');
      }

      const serviceType = owner?.service_type;
      let selectedResource = null;

      // Select resource based on service type
      if (serviceType === 'beauty_clinic') {
        // For beauty clinics, find a treatment
        const { data: treatments, error: treatmentError } = await supa
          .from('treatments')
          .select('*')
          .eq('owner_id', lead.owner_id)
          .eq('treatment_name', lead.specialty)
          .eq('is_active', true)
          .limit(1);

        if (treatmentError) {
          log.error('Error fetching treatments:', treatmentError);
          throw new Error('Error finding treatments for this lead');
        }

        if (!treatments || treatments.length === 0) {
          throw new Error('No available treatments found for this lead. Please create at least one treatment first.');
        }

        selectedResource = treatments[0];
        log.info(`Selected treatment for lead: ${selectedResource.name}`);
      } else {
        // For medical clinics, find a doctor
        const selectedDoctor = await pickDoctorForLead({
          specialty: lead.specialty,
          city: lead.city,
          language: lead.preferred_language,
          need: lead.reason
        }, lead.owner_id);

        if (!selectedDoctor) {
          throw new Error('No available doctor found for this lead. Please create at least one doctor first.');
        }

        selectedResource = selectedDoctor;
        log.info(`Selected doctor for lead: ${selectedResource.name}`);
      }

      // Get owner's selected agent (use default or find suitable agent)
      let selectedAgent = {};

      const { data: ownerData, error: ownerDataError } = await supa
          .from('users')
          .select(`
            default_agent_id,
            agents(*)
          `)
          .eq('id', lead.owner_id)
          .single();

        if (!ownerDataError && ownerData?.agents?.is_active) {
          selectedAgent = ownerData.agents;
        } else {
          // Find any active agent for this owner
          const { data: ownerAgents, error: agentError } = await supa
            .from('agents')
            .select('*')
            .eq('owner_id', lead.owner_id)
            .eq('is_active', true)
            .limit(1);

          if (!agentError && ownerAgents?.length > 0) {
            selectedAgent = ownerAgents[0];
          }
        }

      log.info(`Selected agent for lead: ${selectedAgent.agent_name} (${selectedAgent.id})`);

      return {
        doctor: selectedResource, // Keep property name for backward compatibility, but now it's a generic resource
        agent: selectedAgent
      };

    } catch (error) {
      log.error('Error finding doctor/agent for lead:', error);
      throw error;
    }
  }

  /**
   * Update lead with resource (doctor/treatment) and agent assignment
   */
  async assignDoctorAndAgentToLead(leadId, doctor, agent) {
    try {
      // Get owner information for business details and service type
      const { data: owner, error: ownerError } = await supa
        .from('users')
        .select('name, specialty, social_proof_enabled, social_proof_text, service_type')
        .eq('id', agent.owner_id)
        .single();

      if (ownerError) {
        log.warn('Could not fetch owner information:', ownerError);
      }

      const serviceType = owner?.service_type || agent.service_type || 'clinic';
      const { call_status: callStatus, error: leadError } = await supa
        .from('leads')
        .select('status')
        .eq('id', leadId)
        .single();
      if (leadError) {
        log.warn('Could not fetch lead information:', leadError);
      }


      // Common variables for all service types
      const commonVariables = {
        agent_name: String(agent.agent_name || ''),
        agent_id: String(agent.id || ''),
        service_type: String(serviceType || ''),
        owner_id: String(agent.owner_id || ''),
        webhook_base_url: String(env.APP_BASE_URL || ''),
        business_name: String(owner?.name || ''),
        social_proof: owner?.social_proof_enabled ? `${owner?.social_proof_text}` : '',
        return_policy_days: String(doctor.return_policy_days || 30),
        cancellation_policy_days: String(doctor.return_policy_days || 30),
        // paymentlink_global_prompt: 'Offer to the user receiving confirmation via Whatsapp.',
        // paymentlink_global_prompt_close: '',
        // paymentlink: 'Ótimo, seu horário para {{initial_appointment_date}} já está reservado. Enviarei a confirmação por WhatsApp agora mesmo.',
        ...(agent.custom_variables ? Object.fromEntries(
          Object.entries(agent.custom_variables).map(([key, value]) => [
            key, 
            value !== null && value !== undefined ? String(value) : ''
          ])
        ) : {})
      };

      // Add available_time - different logic for 'copy' vs other script styles
      let availableTimeMessage = '';
      let suggestedDate = null; // Store suggested date for 'copy' style comparison
      let suggestedDateISO = null; // ISO format for comparison in conversation flow
      
      if (agent.script_style === 'copy' && callStatus !== 'available_time') {
        try {
          const now = new Date();
          const oneMonthLater = new Date(now);
          oneMonthLater.setMonth(oneMonthLater.getMonth() + 1);
          
          // Set to a reasonable time (e.g., 9 AM)
          oneMonthLater.setHours(9, 0, 0, 0);
          
          // Get doctor's working hours and availability to check if suggested date is available
          let workingHours = {};
          let dateSpecificAvailability = [];
          let resourceId = null;
          let resourceType = 'doctor';
          
          if (serviceType === 'beauty_clinic') {
            // For beauty clinics, use owner's working hours
            const { data: ownerData } = await supa
              .from('users')
              .select('id, working_hours, date_specific_availability')
              .eq('id', owner.id)
              .single();
            
            workingHours = ownerData?.working_hours || {};
            dateSpecificAvailability = ownerData?.date_specific_availability || [];
            resourceId = owner.id;
            resourceType = 'user';
          } else {
            // Medical clinic: use doctor's working hours
            // Fetch latest doctor data to ensure we have date_specific_availability
            const { data: latestDoctor } = await supa
              .from('doctors')
              .select('working_hours, date_specific_availability')
              .eq('id', doctor.id)
              .single();
            
            workingHours = latestDoctor?.working_hours || doctor.working_hours || {};
            dateSpecificAvailability = latestDoctor?.date_specific_availability || doctor.date_specific_availability || [];
            resourceId = doctor.id;
            resourceType = 'doctor';
            
            log.debug(`Doctor ${doctor.id} date_specific_availability (copy style):`, JSON.stringify(dateSpecificAvailability));
          }
          
          // Find the nearest available date starting from the calculated date (one month later)
          // This will return the calculated date if available, or the nearest available date if not
          const targetDate = await this.findNextAvailableSlot(
            workingHours,
            dateSpecificAvailability,
            oneMonthLater, // Start checking from the calculated date
            resourceId,
            resourceType
          );
          
          // Get the date string for the target date (YYYY-MM-DD) in São Paulo timezone
          const targetDateString = getDateStringInTimezone(targetDate, 'America/Sao_Paulo');
          suggestedDate = targetDate;
          suggestedDateISO = targetDateString;
          
          // Get ALL available slots for this specific date
          const slotsForTargetDate = await this.findAvailableSlotsForDate(
            workingHours,
            dateSpecificAvailability,
            targetDateString,
            resourceId,
            resourceType
          );
          
          // Check if the slot is in a different year
          const currentYear = now.getFullYear();
          const slotYear = targetDate.getFullYear();
          const includeYear = slotYear !== currentYear;
          
          // Format all available slots for this date
          if (slotsForTargetDate && slotsForTargetDate.length > 0) {
            const formattedSlots = slotsForTargetDate.map(slot => {
              return formatHumanizedDateTime(slot, includeYear);
            });
            
            // Get the date part (without time) for the message
            const dateOnly = formatHumanizedDateTime(targetDate, includeYear).split(' às ')[0];
          
            // Present all available slots on that date
            if (formattedSlots.length === 1) {
              availableTimeMessage = `Encontrei um horário disponível para você no dia ${formattedSlots[0]}. Posso confirmar esse horário para você?`;
            } else {
              availableTimeMessage = `Encontrei horários disponíveis para você no dia ${dateOnly}: ${formattedSlots.join(', ')}. Qual desses horários funciona melhor para você?`;
            }
          } else {
            // Fallback if no slots found for that date (shouldn't happen, but just in case)
            const humanizedDateTime = formatHumanizedDateTime(targetDate, includeYear);
          availableTimeMessage = `Encontrei um horário disponível para você no dia ${humanizedDateTime}. Posso confirmar esse horário para você?`;
          }
        } catch (error) {
          log.warn('Could not calculate suggested date for copy style:', error);
          // Fallback: calculate date without availability check
          try {
            const now = new Date();
            const oneMonthLater = new Date(now);
            oneMonthLater.setMonth(oneMonthLater.getMonth() + 1);
            oneMonthLater.setHours(9, 0, 0, 0);
            suggestedDate = oneMonthLater;
            suggestedDateISO = oneMonthLater.toISOString().split('T')[0];
          } catch (fallbackError) {
            log.error('Fallback date calculation also failed:', fallbackError);
          }
          availableTimeMessage = 'Estamos com horários disponíveis nas próximas semanas. Posso agendar para a melhor data que funcionar para você.';
        }
      } else {
        // For other script styles: use real availability
        try {
          // For beauty clinics, working hours are stored at the owner level
          let workingHours, dateSpecificAvailability, resourceId, resourceType;
          
          if (serviceType === 'beauty_clinic') {
            // Get owner's working hours (shared across all treatments)
            const { data: ownerData } = await supa
              .from('users')
              .select('id, working_hours, date_specific_availability, timezone')
              .eq('id', owner.id)
              .single();
            
            workingHours = ownerData?.working_hours || {};
            dateSpecificAvailability = ownerData?.date_specific_availability || [];
            resourceId = owner.id;
            resourceType = 'user';
          } else {
            // Medical clinic: use doctor's working hours
            // Fetch latest doctor data to ensure we have date_specific_availability
            const { data: latestDoctor } = await supa
              .from('doctors')
              .select('working_hours, date_specific_availability')
              .eq('id', doctor.id)
              .single();
            
            workingHours = latestDoctor?.working_hours || doctor.working_hours || {};
            dateSpecificAvailability = latestDoctor?.date_specific_availability || doctor.date_specific_availability || [];
            resourceId = doctor.id;
            resourceType = 'doctor';
            
            log.debug(`Doctor ${doctor.id} date_specific_availability:`, JSON.stringify(dateSpecificAvailability));
          }
          
          // Calculate next available slot from the resource object
          const nextSlot = await this.findNextAvailableSlot(
            workingHours, 
            dateSpecificAvailability, 
            new Date(), 
            resourceId,
            resourceType
          );
          
          // Check if the slot is in a different year
          const currentYear = new Date().getFullYear();
          const slotYear = nextSlot.getFullYear();
          const includeYear = slotYear !== currentYear;
          
          // Format in humanized Portuguese (e.g., "14 de dezembro às 9 horas")
          const humanizedDateTime = formatHumanizedDateTime(nextSlot, includeYear);
          
          // Persuasive and Rapport styles: use natural language
          availableTimeMessage = `Encontrei um horário disponível para você no dia ${humanizedDateTime}. Posso confirmar esse horário ou verificar outras opções que funcionem melhor para você.`;
        } catch (error) {
          log.warn('Could not fetch real availability, using generic message:', error);
          availableTimeMessage = 'Estamos com horários disponíveis nas próximas semanas. Posso agendar para a melhor data que funcionar para você.';
        }
      }

      // Fetch multiple available slots for real-time presentation (for ALL script styles)
      let availableSlots = [];
      let availableSlotsFormatted = '';
      
      try {
        let workingHours, dateSpecificAvailability, resourceId, resourceType;

        if (serviceType === 'beauty_clinic') {
          const { data: ownerData } = await supa
            .from('users')
            .select('working_hours, date_specific_availability')
            .eq('id', owner.id)
            .single();
          
          workingHours = ownerData?.working_hours || {};
          dateSpecificAvailability = ownerData?.date_specific_availability || [];
          resourceId = owner.id;
          resourceType = 'user';
        } else {
          // Medical clinic: fetch latest doctor data to ensure we have date_specific_availability
          const { data: latestDoctor } = await supa
            .from('doctors')
            .select('working_hours, date_specific_availability')
            .eq('id', doctor.id)
            .single();
          
          workingHours = latestDoctor?.working_hours || doctor.working_hours || {};
          dateSpecificAvailability = latestDoctor?.date_specific_availability || doctor.date_specific_availability || [];
          resourceId = doctor.id;
          resourceType = 'doctor';
          
          log.debug(`Doctor ${doctor.id} date_specific_availability for availableSlots:`, JSON.stringify(dateSpecificAvailability));
        }

        // Fetch up to 5 available slots
        availableSlots = await this.findAvailableSlots(
          workingHours,
          dateSpecificAvailability,
          new Date(),
          resourceId,
          resourceType,
          5 // maxSlots
        );

        // Format slots in humanized Portuguese format
        if (availableSlots && availableSlots.length > 0) {
          const currentYear = new Date().getFullYear();
          const formatted = availableSlots.map((slot) => {
            const slotYear = slot.getFullYear();
            const includeYear = slotYear !== currentYear;
            return formatHumanizedDateTime(slot, includeYear);
          });

          availableSlotsFormatted = formatted.join(', ');
        }
      } catch (error) {
        log.warn('Could not fetch multiple available slots:', error);
      }

      // Fetch all services (doctors or treatments) for the clinic
      let otherServicesText = '';
      try {
        if (serviceType === 'beauty_clinic') {
          // Fetch all treatments for beauty clinic
          const { data: allTreatments } = await supa
            .from('treatments')
            .select('id, treatment_name, primary_benefit')
            .eq('owner_id', agent.owner_id)
            .eq('is_active', true);
          
          if (allTreatments && allTreatments.length > 0) {
            const treatmentList = allTreatments
              .filter(t => t.id !== doctor.id) // Exclude current treatment
              .map(t => `${t.treatment_name}${t.primary_benefit ? ` (${t.primary_benefit})` : ''}`)
              .join(', ');
            otherServicesText = treatmentList || '';
          }
        } else {
          // Fetch all doctors for medical clinic
          const { data: allDoctors } = await supa
            .from('doctors')
            .select('id, name, specialty')
            .eq('owner_id', agent.owner_id)
            .eq('is_active', true);
          
          if (allDoctors && allDoctors.length > 0) {
            const doctorList = allDoctors
              .filter(d => d.id !== doctor.id) // Exclude current doctor
              .map(d => `${d.specialty ? ` - ${d.specialty}` : ''}`)
              .join(', ');
            otherServicesText = doctorList || '';
          }
        }
      } catch (error) {
        log.warn('Could not fetch other services:', error);
        otherServicesText = '';
      }

      // Generate service-specific variables
      let agentVariables = { 
        ...commonVariables, 
        available_time: availableTimeMessage,
        // Add multiple slots for the agent to present naturally
        available_slots: availableSlotsFormatted || availableTimeMessage,
        has_multiple_slots: availableSlots.length > 1 ? 'true' : 'false',
        // Add suggested_date for 'copy' script style comparison
        ...(suggestedDateISO ? { suggested_date: suggestedDateISO } : {}),
        // Add current_year for date extraction context
        current_year: String(new Date().getFullYear()),
        // Add other available services
        other_services: otherServicesText
      };

      if (serviceType === 'beauty_clinic') {
        // Beauty clinic: treatment-specific variables
        agentVariables = {
          ...agentVariables,
          treatment_id: String(doctor.id || ''),
          treatment_initial_id: String(doctor.id || ''),
          treatment_name: String(doctor.treatment_name || ''), // 'doctor' param is actually 'treatment' for beauty clinic
          treatment_price: doctor.single_session_price? `R$ ${doctor.single_session_price.toFixed(2).replace('.', ',')}` : 'Consulte',
          session_duration: String(doctor.session_duration || 60) + ' minutos',
          recommended_sessions: String(doctor.recommended_sessions || 1),
          interval_between_sessions: String(doctor.interval_between_sessions || '7 days'),
          package_offer: doctor.package_sessions_count ? `Ofereço um pacote de {{doctor.package_sessions_count}} sessões por {{doctor.package_price}}.` : '',
          treatment_effects: doctor.treatment_effects,
          pain_point_1: doctor.pain_point_1,
          pain_point_2: doctor.pain_point_2,
          pain_point_3: doctor.pain_point_3,
          treatment_result: doctor.treatment_result,
          client_feedback: doctor.client_feedback,
          treatment_benefit: doctor.treatment_benefit,
          script_style: agent.script_style,
          pronoun : String(doctor.is_female ? 'Ela' : 'Ele'),
          
          script_availability: availableTimeMessage,
          // Payment methods for beauty clinic
          payment_methods: (() => {
            const installments = doctor.installment_options;
            const hasDiscount = doctor.pix_discount_percentage && doctor.pix_discount_percentage > 0;
            
            let sentence = '';
            
            // Build the payment options sentence
            if (hasDiscount) {
              // If both credit card and discount are available
              sentence = `Hoje, o preço é de {{single_session_price}} por sessão, e você pode pagar em até {{installment_options}}, ou com {{pix_discount_percentage}}.`;
            } else {
              // Only credit card
              sentence = `Hoje, o preço é de {{single_session_price}} por sessão, e você pode pagar em até {{installment_options}}.`;
            }
            
            return sentence;
          })()
        };
      } else {
        // Medical clinic: doctor-specific variables
        agentVariables = {
          ...agentVariables,
          doctor_name: String(doctor.name || ''),
          doctor_id: String(doctor.id || ''),
          doctor_initial_id: String(doctor.id || ''),
          doctor_specialty: String(doctor.specialty || ''),
          doctor_bio: String(doctor.bio || `Especialista em ${doctor.specialty}`),
          doctor_languages: 'Português', // Default language
          consultation_price: doctor.consultation_price ? `R$ ${doctor.consultation_price}` : 'Consulte',
          return_consultation_price: doctor.return_consultation_price ? `R$ ${doctor.return_consultation_price}` : 'Consulte',
          consultation_duration: String(doctor.consultation_duration || 90),
          telemedicine_available: doctor.telemedicine_available ? 'Sim' : 'Não',
          doctor_address: String(doctor.office_address || ''),
          doctor_city: String(doctor.city || ''),
          doctor_tags: String(doctor.tags?.join(', ') || ''),
          return_policy: parseInt(doctor.return_policy_days) === 0 ? 'O valor da consulta é {{consultation_price}}.' : `O valor da consulta é {{consultation_price}}, e inclui um retorno gratuito dentro de {{return_policy_days}} dias.`,
          script_availability: availableTimeMessage,
          pronoun : String(doctor.is_female ? 'Ela' : 'Ele'),
          script_style: agent.script_style,
          has_multiple_slots: availableSlots.length > 1 ? 'true' : 'false',
          available_slots: availableSlotsFormatted || availableTimeMessage,
          // Payment methods for medical clinic
          payment_methods: (() => {
            const installments = doctor.payment_methods?.credit_card_installments || 4;
            const reimbursementEnabled = doctor.reimbursement_invoice_enabled || false;
            
            let text = '';
            
            // Reimbursement message (more natural phrasing)
            if (reimbursementEnabled) {
              text += 'E se precisar, nós podemos emitir uma nota fiscal para reembolso do  seu plano de saúde.';
            }
            
            // Build the payment options sentence (improved structure)

            
            if (doctor.discount_percentage_pix > 0) {
              text += `O pagamento pode ser feito no cartão em até ${installments} vezes ou integralmente via PIX, o que for mais conveniente para você. Se optar pelo PIX, você ganha um desconto de ${doctor.discount_percentage_pix}%.`;
            } else {
              text += `O pagamento pode ser feito no cartão em até ${installments} vezes.`;
            }
            
            return text;
          })(),
        };
      }
      

      // Map serviceType to resource type for database constraint
      // serviceType: 'clinic' -> resourceType: 'doctor'
      // serviceType: 'beauty_clinic' -> resourceType: 'treatment'
      const resourceType = serviceType === 'beauty_clinic' ? 'treatment' : 'doctor';

      // Update lead with assignment (use appropriate column based on service type)
      const updateData = {
        assigned_resource_type: resourceType,
        assigned_resource_id: doctor.id,
        assigned_agent_id: agent.id,
        agent_variables: agentVariables
      };
      
      const { data: updatedLead, error } = await supa
        .from('leads')
        .update(updateData)
        .eq('id', leadId)
        .select()
        .single();

      if (error) {
        throw new Error(`Lead update error: ${error.message}`);
      }

      log.info(`Lead ${leadId} assigned to ${serviceType === 'beauty_clinic' ? 'treatment' : 'doctor'}: ${doctor.name}`);

      return updatedLead;

    } catch (error) {
      log.error('Error assigning doctor/agent to lead:', error);
      throw error;
    }
  }

  /**
   * Get next available appointment slot based on service type and agent settings
   */
  async getNextAvailableSlot(agent, lead) {
    const now = new Date();

    // If agent uses scarcity method, return 1 month from now
    if (!agent.use_real_availability) {
      const scarcityDate = new Date(now);
      scarcityDate.setMonth(scarcityDate.getMonth() + 1);
      return scarcityDate;
    }

    // Otherwise, fetch real availability based on service type
    const serviceType = agent.service_type || 'clinic';

    try {
      if (serviceType === 'beauty_clinic') {
        // For beauty clinics, working hours are at the owner level (users table)
        // All treatments share the same working hours
        const { data: owner, error } = await supa
          .from('users')
          .select('working_hours, date_specific_availability, timezone')
          .eq('id', lead.owner_id)
          .single();

        if (error || !owner) {
          log.warn('Could not fetch owner availability for beauty clinic, falling back to scarcity method');
          const fallbackDate = new Date(now);
          fallbackDate.setMonth(fallbackDate.getMonth() + 1);
          return fallbackDate;
        }

        return await this.findNextAvailableSlot(
          owner.working_hours || {}, 
          owner.date_specific_availability || [], 
          now, 
          lead.owner_id, // owner ID
          'user' // resource type is 'user' for beauty clinic
        );

      } else {
        // Get availability from doctors table (clinic service type)
        const { data: doctor, error } = await supa
          .from('doctors')
          .select('working_hours, date_specific_availability, timezone')
          .eq('id', lead.assigned_doctor_id)
          .eq('is_active', true)
          .single();

        if (error || !doctor) {
          log.warn('Could not fetch doctor availability, falling back to scarcity method');
          const fallbackDate = new Date(now);
          fallbackDate.setMonth(fallbackDate.getMonth() + 1);
          return fallbackDate;
        }

        return await this.findNextAvailableSlot(
          doctor.working_hours, 
          doctor.date_specific_availability, 
          now, 
          lead.assigned_doctor_id, // doctor ID
          'doctor'
        );
      }
    } catch (error) {
      log.error('Error fetching availability:', error);
      // Fallback to scarcity method on error
      const fallbackDate = new Date(now);
      fallbackDate.setMonth(fallbackDate.getMonth() + 1);
      return fallbackDate;
    }
  }

  /**
   * Find multiple available slots (up to maxSlots) from working hours, specific availability, and existing appointments
   */
  async findAvailableSlots(workingHours, dateSpecificAvailability, fromDate, resourceId, resourceType = 'doctor', maxSlots = 5) {
    const slots = [];
    const now = new Date(new Date(fromDate).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const maxDaysToCheck = 60; // Check up to 60 days ahead to find enough slots
    // #region agent log
    fetch('http://localhost:7243/ingest/fa704248-e3dd-4b0a-ab9f-643803e5688c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'agentManager.js:findAvailableSlots:entry',message:'findAvailableSlots called',data:{fromDate:fromDate?.toISOString?.() || fromDate,nowParsed:now.toISOString(),resourceId,resourceType,maxSlots},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
    // #endregion
    
    // Parse date-specific unavailability
    const unavailableDates = new Set();
    if (dateSpecificAvailability && Array.isArray(dateSpecificAvailability)) {
      dateSpecificAvailability.forEach(item => {
        if (item.type === 'unavailable' && item.date) {
          // Normalize date to YYYY-MM-DD format
          const normalizedDate = normalizeDateString(item.date);
          unavailableDates.add(normalizedDate);
          log.debug(`Marked date as unavailable: ${normalizedDate} (original: ${item.date})`);
        }
      });
    }
    
    log.debug(`Unavailable dates: ${Array.from(unavailableDates).join(', ')}`);

    // Get existing appointments for this resource
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() + maxDaysToCheck);
    
    let existingAppointments = [];
    try {
      let appointmentsQuery;
      
      if (resourceType === 'user') {
        appointmentsQuery = supa
          .from('appointments')
          .select('start_at, end_at')
          .eq('owner_id', resourceId)
          .gte('start_at', now.toISOString())
          .lte('start_at', endDate.toISOString())
          .eq('status', 'scheduled');
      } else {
        appointmentsQuery = supa
          .from('appointments')
          .select('start_at, end_at')
          .eq('doctor_id', resourceId)
          .gte('start_at', now.toISOString())
          .lte('start_at', endDate.toISOString())
          .eq('status', 'scheduled');
      }
      
      const { data: appointments, error } = await appointmentsQuery;
      
      if (!error && appointments) {
        existingAppointments = appointments;
      }
    } catch (error) {
      log.warn('Could not fetch existing appointments:', error);
    }

    // Day names mapping
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

    // Check each day for the next maxDaysToCheck days (starting from TOMORROW, not today)
    for (let i = 1; i < maxDaysToCheck && slots.length < maxSlots; i++) {
      const checkDate = new Date(now);
      checkDate.setDate(checkDate.getDate() + i);
      
      // Get date string in São Paulo timezone to match the format stored in unavailableDates
      const dateString = getDateStringInTimezone(checkDate, 'America/Sao_Paulo');
      
      log.debug(`Checking date: ${dateString}, is unavailable: ${unavailableDates.has(dateString)}`);
      
      // Skip if date is specifically marked as unavailable
      if (unavailableDates.has(dateString)) {
        log.debug(`Skipping unavailable date: ${dateString}`);
        continue;
      }

      const dayName = dayNames[checkDate.getDay()];
      const daySchedule = workingHours?.[dayName];

      // Check if the day is enabled and has time slots
      if (daySchedule && daySchedule.enabled && daySchedule.timeSlots && daySchedule.timeSlots.length > 0) {
        // Check each time slot for availability
        for (const slot of daySchedule.timeSlots) {
          if (slots.length >= maxSlots) break;
          
          const [hours, minutes] = (slot.start || '09:00').split(':');
          // Create slot time in São Paulo timezone
          const slotStartTime = new Date(dateString + `T${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:00-03:00`);
          // #region agent log
          const isPastSlot = slotStartTime <= now;
          fetch('http://localhost:7243/ingest/fa704248-e3dd-4b0a-ab9f-643803e5688c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'agentManager.js:findAvailableSlots:slotCheck',message:'Checking slot',data:{dateString,slotTime:slotStartTime.toISOString(),nowTime:now.toISOString(),isPastSlot,dayIndex:i},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
          // #endregion

          // Skip past slots (even if date is tomorrow, slot time might be in the past)
          if (slotStartTime <= now) {
            continue;
          }

          // Check if this time slot conflicts with existing appointments
          const hasConflict = existingAppointments.some(appointment => {
            const appointmentStart = new Date(appointment.start_at);
            const appointmentEnd = new Date(appointment.end_at);
            
            // Check if the slot time falls within an existing appointment
            return slotStartTime >= appointmentStart && slotStartTime < appointmentEnd;
          });

          if (!hasConflict) {
            // #region agent log
            fetch('http://localhost:7243/ingest/fa704248-e3dd-4b0a-ab9f-643803e5688c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'agentManager.js:findAvailableSlots:slotAdded',message:'Slot added to available list',data:{dateString,slotTime:slotStartTime.toISOString(),isPastSlot,totalSlots:slots.length+1},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
            // #endregion
            // Found an available slot!
            slots.push(slotStartTime);
          }
        }
      }
    }

    return slots;
  }

  /**
   * Find all available slots for a specific date
   */
  async findAvailableSlotsForDate(workingHours, dateSpecificAvailability, targetDateString, resourceId, resourceType = 'doctor') {
    const slots = [];
    
    // Parse date-specific unavailability
    const unavailableDates = new Set();
    if (dateSpecificAvailability && Array.isArray(dateSpecificAvailability)) {
      dateSpecificAvailability.forEach(item => {
        if (item.type === 'unavailable' && item.date) {
          const normalizedDate = normalizeDateString(item.date);
          unavailableDates.add(normalizedDate);
        }
      });
    }
    
    // Check if target date is unavailable
    const normalizedTargetDate = normalizeDateString(targetDateString);
    if (unavailableDates.has(normalizedTargetDate)) {
      log.debug(`Target date ${normalizedTargetDate} is marked as unavailable`);
      return slots; // Return empty array
    }
    
    // Parse the target date in São Paulo timezone
    const targetDate = new Date(normalizedTargetDate + 'T00:00:00-03:00');
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayName = dayNames[targetDate.getDay()];
    const daySchedule = workingHours?.[dayName];
    
    // Check if the day is enabled and has time slots
    if (!daySchedule || !daySchedule.enabled || !daySchedule.timeSlots || daySchedule.timeSlots.length === 0) {
      log.debug(`No working hours configured for ${dayName} on ${normalizedTargetDate}`);
      return slots; // Return empty array
    }
    
    // Get existing appointments for this resource on the target date
    // Use São Paulo timezone for start and end of day
    const startOfDay = new Date(normalizedTargetDate + 'T00:00:00-03:00');
    const endOfDay = new Date(normalizedTargetDate + 'T23:59:59-03:00');
    
    let existingAppointments = [];
    try {
      let appointmentsQuery;
      
      if (resourceType === 'user') {
        appointmentsQuery = supa
          .from('appointments')
          .select('start_at, end_at')
          .eq('owner_id', resourceId)
          .gte('start_at', startOfDay.toISOString())
          .lte('start_at', endOfDay.toISOString())
          .eq('status', 'scheduled');
      } else {
        appointmentsQuery = supa
          .from('appointments')
          .select('start_at, end_at')
          .eq('doctor_id', resourceId)
          .gte('start_at', startOfDay.toISOString())
          .lte('start_at', endOfDay.toISOString())
          .eq('status', 'scheduled');
      }
      
      const { data: appointments, error } = await appointmentsQuery;
      
      if (!error && appointments) {
        existingAppointments = appointments;
      }
    } catch (error) {
      log.warn('Could not fetch existing appointments for target date:', error);
    }
    
    // Check each time slot for availability on the target date
    for (const slot of daySchedule.timeSlots) {
      const [hours, minutes] = (slot.start || '09:00').split(':');
      // Create slot time in São Paulo timezone
      const slotStartTime = new Date(normalizedTargetDate + `T${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:00-03:00`);
      
      // Check if this time slot conflicts with existing appointments
      const hasConflict = existingAppointments.some(appointment => {
        const appointmentStart = new Date(appointment.start_at);
        const appointmentEnd = new Date(appointment.end_at);
        
        // Check if the slot time falls within an existing appointment
        return slotStartTime >= appointmentStart && slotStartTime < appointmentEnd;
      });
      
      if (!hasConflict) {
        // Found an available slot!
        slots.push(slotStartTime);
      }
    }

    return slots;
  }

  /**
   * Find next available slot from working hours, specific availability, and existing appointments
   */
  async findNextAvailableSlot(workingHours, dateSpecificAvailability, fromDate, resourceId, resourceType = 'doctor') {
    // Use São Paulo timezone for all date/time calculations
    const now = new Date(new Date(fromDate).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const maxDaysToCheck = 30; // Check up to 30 days ahead
    
    // Parse date-specific unavailability
    const unavailableDates = new Set();
    if (dateSpecificAvailability && Array.isArray(dateSpecificAvailability)) {
      dateSpecificAvailability.forEach(item => {
        if (item.type === 'unavailable' && item.date) {
          // Normalize date to YYYY-MM-DD format
          const normalizedDate = normalizeDateString(item.date);
          unavailableDates.add(normalizedDate);
          log.debug(`Marked date as unavailable: ${normalizedDate} (original: ${item.date})`);
        }
      });
    }
    
    log.debug(`Unavailable dates: ${Array.from(unavailableDates).join(', ')}`);

    // Get existing appointments for this resource (doctor, treatment, or user)
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() + maxDaysToCheck);
    
    let existingAppointments = [];
    try {
      let appointmentsQuery;
      
      if (resourceType === 'user') {
        // For beauty clinic (user-level), get all appointments for this owner
        appointmentsQuery = supa
          .from('appointments')
          .select('start_at, end_at')
          .eq('owner_id', resourceId)
          .gte('start_at', now.toISOString())
          .lte('start_at', endDate.toISOString())
          .eq('status', 'scheduled');
      } else {
        // For medical clinic (doctor-level)
        appointmentsQuery = supa
          .from('appointments')
          .select('start_at, end_at')
          .eq('doctor_id', resourceId)
          .gte('start_at', now.toISOString())
          .lte('start_at', endDate.toISOString())
          .eq('status', 'scheduled');
      }
      
      const { data: appointments, error } = await appointmentsQuery;
      
      if (!error && appointments) {
        existingAppointments = appointments;
      }
    } catch (error) {
      log.warn('Could not fetch existing appointments:', error);
    }

    // Day names mapping
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

    // Check each day for the next maxDaysToCheck days (starting from TOMORROW, not today)
    for (let i = 1; i < maxDaysToCheck; i++) {
      const checkDate = new Date(now);
      checkDate.setDate(checkDate.getDate() + i);
      
      // Get date string in São Paulo timezone to match the format stored in unavailableDates
      const dateString = getDateStringInTimezone(checkDate, 'America/Sao_Paulo');
      
      log.debug(`Checking date: ${dateString}, is unavailable: ${unavailableDates.has(dateString)}`);
      
      // Skip if date is specifically marked as unavailable
      if (unavailableDates.has(dateString)) {
        log.debug(`Skipping unavailable date: ${dateString}`);
        continue;
      }

      const dayName = dayNames[checkDate.getDay()];
      const daySchedule = workingHours?.[dayName];

      // Check if the day is enabled and has time slots
      if (daySchedule && daySchedule.enabled && daySchedule.timeSlots && daySchedule.timeSlots.length > 0) {
        // Check each time slot for availability
        for (const slot of daySchedule.timeSlots) {
          const [hours, minutes] = (slot.start || '09:00').split(':');
          // Create slot time in São Paulo timezone
          const slotStartTime = new Date(dateString + `T${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:00-03:00`);

          // Skip past slots (even if date is tomorrow, slot time might be in the past)
          if (slotStartTime <= now) {
            continue;
          }

          // Check if this time slot conflicts with existing appointments
          const hasConflict = existingAppointments.some(appointment => {
            const appointmentStart = new Date(appointment.start_at);
            const appointmentEnd = new Date(appointment.end_at);
            
            // Check if the slot time falls within an existing appointment
            return slotStartTime >= appointmentStart && slotStartTime < appointmentEnd;
          });

          if (!hasConflict) {
            // Found an available slot!
            return slotStartTime;
          }
        }
      }
    }

    // If no available slot found in the next 30 days, default to 2 weeks from now
    const defaultDate = new Date(now);
    defaultDate.setDate(defaultDate.getDate() + 14);
    defaultDate.setHours(9, 0, 0, 0);
    return defaultDate;
  }

  /**
   * Make outbound call with assigned agent
   */
  async makeOutboundCall(lead) {
    try {
      if (!lead.assigned_agent_id) {
        throw new Error('No agent assigned to lead');
      }

      // Get agent details with owner's phone number and Twilio phone number
      const { data: agent, error: agentError } = await supa
        .from('agents')
        .select(`
          *,
          users!agents_owner_id_fkey(twilio_phone_number)
        `)
        .eq('id', lead.assigned_agent_id)
        .single();

      if (agentError || !agent) {
        throw new Error('Agent not found');
      }

      // Extract first name only for more humanized conversation
      const firstName = String(lead.name || '').split(' ')[0];
      
      // Merge lead data with agent variables and ensure all values are strings
      const callVariables = {
        ...lead.agent_variables,
        lead_id: String(lead.id),
        name: firstName,
        phone: String(lead.phone || ''),
        phone_last4: String(lead.phone || '').slice(-4),
        city: String(lead.city || ''),
        specialty: String(lead.specialty || ''),
        reason: String(lead.reason || ''),
        urgency_level: String(lead.urgency_level || 1),
        preferred_language: String(lead.preferred_language || 'Português')
      };

      // Ensure all agent_variables are also strings
      if (lead.agent_variables) {
        Object.keys(lead.agent_variables).forEach(key => {
          if (lead.agent_variables[key] !== null && lead.agent_variables[key] !== undefined) {
            if (key === 'name') {
              const fullName = String(lead.agent_variables[key]);
              callVariables[key] = fullName.split(' ')[0] || firstName;
            } else {
              callVariables[key] = String(lead.agent_variables[key]);
            }
          }
        });
      }
      
      // Always ensure 'name' is set to first name only (override any agent_variables.name)
      callVariables.name = firstName;


      // Validate required fields
      if (!agent.retell_agent_id) {
        throw new Error('Agent does not have a valid Retell agent ID');
      }
      
      if (!lead.phone) {
        throw new Error('Lead phone number is required');
      }

      // Make the call using Retell
      // Priority: 1) User's Twilio phone number, 2) Owner's regular phone number, 3) Environment default
      const fromNumber = agent.users?.twilio_phone_number;
      


      const callResponse = await retellCreatePhoneCall({
        agent_id: agent.retell_agent_id,
        to_number: lead.phone,
        from_number: fromNumber,
        customer_name: lead.name,
        metadata: {
          lead_id: lead.id,
          agent_id: agent.id,
          owner_id: agent.owner_id,
          resource_type: lead.assigned_resource_type,
          resource_id: lead.assigned_resource_id
        },
        retell_llm_dynamic_variables: callVariables
      });

      log.info(`Outbound call initiated: ${callResponse.call_id} for lead ${lead.id}`);
      return callResponse;

    } catch (error) {
      log.error('Error making outbound call:', error);
      throw error;
    }
  }

  /**
   * Get all doctors for a business owner
   */
  async getDoctorsForOwner(ownerId, options = {}) {
    try {
      const { activeOnly = true } = options;

      let query = supa
        .from('doctors')
        .select('*')
        .eq('owner_id', ownerId);

      if (activeOnly) {
        query = query.eq('is_active', true);
      }

      const { data: doctors, error } = await query.order('created_at', { ascending: false });

      if (error) {
        throw new Error(`Error fetching doctors: ${error.message}`);
      }

      return doctors || [];
    } catch (error) {
      log.error('Error getting doctors for owner:', error);
      throw error;
    }
  }

  /**
   * Get all agents for a business owner
   */
  async getAgentsForOwner(ownerId, options = {}) {
    try {
      const { activeOnly = true } = options;

      let query = supa
        .from('agents')
        .select('*')
        .eq('owner_id', ownerId);

      if (activeOnly) {
        query = query.eq('is_active', true);
      }

      const { data: agents, error } = await query.order('created_at', { ascending: false });

      if (error) {
        throw new Error(`Error fetching agents: ${error.message}`);
      }

      return agents || [];
    } catch (error) {
      log.error('Error getting agents for owner:', error);
      throw error;
    }
  }

  async getChatAgentForOwner(ownerId, serviceType) {
    try {
      const { data: agent, error } = await supa
        .from('agents')
        .select('*')
        .eq('owner_id', ownerId)
        .eq('channel', 'chat')
        .eq('service_type', serviceType)
        .eq('is_active', true)
        .single();

      if (error) {
        log.warn(`No chat agent found for owner ${ownerId} with service type ${serviceType}:`, error.message);
        return null;
      }

      return agent;
    } catch (error) {
      log.error('Error getting chat agent for owner:', error);
      return null;
    }
  }

  /**
   * Create a new doctor for a business owner
   */
  async createDoctor(ownerId, doctorData) {
    try {
      const {
        name,
        email,
        phone_number,
        specialty,
        bio,
        consultation_price,
        return_consultation_price,
        consultation_duration = 90,
        telemedicine_available = false,
        working_hours = {},
        date_specific_availability = [],
        timezone = 'America/Sao_Paulo',
        office_address,
        city,
        state,
        tags = [],
        // Treatment configuration fields
        return_policy_days = 30,
        reimbursement_invoice_enabled = false,
        payment_methods = { credit_card_installments: 4 },
        discount_percentage_pix = 0,
        use_real_availability = false,
        is_female = false
      } = doctorData;

      // Validation
      if (!name || !specialty) {
        throw new Error('Name and specialty are required');
      }

      // Get specialty_id if exists
      const { data: specialtyData } = await supa
        .from('specialties')
        .select('id')
        .eq('name', specialty)
        .single();

      // Create doctor
      const { data: newDoctor, error: doctorError } = await supa
        .from('doctors')
        .insert({
          owner_id: ownerId,
          name: name.trim(),
          email: email?.trim(),
          phone_number,
          specialty,
          bio,
          consultation_price: consultation_price ? parseFloat(consultation_price) : null,
          return_consultation_price: return_consultation_price ? parseFloat(return_consultation_price) : null,
          consultation_duration: parseInt(consultation_duration),
          telemedicine_available: Boolean(telemedicine_available),
          working_hours,
          date_specific_availability: Array.isArray(date_specific_availability) ? date_specific_availability : [],
          timezone,
          office_address,
          city,
          state,
          tags: Array.isArray(tags) ? tags : [],
          // Treatment configuration
          return_policy_days,
          reimbursement_invoice_enabled,
          payment_methods,
          discount_percentage_pix,
          use_real_availability,
          is_female: Boolean(is_female),
          is_active: true
        })
        .select()
        .single();

      if (doctorError) {
        throw new Error(`Doctor creation error: ${doctorError.message}`);
      }

      log.info(`Created doctor ${newDoctor.id} for owner ${ownerId}`);
      return newDoctor;

    } catch (error) {
      log.error('Error creating doctor:', error);
      throw error;
    }
  }

  /**
   * Set default agent for owner
   */
  async setDefaultAgent(ownerId, agentId) {
    try {
      // Verify agent belongs to owner
      const { data: agent, error: agentError } = await supa
        .from('agents')
        .select('id')
        .eq('id', agentId)
        .eq('owner_id', ownerId)
        .eq('is_active', true)
        .single();

      if (agentError || !agent) {
        throw new Error('Agent not found or does not belong to you');
      }

      // Update user's default agent
      const { error: updateError } = await supa
        .from('users')
        .update({ default_agent_id: agentId })
        .eq('id', ownerId);

      if (updateError) {
        throw new Error(`Failed to set default agent: ${updateError.message}`);
      }

      log.info(`Set agent ${agentId} as default for owner ${ownerId}`);
      return true;

    } catch (error) {
      log.error('Error setting default agent:', error);
      throw error;
    }
  }

  /**
   * Get owner's current default agent
   */
  async getDefaultAgent(ownerId) {
    try {
      const { data: user, error } = await supa
        .from('users')
        .select(`
          default_agent_id,
          agents(*)
        `)
        .eq('id', ownerId)
        .single();

      if (error) {
        throw new Error(`Error fetching default agent: ${error.message}`);
      }

      return user?.agents || null;

    } catch (error) {
      log.error('Error getting default agent:', error);
      throw error;
    }
  }

  /**
   * Load agent template from file
   */
  async loadAgentTemplate(serviceType = 'clinic', channel = 'voice') {
    try {
      let templatePath;
      
      if (channel === 'chat') {
        // Chat agent template (same for all service types)
        templatePath = path.join(process.cwd(), 'src/templates/chat-agent-template.json');
      } else {
        // Voice agent template (same for all service types currently)
        templatePath = path.join(process.cwd(), 'src/templates/agent-template.json');
      }
      
      log.info(`Loading ${channel} agent template from ${templatePath}`);
      const templateContent = await fs.readFile(templatePath, 'utf-8');
      return JSON.parse(templateContent);
    } catch (error) {
      log.error('Error loading agent template:', error);
      throw new Error('Failed to load agent template');
    }
  }

  /**
   * Load conversation flow template from file based on service type and channel
   */
  async loadConversationFlowTemplate(serviceType = 'clinic', channel = 'voice') {
    try {
      let templatePath;
      
      if (channel === 'chat') {
        // Chat conversation flow templates
        switch (serviceType) {
          case 'beauty_clinic':
            templatePath = path.join(process.cwd(), 'src/templates/chat_agent_beauty_template.json');
            break;
          case 'clinic':
          default:
            templatePath = path.join(process.cwd(), 'src/templates/chat_agent_clinic_template.json');
            break;
        }
      } else {
        // Voice conversation flow templates
      switch (serviceType) {
        case 'beauty_clinic':
          templatePath = path.join(process.cwd(), 'src/templates/conversation-flow-template-beauty.json');
          break;
        case 'clinic':
        default:
          templatePath = path.join(process.cwd(), 'src/templates/conversation-flow-template.json');
          break;
        }
      }
      
      log.info(`Loading ${channel} conversation flow template for service type: ${serviceType} from ${templatePath}`);
      const templateContent = await fs.readFile(templatePath, 'utf-8');
      return JSON.parse(templateContent);
    } catch (error) {
      log.error('Error loading conversation flow template:', error);
      throw new Error(`Failed to load ${channel} conversation flow template for ${serviceType}`);
    }
  }

  /**
   * Generate agent configuration from template
   */
  async generateAgentConfig(owner, template, options = {}) {
    const config = JSON.parse(JSON.stringify(template)); // Deep clone
    
    // Replace template variables
    const variables = {
      timestamp: Date.now(),
      agent_name: options.agent_name || options.name || `${owner.name} Assistant`,
      conversation_flow_id: 'PLACEHOLDER', // Will be replaced after flow creation
      webhook_url: `${env.APP_BASE_URL}/retell/webhook`,
      language: options.language || 'pt-BR',
      version_title: `${options.agent_name || options.name || 'Business'} Agent v1.0`,
      phone_number: options.phone_number || '',
      voice_id: options.voice_id || '11labs-Jenny'
    };

    // Add channel-specific variables
    if (options.channel === 'voice') {
      variables.ambient_sound = options.ambient_sound || 'coffee-shop';
    }

    const generatedConfig = this.replaceTemplateVariables(config, variables);
    
    // Explicitly set channel to ensure it's correct (important for chat agents)
    if (options.channel) {
      generatedConfig.channel = options.channel;
    }

    return generatedConfig;
  }

  /**
   * Generate conversation flow from template
   */
  async generateConversationFlow(owner, template, options = {}) {
    const flow = JSON.parse(JSON.stringify(template)); // Deep clone
    
    // Replace template variables
    const variables = {
      webhook_base_url: env.APP_BASE_URL,
      // Include any custom variables passed in options
      ...options
    };

    return this.replaceTemplateVariables(flow, variables);
  }

  /**
   * Replace template variables in object
   */
  replaceTemplateVariables(obj, variables) {
    if (typeof obj === 'string') {
      let result = obj;
      for (const [key, value] of Object.entries(variables)) {
        const placeholder = `{{${key}}}`;
        result = result.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value);
      }
      return result;
    } else if (Array.isArray(obj)) {
      return obj.map(item => this.replaceTemplateVariables(item, variables));
    } else if (obj !== null && typeof obj === 'object') {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.replaceTemplateVariables(value, variables);
      }
      return result;
    }
    return obj;
  }

  /**
   * Update agent configuration
   */
  async updateAgent(agentId, updates) {
    try {
      const { data: agent, error } = await supa
        .from('agents')
        .update(updates)
        .eq('id', agentId)
        .select()
        .single();

      if (error) {
        throw new Error(`Error updating agent: ${error.message}`);
      }

      // If agent config changed, update in Retell as well
      if (updates.agent_config && agent.retell_agent_id) {
        await retellClient.agent.update(agent.retell_agent_id, updates.agent_config);
      }

      return agent;
    } catch (error) {
      log.error('Error updating agent:', error);
      throw error;
    }
  }

  /**
   * Get performance statistics for an owner's agents
   */
  async getOwnerAgentStats(ownerId, options = {}) {
    try {
      const { timeframe = '30d' } = options;
      
      // Calculate date filter based on timeframe
      let dateFilter = new Date();
      switch (timeframe) {
        case '7d':
          dateFilter.setDate(dateFilter.getDate() - 7);
          break;
        case '30d':
          dateFilter.setDate(dateFilter.getDate() - 30);
          break;
        case '90d':
          dateFilter.setDate(dateFilter.getDate() - 90);
          break;
        default:
          dateFilter.setDate(dateFilter.getDate() - 30);
      }

      // Get call attempts for owner's agents
      const { data: callAttempts, error } = await supa
        .from('call_attempts')
        .select(`
          *,
          agents(id, name),
          doctors(id, name, specialty)
        `)
        .eq('owner_id', ownerId)
        .gte('created_at', dateFilter.toISOString());

      if (error) {
        throw new Error(`Error fetching stats: ${error.message}`);
      }

      // Calculate statistics
      const stats = {
        total_calls: callAttempts?.length || 0,
        successful_calls: callAttempts?.filter(ca => ca.outcome === 'completed').length || 0,
        average_duration: 0,
        by_agent: {},
        by_doctor: {},
        by_outcome: {}
      };

      // Calculate average duration
      const completedCalls = callAttempts?.filter(ca => ca.duration_seconds) || [];
      if (completedCalls.length > 0) {
        stats.average_duration = Math.round(
          completedCalls.reduce((sum, ca) => sum + ca.duration_seconds, 0) / completedCalls.length
        );
      }

      // Group by agent, doctor, and outcome
      callAttempts?.forEach(ca => {
        // By agent
        if (ca.agents) {
          const agentKey = ca.agents.id;
          if (!stats.by_agent[agentKey]) {
            stats.by_agent[agentKey] = {
              agent_name: ca.agents.name,
              total_calls: 0,
              successful_calls: 0
            };
          }
          stats.by_agent[agentKey].total_calls++;
          if (ca.outcome === 'completed') {
            stats.by_agent[agentKey].successful_calls++;
          }
        }

        // By doctor
        if (ca.doctors) {
          const doctorKey = ca.doctors.id;
          if (!stats.by_doctor[doctorKey]) {
            stats.by_doctor[doctorKey] = {
              doctor_name: ca.doctors.name,
              specialty: ca.doctors.specialty,
              total_calls: 0,
              successful_calls: 0
            };
          }
          stats.by_doctor[doctorKey].total_calls++;
          if (ca.outcome === 'completed') {
            stats.by_doctor[doctorKey].successful_calls++;
          }
        }

        // By outcome
        const outcome = ca.outcome || 'unknown';
        stats.by_outcome[outcome] = (stats.by_outcome[outcome] || 0) + 1;
      });

      return stats;

    } catch (error) {
      log.error('Error getting owner agent stats:', error);
      throw error;
    }
  }
}

export const agentManager = new AgentManager();