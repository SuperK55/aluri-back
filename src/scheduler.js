import cron from 'node-cron';
import { supa } from './lib/supabase.js';
import { agentManager } from './services/agentManager.js';
import { log } from './config/logger.js';
import { twilio } from './lib/twilio.js';
import { getNowInSaoPaulo, isWithinBusinessHours, getIsoStringNow, getDateStringInTimezone, getDayOfWeekInTimezone, normalizeDateString, toIsoStringSaoPaulo } from './utils/timezone.js';
import { whatsappBusinessService } from './services/whatsappBusiness.js';
import { normalizePhoneNumber, retellUpdateChat, retellGetChat } from './lib/retell.js';


async function canRetryNow(leadId, minGapHours = 2) {
  const { data: lastAttempt } = await supa
    .from('call_attempts')
    .select('started_at')
    .eq('lead_id', leadId)
    .order('started_at', { ascending: false })
    .limit(1);
  
  if (!lastAttempt?.[0]?.started_at) {
    return true;
  }
  
  const lastAttemptTime = new Date(lastAttempt[0].started_at);
  const now = getNowInSaoPaulo();
  const hoursSinceLastAttempt = (now - lastAttemptTime) / (1000 * 60 * 60);
  
  return hoursSinceLastAttempt >= minGapHours;
}

async function isLeadAlreadyBeingProcessed(leadId) {
  const { data: existingCall } = await supa
    .from('call_attempts')
    .select('id')
    .eq('lead_id', leadId)
    .eq('outcome', 'initiated')
    .is('ended_at', null)
    .limit(1);
  
  return existingCall && existingCall.length > 0;
}

/**
 * Get all scheduled appointments for a lead and format them for agent context
 * @param {string} leadId - The lead ID
 * @returns {Object} - Formatted appointments data for agent_variables
 */
async function getAllAppointmentsForLead(leadId) {
  try {
    if (!leadId) return { all_appointments: '', appointments_list: [], appointments_count: 0 };

    const { data: appointments, error } = await supa
      .from('appointments')
      .select(`
        id,
        start_at,
        end_at,
        resource_type,
        resource_id,
        status,
        doctors(id, name),
        treatments(id, treatment_name)
      `)
      .eq('lead_id', leadId)
      .eq('status', 'scheduled')
      .order('start_at', { ascending: true });

    if (error || !appointments || appointments.length === 0) {
      return { all_appointments: '', appointments_list: [], appointments_count: 0 };
    }

    // Format appointments for display
    const formattedAppointments = appointments.map((apt, index) => {
      const startDate = new Date(apt.start_at);
      
      // Format date in Brazilian format
      const day = String(startDate.getDate()).padStart(2, '0');
      const month = String(startDate.getMonth() + 1).padStart(2, '0');
      const year = startDate.getFullYear();
      const dateStr = `${day}/${month}/${year}`;
      
      // Format time
      const hours = String(startDate.getHours()).padStart(2, '0');
      const minutes = String(startDate.getMinutes()).padStart(2, '0');
      const timeStr = `${hours}:${minutes}`;
      
      // Get resource name
      let resourceName = 'Consulta';
      if (apt.resource_type === 'doctor' && apt.doctors) {
        resourceName = apt.doctors.name || 'Médico';
      } else if (apt.resource_type === 'treatment' && apt.treatments) {
        resourceName = apt.treatments.treatment_name || 'Tratamento';
      }

      return {
        id: apt.id,
        date: dateStr,
        time: timeStr,
        date_iso: `${year}-${month}-${day}`,
        time_24h: timeStr,
        resource_name: resourceName,
        resource_type: apt.resource_type,
        formatted: `${dateStr} às ${timeStr} com ${resourceName}`
      };
    });

    // Create a readable text list for the agent
    const appointmentsText = formattedAppointments
      .map((apt, index) => `${index + 1}. ${apt.formatted}`)
      .join('\n');

    return {
      all_appointments: appointmentsText,
      appointments_list: formattedAppointments,
      appointments_count: formattedAppointments.length
    };
  } catch (error) {
    log.error('Error fetching appointments for lead:', error);
    return { all_appointments: '', appointments_list: [], appointments_count: 0 };
  }
}

/**
 * Find available slots before a given date for a resource (doctor or treatment)
 * Returns up to maxSlots slots formatted for WhatsApp template
 */
async function findEarlierAvailableSlots(resourceId, resourceType, ownerId, beforeDate, maxSlots = 2) {
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const timezoneOffsetMap = {
    'America/Sao_Paulo': '-03:00',
    'America/Rio_Branco': '-05:00',
    'America/Manaus': '-04:00',
    'America/Fortaleza': '-03:00',
    'America/Recife': '-03:00',
    'America/Bahia': '-03:00'
  };
  
  let workingHours = {};
  let dateSpecificAvailability = [];
  let timezone = 'America/Sao_Paulo';
  let consultationDuration = 90;
  
  // Get resource configuration
  if (resourceType === 'doctor') {
    const { data: doctor } = await supa
      .from('doctors')
      .select('working_hours, date_specific_availability, consultation_duration, timezone')
      .eq('id', resourceId)
      .single();
    
    if (doctor) {
      workingHours = doctor.working_hours || {};
      dateSpecificAvailability = doctor.date_specific_availability || [];
      timezone = doctor.timezone || 'America/Sao_Paulo';
      consultationDuration = doctor.consultation_duration || 90;
    }
  } else if (resourceType === 'treatment') {
    // Get treatment duration
    const { data: treatment } = await supa
      .from('treatments')
      .select('session_duration')
      .eq('id', resourceId)
      .single();
    
    // Get owner's working hours
    const { data: owner } = await supa
      .from('users')
      .select('working_hours, date_specific_availability, timezone')
      .eq('id', ownerId)
      .single();
    
    if (owner) {
      workingHours = owner.working_hours || {};
      dateSpecificAvailability = owner.date_specific_availability || [];
      timezone = owner.timezone || 'America/Sao_Paulo';
    }
    if (treatment) {
      consultationDuration = treatment.session_duration || 60;
    }
  }
  
  const offset = timezoneOffsetMap[timezone] || '-03:00';
  const availableSlots = [];
  
  // Parse beforeDate - the date the user mentioned they want earlier than
  let targetDate;
  if (beforeDate && /^\d{4}-\d{2}-\d{2}$/.test(beforeDate)) {
    targetDate = new Date(beforeDate + `T12:00:00${offset}`);
  } else {
    // If no valid date, use 7 days from now as the "before" date
    targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 7);
  }
  
  // Start from tomorrow
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() + 1);
  
  // Search up to 14 days before the target date
  let currentDate = new Date(startDate);
  const maxDaysToSearch = 14;
  let daysSearched = 0;
  
  while (availableSlots.length < maxSlots && daysSearched < maxDaysToSearch && currentDate < targetDate) {
    const dateString = getDateStringInTimezone(currentDate, timezone);
    const dayName = dayNames[getDayOfWeekInTimezone(currentDate, timezone)];
    const daySchedule = workingHours[dayName];
    
    // Check for override availability
    const overrideAvailability = dateSpecificAvailability.find(item => {
      if (item.type !== 'available' || !item.date) return false;
      const normalizedStoredDate = normalizeDateString(item.date);
      return normalizedStoredDate === dateString;
    });
    
    // Check if date is unavailable
    const isUnavailable = dateSpecificAvailability.some(item => {
      if (item.type !== 'unavailable' || !item.date) return false;
      const normalizedStoredDate = normalizeDateString(item.date);
      return normalizedStoredDate === dateString;
    });
    
    const effectiveSchedule = overrideAvailability?.timeSlots?.length
      ? { enabled: true, timeSlots: overrideAvailability.timeSlots }
      : daySchedule;
    
    const canUseSchedule = !isUnavailable && effectiveSchedule && effectiveSchedule.enabled && effectiveSchedule.timeSlots;
    
    if (canUseSchedule) {
      // Get existing appointments for this date
      const startOfDay = new Date(dateString + `T00:00:00${offset}`);
      const endOfDay = new Date(dateString + `T23:59:59${offset}`);
      
      let appointments = [];
      
      if (resourceType === 'doctor') {
        // Query for appointments with resource_type/resource_id
        const { data: appointmentsData } = await supa
          .from('appointments')
          .select('start_at, end_at')
          .eq('resource_type', 'doctor')
          .eq('resource_id', resourceId)
          .gte('start_at', startOfDay.toISOString())
          .lte('start_at', endOfDay.toISOString())
          .eq('status', 'scheduled');
        
        appointments = appointmentsData || [];
      } else if (resourceType === 'treatment') {
        const { data: treatmentAppointments } = await supa
          .from('appointments')
          .select('start_at, end_at')
          .eq('resource_type', 'treatment')
          .eq('resource_id', resourceId)
          .gte('start_at', startOfDay.toISOString())
          .lte('start_at', endOfDay.toISOString())
          .eq('status', 'scheduled');
        
        appointments = treatmentAppointments || [];
      }
      
      const busySlots = appointments || [];
      
      if (busySlots.length > 0) {
        log.debug(`Found ${busySlots.length} existing appointments on ${dateString} for ${resourceType} ${resourceId}:`, 
          busySlots.map(a => ({ start: a.start_at, end: a.end_at }))
        );
      }
      
      // Find available slots on this day
      for (const slot of effectiveSchedule.timeSlots) {
        if (availableSlots.length >= maxSlots) break;
        
        const [hours, minutes] = (slot.start || '09:00').split(':');
        const slotStartTime = new Date(dateString + `T${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:00${offset}`);
        const slotEndTime = new Date(slotStartTime);
        slotEndTime.setMinutes(slotEndTime.getMinutes() + consultationDuration);
        
        // Skip if slot is in the past
        if (slotStartTime <= today) continue;
        
        // Check for conflicts with existing appointments
        const hasConflict = busySlots.some(appointment => {
          const appointmentStart = new Date(appointment.start_at);
          const appointmentEnd = new Date(appointment.end_at);
          // Check if slot overlaps with appointment (either slot starts during appointment or appointment overlaps slot)
          const conflicts = (slotStartTime < appointmentEnd && slotEndTime > appointmentStart);
          
          if (conflicts) {
            log.debug(`Slot ${slotStartTime.toISOString()} conflicts with appointment ${appointmentStart.toISOString()} - ${appointmentEnd.toISOString()}`);
          }
          
          return conflicts;
        });
        
        if (!hasConflict) {
          // Format: "13/11/2025 às 10:00"
          const day = String(currentDate.getDate()).padStart(2, '0');
          const month = String(currentDate.getMonth() + 1).padStart(2, '0');
          const year = currentDate.getFullYear();
          const formattedSlot = `${day}/${month}/${year} às ${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
          
          availableSlots.push({
            date: dateString,
            time: `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`,
            formatted: formattedSlot
          });
          
          log.debug(`Added available slot: ${formattedSlot} (${slotStartTime.toISOString()})`);
        } else {
          log.debug(`Skipped slot ${slotStartTime.toISOString()} on ${dateString} due to conflict`);
        }
      }
    }
    
    // Move to next day
    currentDate.setDate(currentDate.getDate() + 1);
    daysSearched++;
  }
  
  log.info(`findEarlierAvailableSlots: Found ${availableSlots.length} available slots for ${resourceType} ${resourceId} before ${beforeDate}`, {
    slots: availableSlots.map(s => s.formatted),
    resourceId,
    resourceType,
    beforeDate
  });
  
  return availableSlots;
}

cron.schedule('*/10 * * * *', async () => {
  try {
    const nowIso = getIsoStringNow();
    
    if (!isWithinBusinessHours()) {
      return;
    }
    
    const { data: leads, error } = await supa
      .from('leads')
      .select('*')
      .lte('next_retry_at', nowIso)
      .in('status', ['no_answer', 'reschedule', 'call_failed'])
      .not('assigned_agent_id', 'is', null);
    
    if (error) {
      log.error('Error querying leads for retry:', error.message);
      return;
    }
    
    if (!leads || leads.length === 0) {
      return;
    }
    
    
    for (const lead of leads) {
      try {
        // Check if lead is already being processed
        if (await isLeadAlreadyBeingProcessed(lead.id)) {
          log.info(`Lead ${lead.id} already has an active call attempt, skipping`);
          continue;
        }
        
        // Get current attempt count
        const { data: attempts } = await supa
          .from('call_attempts')
          .select('attempt_no, started_at')
          .eq('lead_id', lead.id)
          .order('attempt_no', { ascending: false })
          .limit(1);
        
        const lastAttemptNo = attempts?.[0]?.attempt_no || 0;
        const nextAttemptNo = lastAttemptNo + 1;
        
        // Check max attempts
        if (nextAttemptNo > (lead.max_attempts || 3)) {
          log.info(`Lead ${lead.id} has reached max attempts (${lead.max_attempts || 3}), switching to WhatsApp`);
          await supa
            .from('leads')
            .update({ 
              status: 'whatsapp_outreach', 
              preferred_channel: 'whatsapp',
              next_retry_at: null 
            })
            .eq('id', lead.id);
          continue;
        }
        
        // Check if enough time has passed since last attempt
        if (!(await canRetryNow(lead.id, 2))) {
          log.info(`Lead ${lead.id} - not enough time passed since last attempt, skipping`);
          continue;
        }
        
        // Ensure lead has an assigned agent
        if (!lead.assigned_agent_id) {
          log.info(`Lead ${lead.id} has no assigned agent, attempting to assign...`);
          try {
            const assignment = await agentManager.findDoctorAndAgentForLead(lead);
            const updatedLead = await agentManager.assignDoctorAndAgentToLead(
              lead.id,
              assignment.doctor,
              assignment.agent
            );
            lead.assigned_agent_id = assignment.agent.id;
            lead.assigned_doctor_id = assignment.doctor.id;
            lead.agent_variables = updatedLead.agent_variables;
            log.info(`Lead ${lead.id} assigned to agent ${assignment.agent.id}`);
          } catch (assignmentError) {
            log.error(`Failed to assign doctor/agent for lead ${lead.id}:`, assignmentError.message);
            continue;
          }
        }
        
        // Make the retry call
        const callResponse = await agentManager.makeOutboundCall(lead);
        
        // Record the call attempt
        const now = getIsoStringNow();
        await supa.from('call_attempts').insert({
          lead_id: lead.id,
          agent_id: lead.assigned_agent_id,
          resource_type: lead.assigned_resource_type,
          resource_id: lead.assigned_resource_id,
          owner_id: lead.owner_id,
          direction: 'outbound',
          attempt_no: nextAttemptNo,
          scheduled_at: now,
          started_at: now,
          retell_call_id: callResponse.call_id,
          outcome: 'initiated'
        });
        
        // Update lead status
        await supa.from('leads')
          .update({ 
            status: 'calling', 
            next_retry_at: null 
          })
          .eq('id', lead.id);
        
        log.info(`Retry call initiated for lead ${lead.id}: ${callResponse.call_id}`);
        
      } catch (leadError) {
        log.error(`Error processing retry for lead ${lead.id}:`, leadError.message);
        
        // Update lead status to indicate retry failure
        const retryTime = new Date(getNowInSaoPaulo().getTime() + 30 * 60 * 1000);
        await supa
          .from('leads')
          .update({ 
            status: 'retry_failed',
            next_retry_at: toIsoStringSaoPaulo(retryTime) // Retry in 30 minutes (São Paulo timezone)
          })
          .eq('id', lead.id);
      }
    }
    
    log.info('Retry scheduler check completed');
    
  } catch (error) {
    log.error('Retry scheduler error:', error.message);
  }
});

// Scheduler for "whatsapp_outreach" leads - Max call attempts reached, send initial greeting
cron.schedule('5 * * * *', async () => {
  try {
    if (!isWithinBusinessHours()) {
      return;
    }
    
  const { data: leads, error } = await supa
    .from('leads')
    .select('*')
    .eq('status', 'whatsapp_outreach');

    if (error) return log.error('whatsapp_outreach scheduler query error:', error.message);
    if (!leads || leads.length === 0) return;
    
    log.info(`Processing ${leads.length} leads for whatsapp_outreach`);

    for (const lead of leads) {
      try {
        const ownerId = lead.owner_id;
        if (!ownerId) {
          log.warn('Lead has no owner_id, skipping WhatsApp outreach:', { leadId: lead.id });
          continue;
        }
        
        const toPhone = lead.whatsapp || lead.phone;
        if (!toPhone) {
          log.warn('Lead has no phone number, skipping:', { leadId: lead.id });
          continue;
        }
        
        const normalizedPhone = normalizePhoneNumber(toPhone);
        const firstName = String(lead.name || '').split(' ')[0] || 'Cliente';
        
        // Get chat agent for this owner
        const resourceType = lead.assigned_resource_type || 'doctor';
        const chatAgent = await agentManager.getChatAgentForOwner(
          ownerId, 
          resourceType === 'treatment' ? 'beauty_clinic' : 'clinic'
        );
        
        // Get owner info
        const { data: ownerData } = await supa
          .from('users')
          .select('name, whatsapp_connected, whatsapp_phone_id, whatsapp_access_token')
          .eq('id', ownerId)
          .single();
        
        // Check if owner has WhatsApp Business connected
        if (!ownerData?.whatsapp_connected || !ownerData?.whatsapp_phone_id || !ownerData?.whatsapp_access_token) {
          log.warn('Owner has no WhatsApp Business connected, falling back to Twilio:', { 
            ownerId,
            whatsapp_connected: ownerData?.whatsapp_connected,
            has_phone_id: !!ownerData?.whatsapp_phone_id,
            has_access_token: !!ownerData?.whatsapp_access_token
          });
          // Fallback to Twilio
          const twilioTo = lead.whatsapp || (String(lead.phone || '').startsWith('whatsapp:') ? lead.phone : `whatsapp:${lead.phone}`);
      await twilio.messages.create({
            to: twilioTo,
        messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
            body: `Olá ${firstName}! Tentamos falar por telefone. Você prefere continuar por *ligação* ou *WhatsApp*? Responda "ligar" ou "WhatsApp".`
      });
      await supa
        .from('leads')
        .update({ status: 'waiting_preference' })
        .eq('id', lead.id);
          continue;
        }
        
        if (!chatAgent) {
          log.warn('No chat agent found for owner, skipping:', { ownerId, leadId: lead.id });
          continue;
        }
        
        // Send initial_welcome template
        const templateResult = await whatsappBusinessService.sendTemplateMessage(
          ownerId,
          normalizedPhone,
          'initial_welcome',
          'pt_BR',
          [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: firstName },
                { type: 'text', text: chatAgent.agent_name || 'Assistente' },
                { type: 'text', text: ownerData?.name || 'Clínica' }
              ]
            }
          ]
        );
        
        // Get all appointments for this lead
        const appointmentsDataForWelcome = await getAllAppointmentsForLead(lead.id);
        
        // Create whatsapp_chats record
        const chatMetadata = {
          chat_type: 'welcome',
          initiated_by: 'scheduler_whatsapp_outreach',
          resource_type: resourceType,
          resource_id: lead.assigned_resource_id
        };
        
        // Check for existing active chat for this phone number
        const { data: existingChat } = await supa
          .from('whatsapp_chats')
          .select('id, retell_chat_id')
          .eq('wa_phone', normalizedPhone)
          .in('status', ['open', 'pending_response'])
          .maybeSingle();

        const agentVariablesForWelcome = {
          ...(lead.agent_variables || {}),
          name: firstName,
          client_name: lead.name,
          business_name: ownerData?.name || 'Clínica',
          agent_name: chatAgent.agent_name || 'Assistente',
          all_appointments: appointmentsDataForWelcome.all_appointments,
          appointments_count: appointmentsDataForWelcome.appointments_count || 0
        };

        let newChat;
        if (existingChat) {
          // Update existing active chat
          const { data: updatedChat, error: updateError } = await supa
            .from('whatsapp_chats')
            .update({
              lead_id: lead.id,
              agent_id: chatAgent.id,
              status: 'pending_response',
              metadata: chatMetadata,
              agent_variables: agentVariablesForWelcome,
              last_message_at: new Date().toISOString()
            })
            .eq('id', existingChat.id)
            .select()
            .single();

          if (!updateError && updatedChat) {
            newChat = updatedChat;

            // Update Retell chat if it exists and is ongoing
            if (existingChat.retell_chat_id) {
              try {
                const retellChatInfo = await retellGetChat(existingChat.retell_chat_id);
                
                if (retellChatInfo.chat_status === 'ongoing') {
                  // Convert agent_variables to string format for Retell
                  const retellDynamicVariables = {};
                  Object.keys(agentVariablesForWelcome).forEach(key => {
                    if (agentVariablesForWelcome[key] !== null && agentVariablesForWelcome[key] !== undefined) {
                      retellDynamicVariables[key] = String(agentVariablesForWelcome[key]);
                    }
                  });

                  await retellUpdateChat(existingChat.retell_chat_id, {
                    override_dynamic_variables: retellDynamicVariables
                  });

                  log.info('Updated existing Retell chat with welcome message variables:', {
                    retellChatId: existingChat.retell_chat_id,
                    leadId: lead.id
                  });
                }
              } catch (retellError) {
                log.warn('Failed to update Retell chat for welcome message:', retellError.message);
                // Don't fail if Retell update fails
              }
            }
          }
        } else {
          // Insert new chat record
          const { data: insertedChat, error: chatError } = await supa
            .from('whatsapp_chats')
            .insert({
              owner_id: ownerId,
              lead_id: lead.id,
              wa_phone: normalizedPhone,
              agent_id: chatAgent.id,
              status: 'pending_response',
              metadata: chatMetadata,
              agent_variables: agentVariablesForWelcome,
              last_message_at: new Date().toISOString()
            })
            .select()
            .single();
          
          if (!chatError && insertedChat) {
            newChat = insertedChat;
          }
        }
        
        if (newChat) {
          await supa
            .from('whatsapp_messages')
            .insert({
              chat_id: newChat.id,
              direction: 'outbound',
              sender: 'system',
              wa_message_id: templateResult?.messageId || null,
              body: `Template: initial_welcome - ${firstName}, ${chatAgent.agent_name || 'Assistente'}, ${ownerData?.name || 'Clínica'}`,
              message_type: 'template',
              is_template: true
            });
          
          log.info('WhatsApp initial contact greeting sent (scheduler):', {
            leadId: lead.id,
            chatId: newChat.id,
            phone: normalizedPhone
          });
        }
        
        // Update lead status
        await supa
          .from('leads')
          .update({ status: 'whatsapp_outreach_sent' })
          .eq('id', lead.id);
        
      } catch (leadError) {
        log.error('Error processing whatsapp_outreach lead:', {
          leadId: lead.id,
          error: leadError.message
        });
    }
  }
  } catch (error) {
    log.error('whatsapp_outreach scheduler error:', error.message);
  }
});

// Scheduler for "available_time" leads - User wants earlier date (scarity method)
// Agent said: "Vou te retornar pelo WhatsApp entre hoje e amanhã"
cron.schedule('5 * * * *', async () => {
  try {
    const nowIso = getIsoStringNow();
    
    if (!isWithinBusinessHours()) {
      return;
    }
    
  const { data: leads, error } = await supa
    .from('leads')
    .select('*')
      .eq('status', 'available_time')
      .lte('next_retry_at', nowIso);

    if (error) return log.error('available_time scheduler query error:', error.message);
    if (!leads || leads.length === 0) return;
    
    log.info(`Processing ${leads.length} leads for available_time WhatsApp outreach`);

    for (const lead of leads) {
      try {
        const ownerId = lead.owner_id;
        if (!ownerId) {
          log.warn('Lead has no owner_id, skipping WhatsApp outreach:', { leadId: lead.id });
          continue;
        }
        
        // Get the phone number
        const toPhone = lead.whatsapp || lead.phone;
        if (!toPhone) {
          log.warn('Lead has no phone number, skipping:', { leadId: lead.id });
          continue;
        }
        
        const normalizedPhone = normalizePhoneNumber(toPhone);
        const firstName = String(lead.name || '').split(' ')[0] || 'Cliente';
        
        // Get resource info (doctor or treatment)
        const resourceType = lead.assigned_resource_type || 'doctor';
        const resourceId = lead.assigned_resource_id;
        let resourceName = 'nossa equipe';
        
        if (resourceId) {
          if (resourceType === 'doctor') {
            const { data: doctor } = await supa
              .from('doctors')
              .select('name')
              .eq('id', resourceId)
              .single();
            if (doctor) resourceName = doctor.name;
          } else if (resourceType === 'treatment') {
            const { data: treatment } = await supa
              .from('treatments')
              .select('name')
              .eq('id', resourceId)
              .single();
            if (treatment) resourceName = treatment.name;
          }
        }
        
        // Get chat agent for this owner
        const chatAgent = await agentManager.getChatAgentForOwner(ownerId, resourceType === 'treatment' ? 'beauty_clinic' : 'clinic');
        if (!chatAgent) {
          log.warn('No chat agent found for owner, skipping:', { ownerId, leadId: lead.id });
          continue;
        }
        
        // Get user/owner info for agent variables
        const { data: ownerData } = await supa
          .from('users')
          .select('name, whatsapp_connected, whatsapp_phone_id, whatsapp_access_token')
          .eq('id', ownerId)
          .single();
        
        // Check if owner has WhatsApp Business connected
        if (!ownerData?.whatsapp_connected || !ownerData?.whatsapp_phone_id || !ownerData?.whatsapp_access_token) {
          log.warn('Owner has no WhatsApp Business connected, falling back to Twilio:', { 
            ownerId,
            whatsapp_connected: ownerData?.whatsapp_connected,
            has_phone_id: !!ownerData?.whatsapp_phone_id,
            has_access_token: !!ownerData?.whatsapp_access_token
          });
          // Fallback to Twilio for owners without WhatsApp Business
          const twilioTo = lead.whatsapp || (String(lead.phone || '').startsWith('whatsapp:') ? lead.phone : `whatsapp:${lead.phone}`);
      await twilio.messages.create({
            to: twilioTo,
        messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
            body: `Olá ${firstName}! Aqui é da clínica. Temos horários disponíveis para você. Qual horário seria melhor?`
      });
      await supa
        .from('leads')
        .update({ status: 'waiting_preference' })
        .eq('id', lead.id);
          continue;
        }
        
        // Get the suggested date from agent_variables (stored during call)
        const agentVariables = lead.agent_variables || {};
        const suggestedDate = agentVariables.suggested_date || null;
        
        // Find REAL available slots BEFORE the suggested date
        const earlierSlots = await findEarlierAvailableSlots(
          resourceId,
          resourceType,
          ownerId,
          suggestedDate,
          2 // We need 2 slots for the template
        );
        
        if (earlierSlots.length < 2) {
          log.info('Not enough earlier slots found, skipping WhatsApp outreach:', {
            leadId: lead.id,
            suggestedDate,
            slotsFound: earlierSlots.length
          });
          // Mark as processed but no slots available
          await supa
            .from('leads')
            .update({ 
              status: 'no_earlier_slots',
              next_retry_at: null 
            })
            .eq('id', lead.id);
          continue;
        }
        
        // Format suggested date for display (DD/MM/YYYY)
        let formattedSuggestedDate = 'a data mencionada';
        if (suggestedDate && /^\d{4}-\d{2}-\d{2}$/.test(suggestedDate)) {
          const [year, month, day] = suggestedDate.split('-');
          formattedSuggestedDate = `${day}/${month}/${year}`;
        }
        
        // Send WhatsApp template: earlier_appointment_offer
        // Template: "Olá {{1}}! 😊\nAqui é a {{2}} da clínica {{3}}.\nConseguimos horários antes do dia {{4}}:\n\n👉 {{5}}\n👉 {{6}}\n\nAlgum desses funciona para você?"
        const templateResult = await whatsappBusinessService.sendTemplateMessage(
          ownerId,
          normalizedPhone,
          'earlier_appointment_offer', // Template name
          'pt_BR',
          [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: firstName },                           // {{1}} - Client name
                { type: 'text', text: chatAgent.agent_name || 'Assistente' }, // {{2}} - Agent name
                { type: 'text', text: ownerData?.name || 'Clínica' }, // {{3}} - Clinic name
                { type: 'text', text: formattedSuggestedDate },               // {{4}} - Date user mentioned
                { type: 'text', text: earlierSlots[0].formatted },            // {{5}} - First available slot
                { type: 'text', text: earlierSlots[1].formatted }             // {{6}} - Second available slot
              ]
            }
          ]
        );
        
        // Create whatsapp_chats record with real available slots
        const chatMetadata = {
          chat_type: 'real_available_time',
          suggested_date: suggestedDate,
          offered_slots: earlierSlots, // Store the actual slots offered
          resource_type: resourceType,
          resource_id: resourceId,
          resource_name: resourceName,
          initiated_by: 'scheduler_scarity'
        };
        
        // Format available slots for agent context
        const availableSlotsText = earlierSlots.map(s => s.formatted).join('\n');
        
        // Get all appointments for this lead to help with rescheduling
        const appointmentsData = await getAllAppointmentsForLead(lead.id);
        
        // Check for existing active chat for this phone number
        const { data: existingChat } = await supa
          .from('whatsapp_chats')
          .select('id, retell_chat_id')
          .eq('wa_phone', normalizedPhone)
          .in('status', ['open', 'pending_response'])
          .maybeSingle();

        const agentVariablesForAvailableTime = {
          ...agentVariables,
          name: firstName,
          client_name: lead.name,
          resource_name: resourceName,
          resource_type: resourceType,
          business_name: ownerData?.name || 'Clínica',
          agent_name: chatAgent.agent_name || 'Assistente',
          suggested_date: formattedSuggestedDate,
          available_slots: availableSlotsText,
          slot_1: earlierSlots[0]?.formatted || '',
          slot_1_date: earlierSlots[0]?.date || '',
          slot_1_time: earlierSlots[0]?.time || '',
          slot_2: earlierSlots[1]?.formatted || '',
          slot_2_date: earlierSlots[1]?.date || '',
          slot_2_time: earlierSlots[1]?.time || '',
          // Include all appointments for rescheduling context
          all_appointments: appointmentsData.all_appointments,
          appointments_count: appointmentsData.appointments_count || 0
        };

        let newChat;
        if (existingChat) {
          // Update existing active chat
          const { data: updatedChat, error: updateError } = await supa
            .from('whatsapp_chats')
            .update({
              lead_id: lead.id,
              agent_id: chatAgent.id,
              status: 'pending_response',
              metadata: chatMetadata,
              agent_variables: agentVariablesForAvailableTime,
              last_message_at: new Date().toISOString()
            })
            .eq('id', existingChat.id)
            .select()
            .single();

          if (updateError) {
            log.error('Error updating whatsapp_chats record:', updateError);
          } else {
            newChat = updatedChat;

            // Update Retell chat if it exists and is ongoing
            if (existingChat.retell_chat_id) {
              try {
                const retellChatInfo = await retellGetChat(existingChat.retell_chat_id);
                
                if (retellChatInfo.chat_status === 'ongoing') {
                  // Convert agent_variables to string format for Retell
                  const retellDynamicVariables = {};
                  Object.keys(agentVariablesForAvailableTime).forEach(key => {
                    if (agentVariablesForAvailableTime[key] !== null && agentVariablesForAvailableTime[key] !== undefined) {
                      retellDynamicVariables[key] = String(agentVariablesForAvailableTime[key]);
                    }
                  });

                  await retellUpdateChat(existingChat.retell_chat_id, {
                    override_dynamic_variables: retellDynamicVariables
                  });

                  log.info('Updated existing Retell chat with available time variables:', {
                    retellChatId: existingChat.retell_chat_id,
                    leadId: lead.id
                  });
                }
              } catch (retellError) {
                log.warn('Failed to update Retell chat for available time:', retellError.message);
                // Don't fail if Retell update fails
              }
            }
          }
        } else {
          // Insert new chat record
          const { data: insertedChat, error: chatError } = await supa
          .from('whatsapp_chats')
          .insert({
            owner_id: ownerId,
            lead_id: lead.id,
            wa_phone: normalizedPhone,
            agent_id: chatAgent.id,
            status: 'pending_response', // Waiting for user to reply
            metadata: chatMetadata,
            agent_variables: agentVariablesForAvailableTime,
            last_message_at: new Date().toISOString()
          })
          .select()
          .single();
        
        if (chatError) {
          log.error('Error creating whatsapp_chats record:', chatError);
        } else {
            newChat = insertedChat;
          }
        }
        
        if (newChat) {
          // Store the outbound template message
          await supa
            .from('whatsapp_messages')
            .insert({
              chat_id: newChat.id,
              direction: 'outbound',
              sender: 'system',
              wa_message_id: templateResult?.messageId || null,
              body: `Template: earlier_appointment_offer - ${firstName}, ${chatAgent.agent_name || 'Assistente'}, ${ownerData?.name || 'Clínica'}, ${formattedSuggestedDate}, ${earlierSlots[0].formatted}, ${earlierSlots[1].formatted}`,
              message_type: 'template',
              is_template: true,
              payload: {
                template_name: 'earlier_appointment_offer',
                slots_offered: earlierSlots
              }
            });
          
          log.info('WhatsApp earlier slot offer sent successfully:', {
            leadId: lead.id,
            chatId: newChat.id,
            phone: normalizedPhone,
            suggestedDate: formattedSuggestedDate,
            slotsOffered: earlierSlots.map(s => s.formatted)
          });
        }
        
        // Update lead status
        await supa
          .from('leads')
          .update({ 
            status: 'whatsapp_scarity_sent',
            next_retry_at: null 
          })
          .eq('id', lead.id);
        
      } catch (leadError) {
        log.error('Error processing available_time lead:', {
          leadId: lead.id,
          error: leadError.message
        });
      }
    }
    
  } catch (error) {
    log.error('available_time scheduler error:', error.message);
  }
});

