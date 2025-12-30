import { Router } from 'express';
import { verifyRetell } from '../middleware/verifyRetell.js';
import { supa } from '../lib/supabase.js';
import { log } from '../config/logger.js';
import { Retell } from 'retell-sdk';
import { env } from '../config/env.js';
import { getNowInSaoPaulo, getIsoStringNow, toIsoStringSaoPaulo } from '../utils/timezone.js';
import { agentManager } from '../services/agentManager.js';
import { googleCalendarService } from '../services/googleCalendar.js';
import { whatsappBusinessService } from '../services/whatsappBusiness.js';
import { retellCreateChat } from '../lib/retell.js';

const r = Router();

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
 * Get day of the week (0-6, where 0 is Sunday) for a date in a specific timezone
 * @param {Date} date - The date object
 * @param {string} timezone - The timezone (default: 'America/Sao_Paulo')
 * @returns {number} - Day of the week (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
 */
function getDayOfWeekInTimezone(date, timezone = 'America/Sao_Paulo') {
  // Use Intl.DateTimeFormat to get the day of the week in the specified timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long'
  });
  const weekday = formatter.format(date).toLowerCase();
  const dayMap = {
    'sunday': 0,
    'monday': 1,
    'tuesday': 2,
    'wednesday': 3,
    'thursday': 4,
    'friday': 5,
    'saturday': 6
  };
  return dayMap[weekday] ?? 0;
}

async function computeNextRetry(attemptNo, { inVoicemail = false, leadId = null } = {}) {
  const now = getNowInSaoPaulo();

  // If voicemail, try again soon (15–25 min) to catch them shortly after
  if (inVoicemail) {
    const minutes = 15 + Math.floor(Math.random() * 11); // 15..25
    const d = new Date(now.getTime() + minutes * 60 * 1000);
    return d.toISOString();
  }

  // Get appointment information for this lead if leadId is provided
  let appointmentTime = null;
  if (leadId) {
    try {
      const { data: appointments } = await supa
        .from('appointments')
        .select('start_at')
        .eq('lead_id', leadId)
        .gte('start_at', now.toISOString()) // Only future appointments
        .order('start_at', { ascending: true })
        .limit(1);
      
      if (appointments && appointments.length > 0) {
        appointmentTime = new Date(appointments[0].start_at);
      }
    } catch (error) {
      // If there's an error querying appointments, continue with original logic
      console.error('Error querying appointments:', error);
    }
  }

  // Calculate next available time slot (Monday to Saturday, 8 AM to 8 PM) in São Paulo timezone
  const calculateNextSlot = (fromTime) => {
    // Ensure we're working with São Paulo time
    const d = new Date(fromTime.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const currentHour = d.getHours();
    const currentMinute = d.getMinutes();
    const currentDay = d.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    
    // Add 2 hours to current time
    d.setTime(d.getTime() + 2 * 60 * 60 * 1000);
    
    // Check if the new time is within business hours (8 AM to 8 PM, São Paulo time)
    if (d.getHours() >= 8 && d.getHours() < 20) {
      // Check if it's a valid day (Monday to Saturday)
      if (d.getDay() >= 1 && d.getDay() <= 6) {
        return d;
      } else {
        // If it's Sunday, move to Monday 8 AM
        const daysUntilMonday = 8 - d.getDay(); // 8 - 0 = 8 days
        d.setDate(d.getDate() + daysUntilMonday);
        d.setHours(8, 0, 0, 0);
        return d;
      }
    } else {
      // If outside business hours, move to next business day 8 AM
      if (d.getHours() >= 20) {
        // If it's after 8 PM, move to next day
        d.setDate(d.getDate() + 1);
      }
      
      // Find next valid business day (Monday to Saturday)
      while (d.getDay() === 0) { // Skip Sundays
        d.setDate(d.getDate() + 1);
      }
      
      d.setHours(8, 0, 0, 0);
      return d;
    }
  };
  
  let nextRetryTime = calculateNextSlot(now);
  
  if (appointmentTime) {
    const timeDiffMs = Math.abs(appointmentTime.getTime() - nextRetryTime.getTime());
    const timeDiffHours = timeDiffMs / (1000 * 60 * 60);
    
    if (timeDiffHours < 2) {
      nextRetryTime.setDate(nextRetryTime.getDate() + 1);
      
      while (nextRetryTime.getDay() === 0) {
        nextRetryTime.setDate(nextRetryTime.getDate() + 1);
      }
      
      nextRetryTime.setHours(8, 0, 0, 0);
    }
  }
  
  // Format the date in São Paulo timezone with proper offset for database storage
  // Use the utility function to ensure correct timezone handling
  const { toIsoStringSaoPaulo } = await import('../utils/timezone.js');
  return toIsoStringSaoPaulo(nextRetryTime);
}

function computeNextSameTimeNextBusinessDay(baseDate = null) {
  const reference = baseDate ? new Date(baseDate) : getNowInSaoPaulo();
  const saoPauloNow = new Date(reference.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));

  const target = new Date(saoPauloNow);
  target.setDate(target.getDate() + 1);

  while (target.getDay() === 0) {
    target.setDate(target.getDate() + 1);
  }

  target.setHours(saoPauloNow.getHours(), saoPauloNow.getMinutes(), 0, 0);

  // Clamp to business hours (08:00–20:00)
  if (target.getHours() < 8) {
    target.setHours(8, 0, 0, 0);
  } else if (target.getHours() >= 20) {
    // Move to next business day at 08:00
    target.setDate(target.getDate() + 1);
    while (target.getDay() === 0) {
      target.setDate(target.getDate() + 1);
    }
    target.setHours(8, 0, 0, 0);
  }

  // Format the date in São Paulo timezone with proper offset for database storage
  // Use the utility function to ensure correct timezone handling
  return toIsoStringSaoPaulo(target);
}

async function findAttemptByCallId(callId) {
  const { data, error } = await supa
    .from('call_attempts')
    .select('*')
    .eq('retell_call_id', callId)
    .limit(1);
  if (error) throw new Error(error.message);
  return data?.[0] || null;
}

async function maxAttemptNo(leadId) {
  const { data, error } = await supa
    .from('call_attempts')
    .select('attempt_no')
    .eq('lead_id', leadId)
    .order('attempt_no', { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return data?.[0]?.attempt_no || 1;
}

r.post('/retell/webhook', async (req, res) => {
  
  if (
    !Retell.verify(
      JSON.stringify(req.body),
      env.RETELL_API_KEY,
      req.headers["x-retell-signature"] || '',
    )
  ) {
    console.error("Invalid signature");
    return;
  }

  try {
    const evt = req.body || {};
    const type = evt.type || evt.event; 
    const c = evt.call || {};
    const callId = c.call_id || evt.call_id || 'unknown';

    log.info('retell evt', evt);

    const attempt = await findAttemptByCallId(callId);
    if (!attempt) {
      // Not one of ours (or already cleaned up) — ack to avoid retries
      return res.sendStatus(200);
    }

    if (type === 'call_started') {
      await supa
        .from('call_attempts')
        .update({ started_at: new Date().toISOString(), status: 'calling' })
        .eq('id', attempt.id);
      return res.sendStatus(200);
    }

    if (type === 'call_ended') {
      await supa
        .from('call_attempts')
        .update({
          ended_at: getIsoStringNow(),
          status: 'ended',
          outcome: evt.outcome || c.disconnection_reason
        })
        .eq('id', attempt.id);

      return res.sendStatus(200);
    }

    if (type === 'call_analyzed') {
      const transcript =
        c.transcript ||
        evt.transcript ||
        (Array.isArray(c.transcript_object) ? JSON.stringify(c.transcript_object) : null);
      const call_analysis = c.call_analysis || null;
      const total_call_duration = c.call_cost.total_duration_seconds || null;
      const inVoicemail = c.disconnection_reason === 'voicemail_reached';
      const UserDeclined = c.disconnection_reason === 'user_declined';
      const DialNoAnswer = c.disconnection_reason === 'dial_no_answer';
      const DialFailed = c.disconnection_reason === 'dial_failed';
      const DialBusy = c.disconnection_reason === 'dial_busy';

      await supa
        .from('call_attempts')
        .update({ transcript, call_analysis, total_call_duration })
        .eq('id', attempt.id);

      // Extract post-call analysis data
      const postCallAnalysis = call_analysis.custom_analysis_data || {};
      const shouldSendConfirmation = postCallAnalysis.should_send_confirmation;
      const appointmentDate = postCallAnalysis.appointment_date;
      const appointmentTime = postCallAnalysis.appointment_time;
      const shouldMakeCallAgain = postCallAnalysis.should_make_call_again;
      const agreementAppointment = postCallAnalysis.agreement_appointment;
      const callAgainReason = postCallAnalysis.call_again_reason;
      const service_type = postCallAnalysis.service_type;
      const resource_id = postCallAnalysis.preferred_service;
      const scarity_method = postCallAnalysis.scarity_method;
      const demo = postCallAnalysis?.demo || false;
      if (demo) {
        return res.sendStatus(200);
      }


      const { data: leadRows, error: leadErr } = await supa
        .from('leads')
        .select('*')
        .eq('id', attempt.lead_id)
        .limit(1);
      if (leadErr) throw new Error(leadErr.message);
      const lead = leadRows?.[0];
      if (!lead) return res.sendStatus(200);

      // Check if user wants earlier date (scarity case) - this takes priority
      // scarity_method can be true/false/"yes"/"no", callAgainReason can be 'available_time'
      const isScarity = scarity_method === true || scarity_method === 'yes' || scarity_method === 'true';
      const wantsEarlierDate = callAgainReason === 'available_time';
      
      if (wantsEarlierDate) {
        // User wants an earlier date - send WhatsApp regardless of shouldMakeCallAgain
        const nextAt = computeNextSameTimeNextBusinessDay(getNowInSaoPaulo());
        
        // Store scarity_method and suggested_date in agent_variables for the scheduler
        const updatedVariables = {
          ...(lead.agent_variables || {}),
          scarity_method: isScarity,
          suggested_date: appointmentDate || null  // The date user mentioned during call
        };
        
        await supa
          .from('leads')
          .update({ 
            status: "available_time", 
            preferred_channel: 'whatsapp', 
            next_retry_at: nextAt, 
            assigned_resource_id: resource_id,
            agent_variables: updatedVariables
          })
          .eq('id', lead.id);
          
        log.info('Lead updated for WhatsApp earlier date outreach:', { 
          leadId: lead.id, 
          scarity_method: isScarity, 
          suggestedDate: appointmentDate,
          nextRetry: nextAt,
          shouldMakeCallAgain // Log this for debugging
        });
        
        await supa.from('call_attempts').update({
          resource_id: resource_id
        }).eq('id', attempt.id);
        
      } else if (inVoicemail || shouldMakeCallAgain || UserDeclined || DialNoAnswer || DialBusy || DialFailed) {
        // Other retry cases (voicemail, no answer, etc.)
        const nextN = (await maxAttemptNo(lead.id)) + 1;

        if (nextN <= 3) {
          const nextAt = await computeNextRetry(nextN, { inVoicemail, leadId: lead.id });
          
          await supa
            .from('leads')
            .update({ status: 'other', next_retry_at: nextAt, assigned_resource_id: resource_id })
            .eq('id', lead.id);
          
          await supa.from('call_attempts').update({
            resource_id: resource_id
          }).eq('id', attempt.id);
        } else {
          // Max retries reached - switch to WhatsApp outreach and send template immediately
          const ownerId = lead.owner_id;
          const patientPhone = lead.whatsapp || lead.phone;
          
          if (ownerId && patientPhone) {
            try {
              // Get owner info for template
              const { data: ownerData } = await supa
                .from('users')
                .select('name, whatsapp_connected, whatsapp_phone_id, whatsapp_access_token')
                .eq('id', ownerId)
                .single();
              
              // Get chat agent for this owner
              const resourceType = lead.assigned_resource_type || 'doctor';
              const chatAgent = await agentManager.getChatAgentForOwner(
                ownerId, 
                resourceType === 'treatment' ? 'beauty_clinic' : 'clinic'
              );
              
              if (ownerData?.whatsapp_connected && ownerData?.whatsapp_phone_id && ownerData?.whatsapp_access_token && chatAgent) {
                const firstName = String(lead.name || '').split(' ')[0] || 'Cliente';
                const normalizedPhone = normalizePhoneNumber(patientPhone);
                
                // Send initial_welcome template
                // "Olá {{1}}! 👋\n\nSou {{2}}, assistente da clínica {{3}}.\n\nTentamos entrar em contato por telefone..."
                const templateResult = await whatsappBusinessService.sendTemplateMessage(
                  ownerId,
                  normalizedPhone,
                  'initial_welcome',
                  'pt_BR',
                  [
                    {
                      type: 'body',
                      parameters: [
                        { type: 'text', text: firstName },                              // {{1}} - Client name
                        { type: 'text', text: chatAgent.agent_name || 'Assistente' },   // {{2}} - Agent name
                        { type: 'text', text: ownerData?.name || 'Clínica' }   // {{3}} - Clinic name
                      ]
                    }
                  ]
                );
                
                // Create whatsapp_chats record for the chat agent to handle responses
                const chatMetadata = {
                  chat_type: 'welcome',
                  initiated_by: 'max_retries_reached',
                  resource_type: resourceType,
                  resource_id: lead.assigned_resource_id
                };
                
                // Check for existing active chat for this phone number
                const { data: existingChat } = await supa
                  .from('whatsapp_chats')
                  .select('id')
                  .eq('wa_phone', normalizedPhone)
                  .in('status', ['open', 'pending_response'])
                  .single();

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
                      agent_variables: {
                        ...(lead.agent_variables || {}),
                        name: firstName,
                        client_name: lead.name,
                        business_name: ownerData?.name || 'Clínica',
                        agent_name: chatAgent.agent_name || 'Assistente'
                      },
                      last_message_at: new Date().toISOString()
                    })
                    .eq('id', existingChat.id)
                    .select()
                    .single();

                  if (!updateError && updatedChat) {
                    newChat = updatedChat;
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
                    agent_variables: {
                      ...(lead.agent_variables || {}),
                      name: firstName,
                      client_name: lead.name,
                      business_name: ownerData?.name || 'Clínica',
                      agent_name: chatAgent.agent_name || 'Assistente'
                    },
                    last_message_at: new Date().toISOString()
                  })
                  .select()
                  .single();
                
                  if (!chatError && insertedChat) {
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
                      body: `Template: initial_welcome - ${firstName}, ${chatAgent.agent_name || 'Assistente'}, ${ownerData?.name || 'Clínica'}`,
                      message_type: 'template',
                      is_template: true
                    });
                  
                  log.info('WhatsApp initial contact greeting sent (max retries reached):', {
                    leadId: lead.id,
                    chatId: newChat.id,
                    phone: normalizedPhone
                  });
                }
              }
            } catch (waError) {
              log.error('Error sending WhatsApp initial contact greeting:', {
                leadId: lead.id,
                error: waError.message
              });
            }
          }
          
          // Update lead status
          await supa
            .from('leads')
            .update({
              status: 'whatsapp_outreach',
              preferred_channel: 'whatsapp',
              next_retry_at: null
            })
            .eq('id', lead.id);
        }
      } else {
        // Any other successful human conversation path you consider "qualified"
        await supa.from('leads').update({ 
          status: 'qualified',
          assigned_resource_id: resource_id
        }).eq('id', lead.id);
        await supa.from('call_attempts').update({
          resource_id: resource_id
        }).eq('id', attempt.id);
      }
      
      if (agreementAppointment === true && shouldSendConfirmation === true && appointmentDate && appointmentTime) {
        try {
          const resourceType = lead.assigned_resource_type;
          const assignedResourceId = lead.assigned_resource_id || resource_id;
          const ownerId = lead.owner_id;

          if (!ownerId) {
            log.warn('No owner_id found for lead, cannot send WhatsApp confirmation', { leadId: lead.id });
            return res.sendStatus(200);
          }

          let resourceName = 'nossa equipe';
          let templateName = 'appointment_confirmation_doc';
          let timezone = 'America/Sao_Paulo';
          let durationMinutes = 90;
          let googleCalendarEnabled = false;
          let googleCalendarDoctorId = null;
          let officeAddress = null;
          let serviceType = 'clinic';

          if (resourceType === 'doctor' && assignedResourceId) {
            const { data: doctor, error: doctorError } = await supa
              .from('doctors')
              .select('name, timezone, consultation_duration, google_calendar_id, google_refresh_token, office_address')
              .eq('id', assignedResourceId)
              .single();
            
            if (!doctorError && doctor) {
              resourceName = doctor.name;
              timezone = doctor.timezone || timezone;
              // Ensure consultation_duration is used if available, otherwise keep default
              if (doctor.consultation_duration !== null && doctor.consultation_duration !== undefined) {
                durationMinutes = doctor.consultation_duration;
              }
              googleCalendarEnabled = !!(doctor.google_calendar_id && doctor.google_refresh_token);
              googleCalendarDoctorId = assignedResourceId;
              officeAddress = doctor.office_address || null;
              
              log.info('Doctor configuration loaded:', {
                doctorId: assignedResourceId,
                doctorName: resourceName,
                consultationDuration: doctor.consultation_duration,
                durationMinutes,
                timezone
              });
            }
            templateName = 'appointment_confirmation_doc';
            serviceType = 'clinic';
          } else if (resourceType === 'treatment' && assignedResourceId) {
            const { data: treatment, error: treatmentError } = await supa
              .from('treatments')
              .select('treatment_name, session_duration')
              .eq('id', assignedResourceId)
              .single();
            
            const { data: user, error: userError } = await supa
              .from('users')
              .select('google_calendar_id, google_refresh_token, google_access_token, google_token_expires_at')
              .eq('id', ownerId)
              .single();
            
            if (!userError && user) {
              googleCalendarEnabled = !!(user.google_calendar_id && user.google_refresh_token);
            }

            if (!treatmentError && treatment) {
              resourceName = treatment.treatment_name || resourceName;
              durationMinutes = treatment.session_duration || durationMinutes;
            }
            templateName = 'appointment_confirmation_treat';
            serviceType = 'beauty_clinic';
          }

          let patientPhone = lead.phone;
          if (!patientPhone.startsWith('+')) {
            patientPhone = `+55${patientPhone.replace(/\D/g, '')}`;
          }

          const { data: ownerData } = await supa
            .from('users')
            .select('name, location')
            .eq('id', ownerId)
            .single();

          const location = ownerData?.location || 'Nossa clínica';
          timezone = 'America/Sao_Paulo';

          const timezoneOffsetMap = {
            'America/Sao_Paulo': '-03:00',
            'America/Rio_Branco': '-05:00',
            'America/Manaus': '-04:00',
            'America/Fortaleza': '-03:00',
            'America/Recife': '-03:00',
            'America/Bahia': '-03:00',
            'America/Santarem': '-03:00',
            'America/Belem': '-03:00',
            'America/Campo_Grande': '-04:00',
            'America/Cuiaba': '-04:00',
            'America/Porto_Velho': '-04:00',
            'America/Boa_Vista': '-04:00',
            'America/Maceio': '-03:00',
            'America/Sao_Luis': '-03:00',
            'America/Araguaina': '-03:00'
          };
          const offset = timezoneOffsetMap[timezone] || '-03:00';
          const startAt = `${appointmentDate}T${appointmentTime}:00${offset}`;
          
          // Log duration for debugging
          log.info('Calculating appointment end time:', {
            appointmentDate,
            appointmentTime,
            durationMinutes,
            startAt
          });
          
          // Calculate end time preserving timezone
          // Parse start time and add duration
          const startDate = new Date(startAt);
          const endDate = new Date(startDate.getTime() + durationMinutes * 60000);
          
          // Format end date in the same timezone as start (don't convert to UTC)
          // Use Intl.DateTimeFormat to format in the local timezone
          const formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
          });
          
          const parts = formatter.formatToParts(endDate);
          const endYear = parts.find(p => p.type === 'year').value;
          const endMonth = parts.find(p => p.type === 'month').value;
          const endDay = parts.find(p => p.type === 'day').value;
          const endHour = parts.find(p => p.type === 'hour').value;
          const endMinute = parts.find(p => p.type === 'minute').value;
          const endSecond = parts.find(p => p.type === 'second').value;
          
          const endAt = `${endYear}-${endMonth}-${endDay}T${endHour}:${endMinute}:${endSecond}${offset}`;
          
          log.info('Calculated appointment times:', {
            startAt,
            endAt,
            durationMinutes,
            calculatedDurationMs: endDate.getTime() - startDate.getTime(),
            calculatedDurationMinutes: (endDate.getTime() - startDate.getTime()) / 60000
          });

          const { data: appointmentInsert, error: appointmentError } = await supa
            .from('appointments')
            .insert({
              owner_id: ownerId,
              lead_id: lead.id,
              resource_type: resourceType,
              resource_id: assignedResourceId,
              appointment_type: 'consultation',
              start_at: new Date(startAt).toISOString(),
              end_at: new Date(endAt).toISOString(),
              timezone,
              status: 'scheduled',
              office_address: location,
              is_telemedicine: false,
              meeting_link: null
            })
            .select('id')
            .single();

          if (appointmentError) {
            log.error('Error creating appointment before WhatsApp confirmation:', {
              error: appointmentError.message,
              leadId: lead.id
            });
          }

          const appointmentId = appointmentInsert?.id || null;

          let googleEventId = null;
          if (googleCalendarEnabled && appointmentId) {
            try {
              // Use startAt and endAt directly with timezone offset preserved
              // Google Calendar API expects RFC3339 format with timezone
              const appointmentData = {
                summary: resourceType === 'treatment' 
                  ? `Tratamento - ${lead.name || 'Cliente'}`
                  : `Consulta - ${lead.name || 'Paciente'}`,
                description: resourceType === 'treatment'
                  ? `Tratamento: ${resourceName}`
                  : `Consulta com ${resourceName}`,
                start: {
                  dateTime: startAt, // Use original string with timezone offset
                  timeZone: timezone
                },
                end: {
                  dateTime: endAt, // Use formatted string with timezone offset
                  timeZone: timezone
                },
                location: location || undefined
              };

              log.info('Creating Google Calendar event from Retell flow:', {
                leadId: lead.id,
                appointmentData,
                doctorId: googleCalendarDoctorId,
                resourceType
              });

              let googleEvent;
              if (resourceType === 'treatment') {
                googleEvent = await googleCalendarService.createTreatmentAppointment(ownerId, appointmentData);
              } else {
                googleEvent = await googleCalendarService.createAppointment(googleCalendarDoctorId, appointmentData);
              }

              googleEventId = googleEvent?.id || null;
              if (googleEventId) {
                await supa
                  .from('appointments')
                  .update({ gcal_event_id: googleEventId })
                  .eq('id', appointmentId);
              }
            } catch (calendarError) {
              log.warn('Failed to create Google Calendar event from Retell flow:', {
                error: calendarError.message,
                leadId: lead.id,
                resourceType: resourceType,
                resourceId: resourceType === 'treatment' ? ownerId : googleCalendarDoctorId
              });
            }
          }

          const chatAgent = await agentManager.getChatAgentForOwner(ownerId, serviceType);
          let retellChatId = null;

          if (chatAgent && chatAgent.retell_agent_id) {
            try {
              const chatVariables = {
                ...(lead.agent_variables || {}),
                chat_type: 'confirm_appointment',
                name: String(lead.name || 'Cliente'),
                lead_id: String(lead.id),
                appointment_date: appointmentDate,
                appointment_time: appointmentTime,
                resource_name: resourceName,
                location: location,
                business_name: ownerData?.name || ''
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
                  lead_id: lead.id,
                  owner_id: ownerId,
                  appointment_id: appointmentId,
                  chat_type: 'confirm_appointment'
                }
              });

              retellChatId = retellChat.chat_id;
              log.info('Created Retell chat for appointment confirmation:', {
                chatId: retellChatId,
                leadId: lead.id
              });
            } catch (chatError) {
              log.warn('Failed to create Retell chat:', {
                error: chatError.message,
                leadId: lead.id
              });
            }
          }

          const [year, month, day] = appointmentDate.split('-');
          const formattedAppointmentDate = `${day}/${month}/${year}`;

          log.info('Sending WhatsApp confirmation template:', {
            leadId: lead.id,
            templateName,
            resourceType,
            patientPhone,
            appointmentDate: formattedAppointmentDate,
            appointmentTime
          });

          const result = await whatsappBusinessService.sendAppointmentConfirmationTemplate(
            ownerId,
            patientPhone,
            {
              patientName: lead.name || 'Cliente',
              doctorName: resourceName,
              appointmentDate: formattedAppointmentDate,
              appointmentTime: appointmentTime,
              location: location,
              templateName: templateName,
              languageCode: 'pt_BR'
            },
            null
          );

          const waPhone = patientPhone.replace(/[^\d]/g, '');
          
          // Check for existing active chat for this phone number
          const { data: existingChat } = await supa
            .from('whatsapp_chats')
            .select('id')
            .eq('wa_phone', waPhone)
            .in('status', ['open', 'pending_response'])
            .single();

          let chatRecord;
          if (existingChat) {
            // Update existing active chat
            const { data: updatedChat, error: updateError } = await supa
              .from('whatsapp_chats')
              .update({
                lead_id: lead.id,
                retell_chat_id: retellChatId,
                agent_id: chatAgent?.retell_agent_id || null,
                status: 'pending_response',
                metadata: {
                  chat_type: 'confirm_appointment',
                  appointment_id: appointmentId,
                  resource_type: resourceType,
                  resource_id: assignedResourceId,
                  template_name: templateName
                },
                last_message_at: new Date().toISOString()
              })
              .eq('id', existingChat.id)
              .select('id')
              .single();

            if (updateError) {
              log.error('Error updating whatsapp_chats record:', updateError.message);
            } else {
              chatRecord = updatedChat;
            }
          } else {
            // Insert new chat record
            const { data: newChat, error: chatInsertError } = await supa
            .from('whatsapp_chats')
            .insert({
              owner_id: ownerId,
              lead_id: lead.id,
              wa_phone: waPhone,
              retell_chat_id: retellChatId,
              agent_id: chatAgent?.retell_agent_id || null,
              status: 'pending_response',
              metadata: {
                chat_type: 'confirm_appointment',
                appointment_id: appointmentId,
                resource_type: resourceType,
                resource_id: assignedResourceId,
                template_name: templateName
              },
              last_message_at: new Date().toISOString()
            })
            .select('id')
            .single();

          if (chatInsertError) {
            log.error('Error creating whatsapp_chats record:', chatInsertError.message);
            } else {
              chatRecord = newChat;
            }
          }

          if (chatRecord && result?.messageId) {
            await supa
              .from('whatsapp_messages')
              .insert({
                chat_id: chatRecord.id,
                direction: 'outbound',
                sender: 'agent',
                wa_message_id: result.messageId,
                body: `[Template: ${templateName}] Appointment confirmation for ${appointmentDate} at ${appointmentTime}`,
                message_type: 'template',
                is_template: true,
                payload: {
                  template_name: templateName,
                  patient_name: lead.name,
                  doctor_name: resourceName,
                  date: appointmentDate,
                  time: appointmentTime,
                  location: location
                }
              });
          }

          if (appointmentId && result?.messageId) {
            await supa
              .from('appointments')
              .update({ whatsapp_confirmation_message_id: result.messageId })
              .eq('id', appointmentId);
          }

          await supa
            .from('leads')
            .update({
              status: 'whatsapp_confirmation_sent',
              whatsapp_confirmation_message_id: result.messageId,
              whatsapp_confirmation_sent_at: new Date().toISOString(),
              last_contact_channel: 'whatsapp'
            })
            .eq('id', lead.id);

          log.info('WhatsApp confirmation sent successfully:', {
            leadId: lead.id,
            messageId: result.messageId,
            templateName,
            chatId: chatRecord?.id,
            retellChatId
          });

        } catch (whatsappError) {
          log.error('Error sending WhatsApp confirmation template:', {
            error: whatsappError.message,
            leadId: lead.id
          });
        }
      }

      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (e) {
    log.error('retell webhook error', e?.message || e);
    return res.status(500).json({ error: e?.message || 'retell webhook error' });
  }
});

r.post('/retell/check-availability', async (req, res) => {

  if (
    !Retell.verify(
      JSON.stringify(req.body),
      env.RETELL_API_KEY,
      req.headers["x-retell-signature"] || '',
    )
  ) {
    console.error("Invalid signature");
    return;
  }

  try {
    const lead_id = req.body?.args?.lead_id || req.body?.lead_id || req.query?.lead_id;
    const date = req.body?.args?.date || req.body?.date || req.query?.date;
    
    // Log after extracting parameters, but before any response operations
    console.log('[check-availability] Request received:', { 
      lead_id, 
      date, 
      query: req.query,
      'body.args': req.body?.args,
      'function_name': req.body?.name // Retell sends function name in body
    });
    
    if (!lead_id) {
      return res.status(400).json({ 
        available: false, 
        availableSlots: [], 
        timezone: 'America/Sao_Paulo',
        ok: false, 
        error: 'lead_id is required' 
      });
    }

    // Get lead to find assigned resource (doctor or treatment)
    const { data: lead, error: leadError } = await supa
      .from('leads')
      .select('id, assigned_resource_id, assigned_resource_type, owner_id')
      .eq('id', lead_id)
      .single();

    if (leadError || !lead) {
      return res.status(404).json({ 
        available: false, 
        availableSlots: [], 
        timezone: 'America/Sao_Paulo',
        ok: false, 
        error: 'Lead not found' 
      });
    }

    const resourceId = lead.assigned_resource_id;
    const resourceType = lead.assigned_resource_type;
    const ownerId = lead.owner_id;

    if (!resourceId || !resourceType) {
      return res.status(400).json({ 
        available: false, 
        availableSlots: [], 
        timezone: 'America/Sao_Paulo',
        ok: false, 
        error: 'No resource assigned to this lead' 
      });
    }

    let workingHours = {};
    let dateSpecificAvailability = [];
    let timezone = 'America/Sao_Paulo';
    let consultationDuration = 90;
    let resourceName = '';

    // Handle different resource types
    if (resourceType === 'doctor') {
      // Get doctor's working hours and availability
      const { data: doctor, error: doctorError } = await supa
        .from('doctors')
        .select('id, name, working_hours, date_specific_availability, consultation_duration, timezone')
        .eq('id', resourceId)
        .single();

      if (doctorError || !doctor) {
        return res.status(404).json({ 
          available: false, 
          availableSlots: [], 
          timezone: 'America/Sao_Paulo',
          ok: false, 
          error: 'Doctor not found' 
        });
      }

      workingHours = doctor.working_hours || {};
      dateSpecificAvailability = doctor.date_specific_availability || [];
      timezone = doctor.timezone || 'America/Sao_Paulo';
      consultationDuration = doctor.consultation_duration || 90;
      resourceName = doctor.name || '';
    } else if (resourceType === 'treatment') {
      // For treatments, use owner's calendar (from users table)
      if (!ownerId) {
        return res.status(400).json({ 
          available: false, 
          availableSlots: [], 
          timezone: 'America/Sao_Paulo',
          ok: false, 
          error: 'Owner ID not found for treatment' 
        });
      }

      // Get treatment details for duration
      const { data: treatment, error: treatmentError } = await supa
        .from('treatments')
        .select('id, treatment_name, session_duration, owner_id')
        .eq('id', resourceId)
        .single();

      if (treatmentError || !treatment) {
        return res.status(404).json({ 
          available: false, 
          availableSlots: [], 
          timezone: 'America/Sao_Paulo',
          ok: false, 
          error: 'Treatment not found' 
        });
      }

      // Get owner's working hours and availability (for beauty clinics, calendar is at owner level)
      const { data: owner, error: ownerError } = await supa
        .from('users')
        .select('id, working_hours, date_specific_availability, timezone')
        .eq('id', ownerId)
        .single();

      if (ownerError || !owner) {
        return res.status(404).json({ 
          available: false, 
          availableSlots: [], 
          timezone: 'America/Sao_Paulo',
          ok: false, 
          error: 'Owner not found' 
        });
      }

      workingHours = owner.working_hours || {};
      dateSpecificAvailability = owner.date_specific_availability || [];
      timezone = owner.timezone || 'America/Sao_Paulo';
      consultationDuration = treatment.session_duration || 60; // Use treatment's session duration
      resourceName = treatment.treatment_name || '';
    } else {
      return res.status(400).json({ 
        available: false, 
        availableSlots: [], 
        timezone: 'America/Sao_Paulo',
        ok: false, 
        error: `Unsupported resource type: ${resourceType}` 
      });
    }

    let availableSlots = [];
    let requestedDateHasSlots = false; // Track if the REQUESTED date specifically has slots
    let reason = null;
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

    // Parse the requested date in the resource's timezone
    const timezoneOffsetMap = {
      'America/Sao_Paulo': '-03:00',
      'America/Rio_Branco': '-05:00',
      'America/Manaus': '-04:00',
      'America/Fortaleza': '-03:00',
      'America/Recife': '-03:00',
      'America/Bahia': '-03:00',
      'America/Santarem': '-03:00',
      'America/Belem': '-03:00',
      'America/Campo_Grande': '-04:00',
      'America/Cuiaba': '-04:00',
      'America/Porto_Velho': '-04:00',
      'America/Boa_Vista': '-04:00',
      'America/Maceio': '-03:00',
      'America/Sao_Luis': '-03:00',
      'America/Araguaina': '-03:00'
    };
    const offset = timezoneOffsetMap[timezone] || '-03:00';
    
    let requestedDate;
    if (date) {
      // Validate date format (should be YYYY-MM-DD)
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(date)) {
        return res.status(400).json({ 
          available: false,
          availableSlots: [],
          timezone: timezone,
          ok: false, 
          error: `Invalid date format. Expected YYYY-MM-DD, got: ${date}` 
        });
      }
      
      try {
        requestedDate = new Date(date + `T12:00:00${offset}`);
        // Check if date is valid
        if (isNaN(requestedDate.getTime())) {
          return res.status(400).json({ 
            available: false,
            availableSlots: [],
            timezone: timezone,
            ok: false, 
            error: `Invalid date: ${date}` 
          });
        }
      } catch (error) {
        return res.status(400).json({ 
          available: false,
          availableSlots: [],
          timezone: timezone,
          ok: false, 
          error: `Error parsing date: ${error.message}` 
        });
      }
    } else {
      // Get current time in the resource's timezone for proper day calculation
      requestedDate = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
    }
    
    // If requested date is today, skip to tomorrow (never offer today's date)
    const nowInTimezone = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
    const todayString = getDateStringInTimezone(nowInTimezone, timezone);
    const requestedDateString = getDateStringInTimezone(requestedDate, timezone);
    
    // Get date string in the resource's timezone to match the format stored in unavailableDates
    let dateString = date || getDateStringInTimezone(requestedDate, timezone);
    
    // If the date string (whether from explicit date param or calculated) is today, skip to tomorrow
    if (dateString === todayString) {
      // Skip to tomorrow
      requestedDate = new Date(nowInTimezone);
      requestedDate.setDate(requestedDate.getDate() + 1);
      requestedDate.setHours(0, 0, 0, 0);
      dateString = getDateStringInTimezone(requestedDate, timezone);
    }
    const dayName = dayNames[getDayOfWeekInTimezone(requestedDate, timezone)];
    const daySchedule = workingHours[dayName];

    // Check for date-specific availability overrides (e.g., special open days)
    const overrideAvailability = dateSpecificAvailability.find(item => {
      if (item.type !== 'available' || !item.date) return false;
      const normalizedStoredDate = normalizeDateString(item.date);
      return normalizedStoredDate === dateString;
    });

    // Check if date is specifically marked as unavailable (normalize date format for comparison)
    const isUnavailable = dateSpecificAvailability.some(item => {
      if (item.type !== 'unavailable' || !item.date) return false;
      // Normalize both dates for comparison
      const normalizedStoredDate = normalizeDateString(item.date);
      return normalizedStoredDate === dateString;
    });
    const isWeekend = dayName === 'saturday' || dayName === 'sunday';

    // If weekend and there's no schedule or it's explicitly unavailable, set reason upfront
    if (isWeekend && (isUnavailable || !daySchedule || !daySchedule.enabled)) {
      reason = 'weekend';
    }
    
    log.debug(`Checking availability for date: ${dateString}, is unavailable: ${isUnavailable}`);

    const effectiveSchedule = overrideAvailability?.timeSlots?.length
      ? { enabled: true, timeSlots: overrideAvailability.timeSlots }
      : daySchedule;

    const canUseSchedule = !isUnavailable && effectiveSchedule && effectiveSchedule.enabled && effectiveSchedule.timeSlots;

    // #region agent log
    fetch('http://localhost:7243/ingest/fa704248-e3dd-4b0a-ab9f-643803e5688c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'retell.js:check-availability:schedule',message:'Schedule check',data:{dateString,dayName,isUnavailable,canUseSchedule,hasDaySchedule:!!daySchedule,dayScheduleEnabled:daySchedule?.enabled,dayScheduleSlots:daySchedule?.timeSlots?.length||0,workingHoursKeys:Object.keys(workingHours||{})},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'C'})}).catch(()=>{});
    // #endregion

    if (canUseSchedule) {
      // Get existing appointments for this resource on this date
      // Create date boundaries in the resource's timezone
      const startOfDay = new Date(dateString + `T00:00:00${offset}`);
      const endOfDay = new Date(dateString + `T23:59:59${offset}`);

      // Query appointments based on resource type
      // Use resource_type and resource_id (polymorphic fields)
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
        // For treatments, use resource_type and resource_id fields
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

      const busySlots = appointments;

      const minimumBufferMinutes = 60;
      // #region agent log
      fetch('http://localhost:7243/ingest/fa704248-e3dd-4b0a-ab9f-643803e5688c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'retell.js:check-availability:start',message:'Check availability starting',data:{dateString,timezone,nowInTimezone:nowInTimezone.toISOString(),slotsCount:effectiveSchedule?.timeSlots?.length},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
      // #endregion

      for (const slot of effectiveSchedule.timeSlots) {
        const [hours, minutes] = (slot.start || '09:00').split(':');
        
        const slotStartTime = new Date(dateString + `T${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:00${offset}`);
        const slotEndTime = new Date(slotStartTime);
        slotEndTime.setMinutes(slotEndTime.getMinutes() + consultationDuration);

        const bufferTime = new Date(nowInTimezone);
        bufferTime.setMinutes(bufferTime.getMinutes() + minimumBufferMinutes);
        // #region agent log
        fetch('http://localhost:7243/ingest/fa704248-e3dd-4b0a-ab9f-643803e5688c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'retell.js:check-availability:slotCheck',message:'Checking slot buffer',data:{slotStart:slotStartTime.toISOString(),bufferTime:bufferTime.toISOString(),willSkip:slotStartTime<=bufferTime,dateString},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
        // #endregion
        if (slotStartTime <= bufferTime) {
          continue;
        }

        const hasConflict = busySlots.some(appointment => {
          const appointmentStart = new Date(appointment.start_at);
          const appointmentEnd = new Date(appointment.end_at);
          return (slotStartTime >= appointmentStart && slotStartTime < appointmentEnd) ||
                 (slotEndTime > appointmentStart && slotEndTime <= appointmentEnd) ||
                 (slotStartTime <= appointmentStart && slotEndTime >= appointmentEnd);
        });

        if (!hasConflict) {
          availableSlots.push(`${dateString}T${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:00${offset}`);
        }
      }
    }

    // Track if the requested date specifically has slots
    requestedDateHasSlots = availableSlots.length > 0;

    // If no slots available on requested date, find next 2 available slots
    if (availableSlots.length === 0) {
      // If no slots for requested date and it's a weekend, mark reason
      if (isWeekend) {
        reason = 'weekend';
      }
      const maxDaysToCheck = 60; // Check up to 60 days ahead
      const nextSlots = [];
      
      // Start searching from the day after requested date
      // (We've already checked all slots on the requested date)
      const startSearchDate = new Date(requestedDate);
      startSearchDate.setDate(startSearchDate.getDate() + 1);
      startSearchDate.setHours(0, 0, 0, 0);
      
      // Get all appointments for this resource in the next 60 days
      const endSearchDate = new Date(startSearchDate);
      endSearchDate.setDate(endSearchDate.getDate() + maxDaysToCheck);
      
      let allAppointmentsQuery = supa
        .from('appointments')
        .select('start_at, end_at')
        .gte('start_at', startSearchDate.toISOString())
        .lte('start_at', endSearchDate.toISOString())
        .eq('status', 'scheduled');

      if (resourceType === 'doctor') {
        allAppointmentsQuery = allAppointmentsQuery
          .eq('resource_type', 'doctor')
          .eq('resource_id', resourceId);
      } else if (resourceType === 'treatment') {
        allAppointmentsQuery = allAppointmentsQuery
          .eq('resource_type', 'treatment')
          .eq('resource_id', resourceId);
      }

      const { data: allAppointments } = await allAppointmentsQuery;
      const allBusySlots = allAppointments || [];

      for (let i = 0; i < maxDaysToCheck && nextSlots.length < 2; i++) {
        const checkDate = new Date(startSearchDate);
        checkDate.setDate(checkDate.getDate() + i);
        const checkDateString = getDateStringInTimezone(checkDate, timezone);
        
        const isUnavailableDate = dateSpecificAvailability.some(item => {
          if (item.type !== 'unavailable' || !item.date) return false;
          // Normalize both dates for comparison
          const normalizedStoredDate = normalizeDateString(item.date);
          return normalizedStoredDate === checkDateString;
        });
        
        if (isUnavailableDate) {
          log.debug(`Skipping unavailable date: ${checkDateString}`);
          continue;
        }

        const checkDayName = dayNames[getDayOfWeekInTimezone(checkDate, timezone)];
        const overrideCheckAvailability = dateSpecificAvailability.find(item => {
          if (item.type !== 'available' || !item.date) return false;
          const normalizedStoredDate = normalizeDateString(item.date);
          return normalizedStoredDate === checkDateString;
        });

        const checkDaySchedule = overrideCheckAvailability?.timeSlots?.length
          ? { enabled: true, timeSlots: overrideCheckAvailability.timeSlots }
          : workingHours[checkDayName];

        // #region agent log
        fetch('http://localhost:7243/ingest/fa704248-e3dd-4b0a-ab9f-643803e5688c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'retell.js:check-availability:fallbackDay',message:'Checking fallback day',data:{checkDateString,checkDayName,hasSchedule:!!checkDaySchedule,scheduleEnabled:checkDaySchedule?.enabled,slotsCount:checkDaySchedule?.timeSlots?.length||0,isUnavailable:isUnavailableDate,nextSlotsFound:nextSlots.length},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'D'})}).catch(()=>{});
        // #endregion

        if (checkDaySchedule && checkDaySchedule.enabled && checkDaySchedule.timeSlots) {
          const nowForFallback = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
          const bufferMinutes = 60;

          for (const slot of checkDaySchedule.timeSlots) {
            if (nextSlots.length >= 2) break;
            
            const [hours, minutes] = (slot.start || '09:00').split(':');
            
            const slotStartTime = new Date(checkDateString + `T${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:00${offset}`);
            const slotEndTime = new Date(slotStartTime);
            slotEndTime.setMinutes(slotEndTime.getMinutes() + consultationDuration);

            const bufferTime = new Date(nowForFallback);
            bufferTime.setMinutes(bufferTime.getMinutes() + bufferMinutes);
            if (slotStartTime <= bufferTime) {
              continue;
            }

            const hasConflict = allBusySlots.some(appointment => {
              const appointmentStart = new Date(appointment.start_at);
              const appointmentEnd = new Date(appointment.end_at);
              return (slotStartTime >= appointmentStart && slotStartTime < appointmentEnd) ||
                     (slotEndTime > appointmentStart && slotEndTime <= appointmentEnd) ||
                     (slotStartTime <= appointmentStart && slotEndTime >= appointmentEnd);
            });

            if (!hasConflict) {
              nextSlots.push(`${checkDateString}T${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:00${offset}`);
            }
          }
        }
      }

      // #region agent log
      fetch('http://localhost:7243/ingest/fa704248-e3dd-4b0a-ab9f-643803e5688c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'retell.js:check-availability:fallback',message:'Fallback search result',data:{nextSlotsFound:nextSlots.length,startSearchDate:startSearchDate.toISOString(),workingHoursKeys:Object.keys(workingHours||{})},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'D'})}).catch(()=>{});
      // #endregion

      // If we found next available slots, add them to the response
      if (nextSlots.length > 0) {
        availableSlots = nextSlots;
      }
    }

    // Ensure clean JSON response
    // CRITICAL: According to Retell docs (https://docs.retellai.com/build/conversation-flow/custom-function#custom-function)
    // Response variables extract values from the response JSON
    // Our response_variables config expects: "available", "timezone", "availableSlots" at ROOT level
    // Format: { "variable_name": "path.to.value" } - in our case, path is just the root field name
    const response = { 
      available: requestedDateHasSlots, // TRUE only if the REQUESTED date has slots, not fallback dates
      availableSlots: availableSlots, // Contains slots for requested date OR nearest alternative dates if requested date unavailable
      timezone: timezone,
      reason,
      // Additional fields for debugging/logging (not used by Retell response_variables)
      ok: true, 
      date: dateString,
      resource_id: resourceId,
      resource_type: resourceType,
      resource_name: resourceName
    };
    
    // Send response - res.json() automatically sets Content-Type header
    // Response status 200-299 indicates success per Retell docs
    // Set Cache-Control header before sending
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200).json(response);

  } catch (error) {
    console.error('[check-availability] Error:', error);
    console.error('[check-availability] Error stack:', error.stack);
    
    // Ensure we always send a valid HTTP response with proper headers
    if (!res.headersSent) {
      try {
        // Set Cache-Control header, res.json() will set Content-Type automatically
        // CRITICAL: Retell expects 'available', 'timezone', and 'availableSlots' at the ROOT level
        res.setHeader('Cache-Control', 'no-cache');
        res.status(500).json({ 
          available: false,
          availableSlots: [],
          timezone: 'America/Sao_Paulo',
          reason,
          // Additional fields for debugging/logging
          ok: false, 
          error: error.message || 'Internal server error'
        });
      } catch (sendError) {
        console.error('[check-availability] Failed to send error response:', sendError);
        // If we can't send JSON, try to end the response
        if (!res.headersSent) {
          res.status(500).end();
        }
      }
    } else {
      console.error('[check-availability] Headers already sent, cannot send error response');
    }
  }
});

r.post('/retell/recommend_doctor', async (req,res)=>{

  if (
    !Retell.verify(
      JSON.stringify(req.body),
      env.RETELL_API_KEY,
      req.headers["x-retell-signature"] || '',
    )
  ) {
    console.error("Invalid signature");
    return;
  }

  const { city, need, specialty, lead_id, agent_id, exclude_doctor_id, owner_id} = req.query || {};
  
  // Fetch agent if agent_id is provided
  let agent = null;
  if (agent_id) {
    const { data: agentData, error: agentError } = await supa
      .from('agents')
      .select('*')
      .eq('id', agent_id)
      .single();
    if (agentError || !agentData) {
      return res.status(500).json({ error:agentError?.message || 'Agent not found' });
    }
    agent = agentData;
  }
  
  let doctorsQuery = supa
    .from('doctors')
    .select('id,name,specialty,city,languages,tags,bio,telemedicine_available,consultation_price,return_consultation_price,consultation_duration,office_address,state')
    .eq('is_active', true)
    .eq('owner_id', owner_id || '')
    .neq('id', exclude_doctor_id || '');


  
  const { data, error } = await doctorsQuery.limit(200);
  console.log(`[recommend_doctor] Data: ${JSON.stringify(data)}`);
  if(error) return res.status(500).json({ error:error.message });

  function score(doc){
    let s=0;
    const specName = (doc.specialty || '').toLowerCase();
    if (specialty && specName.includes(String(specialty).toLowerCase())) s += 4;
    if (city && doc.city && doc.city.toLowerCase() === String(city).toLowerCase()) s += 2;
    if (need) {
      const toks = String(need).toLowerCase().split(/[^a-zá-ú0-9]+/i).filter(Boolean);
      const hay = new Set([...(doc.tags||[])]
        .map(t=>String(t).toLowerCase()));
      if (toks.some(t => hay.has(t))) s += 3;
    }
    return s;
  }

  const ranked=(data||[]).map(d=>({d,s:score(d)})).sort((a,b)=>b.s-a.s);
  if(!ranked.length || ranked[0].s<=0) return res.json({ another_doctor_available:false, reason:'no_match' });

  const top = ranked[0].d;
  
  // If lead_id and agent are provided, assign the new doctor and get all agent variables
  if (lead_id && agent) {
    try {
      // Fetch full doctor object (all fields needed for assignDoctorAndAgentToLead)
      const { data: fullDoctor, error: doctorError } = await supa
        .from('doctors')
        .select('*')
        .eq('id', top.id)
        .single();
      
      // Assign the new doctor to the lead and generate all agent variables
      const updatedLead = await agentManager.assignDoctorAndAgentToLead(lead_id, fullDoctor, agent);
      
      // Return success with doctor info and all agent variables
      return res.json({ 
        another_doctor_available: true, 
        agent_variables: updatedLead.agent_variables || {}
      });
    } catch (assignError) {
      console.error('Error assigning doctor to lead:', assignError);
      // Fallback: return doctor info without assignment
      return res.json({ another_doctor_available:false, reason:'no_match' });
    }
  }
});


r.post('/retell/recommend_treatment', async (req, res) => {
  if (
    !Retell.verify(
      JSON.stringify(req.body),
      env.RETELL_API_KEY,
      req.headers["x-retell-signature"] || '',
    )
  ) {
    console.error("Invalid signature");
    return;
  }

  const { category, need, desired_result, lead_id, agent_id, exclude_treatment_id, owner_id } = req.query || {};

  let agent = null;
  if (agent_id) {
    const { data: agentData, error: agentError } = await supa
      .from('agents')
      .select('*')
      .eq('id', agent_id)
      .single();
    if (agentError || !agentData) {
      return res.status(500).json({ error: agentError?.message || 'Agent not found' });
    }
    agent = agentData;
  }

  let treatmentsQuery = supa
    .from('treatments')
    .select('id, treatment_name, main_category, subcategory, description, applicable_areas, main_indication, recommended_sessions, interval_between_sessions, session_duration, recovery_time, contraindications, single_session_price, package_sessions_count, package_price, payment_methods, promotional_discount_available, apply_discount_for_pix, discount_percentage, primary_benefit, treatment_effects, pain_point_1, pain_point_2, pain_point_3, treatment_result, client_feedback, treatment_benefit, is_female')
    .eq('is_active', true)
    .eq('owner_id', owner_id || '')
    .neq('id', exclude_treatment_id || '');

  const { data, error } = await treatmentsQuery.limit(200);
  console.log(`[recommend_treatment] Data: ${JSON.stringify(data)}`);
  if (error) return res.status(500).json({ error: error.message });

  function scoreTreatment(treatment) {
    let s = 0;
    const categoryName = (treatment.main_category || '').toLowerCase();
    const subcategoryName = (treatment.subcategory || '').toLowerCase();
    const indication = (treatment.main_indication || '').toLowerCase();
    const description = (treatment.description || '').toLowerCase();
    const treatmentName = (treatment.treatment_name || '').toLowerCase();

    if (category && categoryName.includes(String(category).toLowerCase())) s += 5;
    if (category && subcategoryName.includes(String(category).toLowerCase())) s += 3;

    if (need) {
      const needTokens = String(need).toLowerCase().split(/[^a-zá-ú0-9]+/i).filter(Boolean);
      needTokens.forEach(token => {
        if (description.includes(token) || indication.includes(token)) s += 3;
        if (categoryName.includes(token) || subcategoryName.includes(token)) s += 2;
        if (treatmentName.includes(token)) s += 4;
      });
    }

    if (desired_result) {
      const resultTokens = String(desired_result).toLowerCase().split(/[^a-zá-ú0-9]+/i).filter(Boolean);
      resultTokens.forEach(token => {
        if (description.includes(token) || indication.includes(token)) s += 3;
      });
    }

    return s;
  }

  const ranked = (data || []).map(t => ({ t, s: scoreTreatment(t) })).sort((a, b) => b.s - a.s);
  if (!ranked.length || ranked[0].s <= 0) return res.json({ another_treatment_available: false, reason: 'no_match' });

  const top = ranked[0].t;

  if (lead_id && agent) {
    try {
      const { data: fullTreatment, error: treatmentError } = await supa
        .from('treatments')
        .select('*')
        .eq('id', top.id)
        .single();

      const updatedLead = await agentManager.assignDoctorAndAgentToLead(lead_id, fullTreatment, agent);

      return res.json({
        another_treatment_available: true,
        agent_variables: updatedLead.agent_variables || {}
      });
    } catch (assignError) {
      console.error('Error assigning treatment to lead:', assignError);
      return res.json({ another_treatment_available: false, reason: 'assignment_error' });
    }
  }

  res.json({
    another_treatment_available: true,
    treatment: {
      id: top.id,
      name: top.treatment_name,
      category: top.main_category,
      subcategory: top.subcategory,
      description: top.description,
      price: top.single_session_price ? `R$ ${top.single_session_price.toFixed(2).replace('.', ',')}` : 'Consulte',
      duration: `${top.session_duration || 60} minutos`,
      recommended_sessions: top.recommended_sessions,
      primary_benefit: top.primary_benefit
    }
  });
});

r.post('/retell/check-identity', async (req,res)=>{

  if (
    !Retell.verify(
      JSON.stringify(req.body),
      env.RETELL_API_KEY,
      req.headers["x-retell-signature"] || '',
    )
  ) {
    console.error("Invalid signature");
    return;
  }

  const { lead_id, mismatched_reason } = req.body.args || {};
  await supa.from('leads').update({ status: 'divergent' }).eq('id', lead_id);
  res.json({ divergent: true });
});

r.post('/retell/chat-webhook', async (req, res) => {
  if (
    !Retell.verify(
      JSON.stringify(req.body),
      env.RETELL_API_KEY,
      req.headers["x-retell-signature"] || '',
    )
  ) {
    console.error("Invalid chat webhook signature");
    return res.sendStatus(403);
  }

  try {
    const evt = req.body || {};
    const eventType = evt.event || evt.type;
    const chatId = evt.chat_id || evt.chat?.chat_id;

    log.info('Retell chat webhook event:', { eventType, chatId });

    if (!chatId) {
      return res.sendStatus(200);
    }

    const { data: chat, error: chatError } = await supa
      .from('whatsapp_chats')
      .select('*')
      .eq('retell_chat_id', chatId)
      .single();

    if (chatError || !chat) {
      log.warn('Chat not found for webhook event:', { chatId });
      return res.sendStatus(200);
    }

    if (eventType === 'chat_ended' || eventType === 'chat_analyzed') {
      const chatAnalysis = evt.chat_analysis || evt.chat?.chat_analysis || null;
      const chatCost = evt.chat_cost || evt.chat?.chat_cost || null;
      const collectedVariables = evt.collected_variables || evt.chat?.collected_variables || null;

      // Update metadata to mark chat_type as 'followup' for future conversations
      const updatedMetadata = {
        ...(chat.metadata || {}),
        chat_type: 'followup'
      };

      await supa
        .from('whatsapp_chats')
        .update({
          status: 'closed',
          retell_chat_analysis: chatAnalysis,
          retell_chat_cost: chatCost,
          retell_collected_variables: collectedVariables,
          metadata: updatedMetadata,
          updated_at: new Date().toISOString()
        })
        .eq('id', chat.id);

      log.info('Chat ended/analyzed:', {
        chatId: chat.id,
        retellChatId: chatId,
        hasAnalysis: !!chatAnalysis,
        chatType: 'followup'
      });
    }

    if (eventType === 'chat_message') {
      const messageContent = evt.content || evt.message?.content || '';
      const messageRole = evt.role || evt.message?.role || 'agent';
      const messageId = evt.message_id || evt.message?.message_id || null;

      if (messageRole === 'agent' && messageContent && chat.wa_phone) {
        try {
          const { whatsappBusinessService } = await import('../services/whatsappBusiness.js');
          
          const formattedPhone = chat.wa_phone.startsWith('+') ? chat.wa_phone : `+${chat.wa_phone}`;
          
          const sendResult = await whatsappBusinessService.sendTextMessage(
            chat.owner_id,
            formattedPhone,
            messageContent
          );

          await supa
            .from('whatsapp_messages')
            .insert({
              chat_id: chat.id,
              direction: 'outbound',
              sender: 'agent',
              wa_message_id: sendResult?.messageId || null,
              retell_message_id: messageId,
              body: messageContent,
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

          log.info('Agent message sent via webhook:', {
            chatId: chat.id,
            waPhone: chat.wa_phone
          });
        } catch (sendError) {
          log.error('Failed to send agent message via WhatsApp:', sendError.message);
        }
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    log.error('Retell chat webhook error:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'chat webhook error' });
  }
});

r.post('/retell/chat-book-appointment', async (req, res) => {
  if (
    !Retell.verify(
      JSON.stringify(req.body),
      env.RETELL_API_KEY,
      req.headers["x-retell-signature"] || '',
    )
  ) {
    console.error("Invalid chat webhook signature");
    return res.sendStatus(403);
  }
  try {
    const lead_id = req.body?.args?.lead_id || req.body?.lead_id || req.query?.lead_id;
    const appointment_date = req.body?.args?.appointment_date || req.body?.appointment_date || req.query?.appointment_date;
    const appointment_time = req.body?.args?.appointment_time || req.body?.appointment_time || req.query?.appointment_time;

    log.info('[chat-book-appointment] Request received:', { lead_id, appointment_date, appointment_time });

    if (!lead_id) {
      return res.status(400).json({ success: false, error: 'lead_id is required' });
    }

    if (!appointment_date || !appointment_time) {
      return res.status(400).json({ success: false, error: 'appointment_date and appointment_time are required' });
    }

    const { data: lead, error: leadError } = await supa
      .from('leads')
      .select('*')
      .eq('id', lead_id)
      .single();

    if (leadError || !lead) {
      log.error('[chat-book-appointment] Lead not found:', leadError);
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    const ownerId = lead.owner_id;
    const resourceType = lead.assigned_resource_type || 'doctor';
    const resourceId = lead.assigned_resource_id;

    let resourceName = 'nossa equipe';
    let timezone = 'America/Sao_Paulo';
    let durationMinutes = 60;
    let googleCalendarEnabled = false;

    if (resourceType === 'doctor' && resourceId) {
      const { data: doctor } = await supa
        .from('doctors')
        .select('name, timezone, consultation_duration, google_calendar_id, google_refresh_token')
        .eq('id', resourceId)
        .single();

      if (doctor) {
        resourceName = doctor.name;
        timezone = doctor.timezone || timezone;
        durationMinutes = doctor.consultation_duration || durationMinutes;
        googleCalendarEnabled = !!(doctor.google_calendar_id && doctor.google_refresh_token);
      }
    } else if (resourceType === 'treatment' && resourceId) {
      const { data: treatment } = await supa
        .from('treatments')
        .select('treatment_name, session_duration')
        .eq('id', resourceId)
        .single();

      if (treatment) {
        resourceName = treatment.treatment_name || resourceName;
        durationMinutes = treatment.session_duration || durationMinutes;
      }

      const { data: user } = await supa
        .from('users')
        .select('google_calendar_id, google_refresh_token')
        .eq('id', ownerId)
        .single();

      if (user) {
        googleCalendarEnabled = !!(user.google_calendar_id && user.google_refresh_token);
      }
    }

    const { data: ownerData } = await supa
      .from('users')
      .select('name, location')
      .eq('id', ownerId)
      .single();

    const location = ownerData?.location || 'Nossa clínica';

    const normalizedDate = normalizeDateString(appointment_date);
    const timezoneOffsetMap = {
      'America/Sao_Paulo': '-03:00',
      'America/Rio_Branco': '-05:00',
      'America/Manaus': '-04:00',
      'America/Fortaleza': '-03:00',
      'America/Recife': '-03:00'
    };
    const offset = timezoneOffsetMap[timezone] || '-03:00';

    let timeStr = appointment_time;
    if (timeStr && !timeStr.includes(':')) {
      timeStr = timeStr.padStart(4, '0');
      timeStr = `${timeStr.slice(0, 2)}:${timeStr.slice(2)}`;
    }

    const startAt = `${normalizedDate}T${timeStr}:00${offset}`;
    
    // Calculate end time preserving timezone
    const startDate = new Date(startAt);
    const endDate = new Date(startDate.getTime() + durationMinutes * 60000);
    // Format end date with same timezone offset as start
    const endAtISO = endDate.toISOString();
    const endAt = endAtISO.replace('Z', offset);

    const { data: appointmentInsert, error: appointmentError } = await supa
      .from('appointments')
      .insert({
        owner_id: ownerId,
        lead_id: lead.id,
        resource_type: resourceType,
        resource_id: resourceId,
        appointment_type: resourceType === 'treatment' ? 'treatment' : 'consultation',
        start_at: new Date(startAt).toISOString(),
        end_at: new Date(endAt).toISOString(),
        timezone,
        status: 'scheduled',
        office_address: location,
        is_telemedicine: false,
        meeting_link: null
      })
      .select('id')
      .single();

    if (appointmentError) {
      log.error('[chat-book-appointment] Error creating appointment:', appointmentError);
      return res.status(500).json({ success: false, error: 'Failed to create appointment' });
    }

    const appointmentId = appointmentInsert?.id;
    let googleEventId = null;

    if (googleCalendarEnabled && appointmentId) {
      try {
        // Use startAt and endAt directly with timezone offset preserved
        const appointmentData = {
          summary: resourceType === 'treatment'
            ? `Tratamento - ${lead.name || 'Cliente'}`
            : `Consulta - ${lead.name || 'Paciente'}`,
          description: resourceType === 'treatment'
            ? `Tratamento: ${resourceName}\nAgendado via chat`
            : `Consulta com ${resourceName}\nAgendado via chat`,
          start: { dateTime: startAt, timeZone: timezone }, // Use original string with timezone offset
          end: { dateTime: endAt, timeZone: timezone }, // Use formatted string with timezone offset
          location: location || undefined
        };

        log.info('[chat-book-appointment] Creating Google Calendar event:', {
          leadId: lead.id,
          appointmentData,
          resourceId,
          resourceType
        });

        let googleEvent;
        if (resourceType === 'treatment') {
          googleEvent = await googleCalendarService.createTreatmentAppointment(ownerId, appointmentData);
        } else {
          googleEvent = await googleCalendarService.createAppointment(resourceId, appointmentData);
        }

        googleEventId = googleEvent?.id || null;
        if (googleEventId) {
          await supa.from('appointments').update({ gcal_event_id: googleEventId }).eq('id', appointmentId);
        }
      } catch (calendarError) {
        log.warn('[chat-book-appointment] Failed to create Google Calendar event:', calendarError.message);
      }
    }

    await supa.from('leads').update({ status: 'appointment_scheduled', assigned_resource_id: resourceId }).eq('id', lead.id);

    const [year, month, day] = normalizedDate.split('-');
    const confirmedDate = `${day}/${month}/${year}`;
    const confirmedTime = new Date(startAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: timezone });

    log.info('[chat-book-appointment] Appointment created:', { appointmentId, leadId: lead.id, confirmedDate, confirmedTime });

    return res.json({
      success: true,
      appointment_id: appointmentId,
      confirmed_date: confirmedDate,
      confirmed_time: confirmedTime,
      location: location,
      resource_name: resourceName,
      google_event_id: googleEventId
    });
  } catch (error) {
    log.error('[chat-book-appointment] Error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
});

r.post('/retell/chat-reschedule-appointment', async (req, res) => {

  if (
    !Retell.verify(
      JSON.stringify(req.body),
      env.RETELL_API_KEY,
      req.headers["x-retell-signature"] || '',
    )
  ) {
    console.error("Invalid chat webhook signature");
    return res.sendStatus(403);
  }
  try {
    const lead_id = req.body?.args?.lead_id || req.body?.lead_id || req.query?.lead_id;
    const appointment_id = req.body?.args?.appointment_id || req.body?.appointment_id || req.query?.appointment_id;
    const new_date = req.body?.args?.new_date || req.body?.new_date || req.query?.new_date;
    const new_time = req.body?.args?.new_time || req.body?.new_time || req.query?.new_time;

    log.info('[chat-reschedule-appointment] Request received:', { lead_id, appointment_id, new_date, new_time });

    if (!lead_id && !appointment_id) {
      return res.status(400).json({ success: false, error: 'lead_id or appointment_id is required' });
    }

    if (!new_date || !new_time) {
      return res.status(400).json({ success: false, error: 'new_date and new_time are required' });
    }

    let appointment;
    if (appointment_id) {
      const { data } = await supa.from('appointments').select('*').eq('id', appointment_id).single();
      appointment = data;
    }

    if (!appointment && lead_id) {
      const { data } = await supa
        .from('appointments')
        .select('*')
        .eq('lead_id', lead_id)
        .eq('status', 'scheduled')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      appointment = data;
    }

    if (!appointment) {
      return res.status(404).json({ success: false, error: 'No appointment found to reschedule' });
    }

    const ownerId = appointment.owner_id;
    const resourceType = appointment.resource_type;
    const resourceId = appointment.resource_id;
    const timezone = appointment.timezone || 'America/Sao_Paulo';
    
    const originalStartTime = new Date(appointment.start_at);
    const originalEndTime = new Date(appointment.end_at);
    const durationMinutes = Math.round((originalEndTime - originalStartTime) / 60000);

    const normalizedDate = normalizeDateString(new_date);
    const timezoneOffsetMap = {
      'America/Sao_Paulo': '-03:00',
      'America/Rio_Branco': '-05:00',
      'America/Manaus': '-04:00',
      'America/Fortaleza': '-03:00',
      'America/Recife': '-03:00'
    };
    const offset = timezoneOffsetMap[timezone] || '-03:00';

    let timeStr = new_time;
    if (timeStr && !timeStr.includes(':')) {
      timeStr = timeStr.padStart(4, '0');
      timeStr = `${timeStr.slice(0, 2)}:${timeStr.slice(2)}`;
    }

    const newStartAt = `${normalizedDate}T${timeStr}:00${offset}`;
    
    // Calculate end time preserving timezone
    const newStartDate = new Date(newStartAt);
    const newEndDate = new Date(newStartDate.getTime() + durationMinutes * 60000);
    
    // Format end date in the same timezone as start (don't convert to UTC)
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    
    const parts = formatter.formatToParts(newEndDate);
    const endYear = parts.find(p => p.type === 'year').value;
    const endMonth = parts.find(p => p.type === 'month').value;
    const endDay = parts.find(p => p.type === 'day').value;
    const endHour = parts.find(p => p.type === 'hour').value;
    const endMinute = parts.find(p => p.type === 'minute').value;
    const endSecond = parts.find(p => p.type === 'second').value;
    
    const newEndAt = `${endYear}-${endMonth}-${endDay}T${endHour}:${endMinute}:${endSecond}${offset}`;

    const { data: ownerData } = await supa
      .from('users')
      .select('location')
      .eq('id', ownerId)
      .single();

    const finalLocation = ownerData?.location || 'Nossa clínica';

    const { error: updateError } = await supa
      .from('appointments')
      .update({ 
        start_at: new Date(newStartAt).toISOString(), 
        end_at: new Date(newEndAt).toISOString(), 
        office_address: finalLocation,
        updated_at: new Date().toISOString() 
      })
      .eq('id', appointment.id);

    if (updateError) {
      log.error('[chat-reschedule-appointment] Error updating appointment:', updateError);
      return res.status(500).json({ success: false, error: 'Failed to update appointment' });
    }

    if (appointment.gcal_event_id) {
      try {
        const { data: lead } = await supa.from('leads').select('name').eq('id', appointment.lead_id).single();

        let resourceName = 'Consulta';
        if (resourceType === 'doctor' && resourceId) {
          const { data: doctor } = await supa.from('doctors').select('name').eq('id', resourceId).single();
          resourceName = doctor?.name || resourceName;
        } else if (resourceType === 'treatment' && resourceId) {
          const { data: treatment } = await supa.from('treatments').select('treatment_name').eq('id', resourceId).single();
          resourceName = treatment?.treatment_name || resourceName;
        }

        // Use newStartAt and newEndAt directly with timezone offset preserved
        // Note: updateAppointment expects startTime/endTime, not start.dateTime/end.dateTime
        const updateData = {
          title: resourceType === 'treatment' ? `Tratamento - ${lead?.name || 'Cliente'}` : `Consulta - ${lead?.name || 'Paciente'}`,
          description: resourceType === 'treatment' ? `Tratamento: ${resourceName}\nReagendado via chat` : `Consulta com ${resourceName}\nReagendado via chat`,
          startTime: newStartAt, // Use original string with timezone offset
          endTime: newEndAt, // Use formatted string with timezone offset
          timezone: timezone,
          location: finalLocation
        };

        log.info('[chat-reschedule-appointment] Updating Google Calendar event:', {
          appointmentId: appointment.id,
          eventId: appointment.gcal_event_id,
          updateData,
          resourceId,
          resourceType
        });

        if (resourceType === 'treatment') {
          await googleCalendarService.updateTreatmentAppointment(ownerId, appointment.gcal_event_id, updateData);
        } else {
          await googleCalendarService.updateAppointment(resourceId, appointment.gcal_event_id, updateData);
        }
        
        log.info('[chat-reschedule-appointment] Google Calendar event updated successfully:', {
          appointmentId: appointment.id,
          eventId: appointment.gcal_event_id
        });
      } catch (calendarError) {
        log.warn('[chat-reschedule-appointment] Failed to update Google Calendar event:', calendarError.message);
      }
    }

    const [year, month, day] = normalizedDate.split('-');
    const confirmedDate = `${day}/${month}/${year}`;
    const confirmedTime = new Date(newStartAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: timezone });

    log.info('[chat-reschedule-appointment] Appointment rescheduled:', { appointmentId: appointment.id, confirmedDate, confirmedTime });

    return res.json({
      success: true,
      appointment_id: appointment.id,
      confirmed_date: confirmedDate,
      confirmed_time: confirmedTime,
      location: finalLocation
    });
  } catch (error) {
    log.error('[chat-reschedule-appointment] Error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
});

r.post('/retell/chat-cancel-appointment', async (req, res) => {

  if (
    !Retell.verify(
      JSON.stringify(req.body),
      env.RETELL_API_KEY,
      req.headers["x-retell-signature"] || '',
    )
  ) {
    console.error("Invalid chat webhook signature");
    return res.sendStatus(403);
  }
  try {
    const lead_id = req.body?.args?.lead_id || req.body?.lead_id || req.query?.lead_id;
    const appointment_id = req.body?.args?.appointment_id || req.body?.appointment_id || req.query?.appointment_id;

    log.info('[chat-cancel-appointment] Request received:', { lead_id, appointment_id });

    if (!lead_id && !appointment_id) {
      return res.status(400).json({ success: false, error: 'lead_id or appointment_id is required' });
    }

    let appointment;
    if (appointment_id) {
      const { data } = await supa.from('appointments').select('*').eq('id', appointment_id).single();
      appointment = data;
    }

    if (!appointment && lead_id) {
      const { data } = await supa
        .from('appointments')
        .select('*')
        .eq('lead_id', lead_id)
        .eq('status', 'scheduled')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      appointment = data;
    }

    if (!appointment) {
      return res.status(404).json({ success: false, error: 'No appointment found to cancel' });
    }

    const { error: updateError } = await supa
      .from('appointments')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', appointment.id);

    if (updateError) {
      log.error('[chat-cancel-appointment] Error cancelling appointment:', updateError);
      return res.status(500).json({ success: false, error: 'Failed to cancel appointment' });
    }

    if (appointment.gcal_event_id) {
      try {
        const resourceType = appointment.resource_type;
        const resourceId = appointment.resource_id;
        const ownerId = appointment.owner_id;

        if (resourceType === 'treatment') {
          await googleCalendarService.deleteTreatmentAppointment(ownerId, appointment.gcal_event_id);
        } else {
          await googleCalendarService.deleteAppointment(resourceId, appointment.gcal_event_id);
        }
      } catch (calendarError) {
        log.warn('[chat-cancel-appointment] Failed to delete Google Calendar event:', calendarError.message);
      }
    }

    if (appointment.lead_id) {
      await supa.from('leads').update({ status: 'appointment_cancelled' }).eq('id', appointment.lead_id);
    }

    log.info('[chat-cancel-appointment] Appointment cancelled:', { appointmentId: appointment.id, leadId: appointment.lead_id });

    return res.json({ success: true, appointment_id: appointment.id, message: 'Appointment cancelled successfully' });
  } catch (error) {
    log.error('[chat-cancel-appointment] Error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
});

export default r;
