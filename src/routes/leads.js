import { Router } from 'express';
import { supa } from '../lib/supabase.js';
import { log } from '../config/logger.js';
import { agentManager } from '../services/agentManager.js';
import { getNowInSaoPaulo, getIsoStringNow, toIsoStringSaoPaulo } from '../utils/timezone.js';
import { verifyApiToken } from '../middleware/verifyApiToken.js';
import { verifyApiTokenFlexible } from '../middleware/verifyApiTokenFlexible.js';
import { normalizePhoneNumber } from '../lib/retell.js';

const router = Router();

router.post('/lead/submit', verifyApiToken, async (req, res) => {
  try {
    const authenticatedOwnerId = req.user.id;

    const {
      name,
      phone,
      email,
      city,
      specialty,
      reason,
      whatsapp,
      preferred_channel = 'call',
      preferred_language = 'Português',
      timezone = 'America/Sao_Paulo',
      source,
      campaign,
      utm_source,
      utm_medium,
      utm_campaign,
      notes,
      custom_fields = {},
      test_mode = false
    } = req.body;

    // Validation
    if (!name || !phone) {
      return res.status(400).json({
        ok: false,
        error: 'Name and phone are required'
      });
    }

    // Normalize phone number (handles Brazilian format and converts to E.164)
    let cleanPhone;
    try {
      cleanPhone = normalizePhoneNumber(phone);
    } catch (error) {
      log.warn(`Phone number normalization failed for ${phone}:`, error.message);
      return res.status(400).json({
        ok: false,
        error: `Invalid phone number format: ${error.message}`
      });
    }

    // Check for duplicate leads (same phone number in last 24 hours)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    // const { data: existingLead } = await supa
    //   .from('leads')
    //   .select('id, name, phone, created_at')
    //   .eq('phone', cleanPhone)
    //   .gte('created_at', yesterday.toISOString())
    //   .order('created_at', { ascending: false })
    //   .limit(1)
    //   .single();

    // if (existingLead) {
    //   log.info(`Duplicate lead detected: ${existingLead.id} for phone ${cleanPhone}`);
    //   return res.status(409).json({
    //     ok: false,
    //     error: 'A lead with this phone number was already submitted recently',
    //     existing_lead_id: existingLead.id
    //   });
    // }

    const { data: newLead, error: leadError } = await supa
      .from('leads')
      .insert({
        owner_id: authenticatedOwnerId,
        name: name.trim(),
        phone: cleanPhone,
        email: email?.trim(),
        city: city?.trim(),
        specialty: specialty?.trim(),
        reason: reason?.trim(),
        whatsapp: whatsapp?.trim(),     
        preferred_channel,
        preferred_language,
        timezone,
        source,
        campaign,
        utm_source,
        utm_medium,
        utm_campaign,
        notes,
        custom_fields,
        status: 'new',
      })
      .select()
      .single();

    if (leadError) {
      log.error('Lead creation error:', leadError);
      return res.status(500).json({
        ok: false,
        error: 'Failed to create lead'
      });
    }

    log.info(`Lead created: ${newLead.id} - ${name} (${cleanPhone})`);

    try {
      let assignment;
      
      // Find appropriate doctor and agent based on owner_id
      // Pass test_mode to allow inactive agents for testing
      assignment = await agentManager.findDoctorAndAgentForLead(newLead, { testMode: test_mode });
      
      // Assign doctor and agent to lead
      const updatedLead = await agentManager.assignDoctorAndAgentToLead(
        newLead.id,
        assignment.doctor,
        assignment.agent
      );

      // Attempt immediate outbound call
      try {
        const callResponse = await agentManager.makeOutboundCall(updatedLead);
        
        // Determine service type from owner
        const { data: ownerInfo } = await supa
          .from('users')
          .select('service_type')
          .eq('id', assignment.doctor.owner_id)
          .single();
        
        const isBeautyClinic = ownerInfo?.service_type === 'beauty_clinic';
        const resourceType = isBeautyClinic ? 'treatment' : 'doctor';
        
        // Record call attempt with polymorphic resource support
        await supa
          .from('call_attempts')
          .insert({
            lead_id: newLead.id,
            doctor_id: isBeautyClinic ? null : assignment.doctor.id, // For medical clinic
            agent_id: assignment.agent.id,
            owner_id: assignment.doctor.owner_id,
            resource_type: resourceType, // 'doctor' or 'treatment'
            resource_id: assignment.doctor.id, // Treatment ID for beauty, Doctor ID for medical
            direction: 'outbound',
            attempt_no: 1,
            scheduled_at: getIsoStringNow(),
            started_at: getIsoStringNow(),
            retell_call_id: callResponse.call_id,
            meta: {
              agent_assignment: {
                resource_type: resourceType,
                resource_id: assignment.doctor.id,
                resource_name: assignment.doctor.name,
                resource_specialty: assignment.doctor.specialty,
                agent_id: assignment.agent.id,
                agent_name: assignment.agent.name,
                business_owner: assignment.doctor.owner_id
              }
            }
          });

        log.info(`Outbound call initiated for lead ${newLead.id}: ${callResponse.call_id}`);

        return res.status(201).json({
          ok: true,
          message: 'Lead submitted successfully and call initiated',
          lead: {
            id: newLead.id,
            name: newLead.name,
            phone: newLead.phone,
            status: newLead.status,
            assigned_to: {
              resource_type: resourceType,
              resource_name: assignment.doctor.name,
              resource_specialty: assignment.doctor.specialty || assignment.doctor.main_category,
              agent_name: assignment.agent.name,
              business_owner: assignment.doctor.owner_id
            }
          },
          call: {
            call_id: callResponse.call_id,
            status: 'initiated'
          }
        });

      } catch (callError) {
        log.error(`Failed to initiate call for lead ${newLead.id}:`, callError);
        
        // Update lead status to indicate call failure
        await supa
          .from('leads')
          .update({ 
            status: 'call_failed',
            next_retry_at: new Date(getNowInSaoPaulo().getTime() + 15 * 60 * 1000).toISOString() // Retry in 15 minutes
          })
          .eq('id', newLead.id);

        // Determine service type from owner for error response
        const { data: ownerInfoForError } = await supa
          .from('users')
          .select('service_type')
          .eq('id', assignment.doctor.owner_id)
          .single();
        const isBeautyClinicError = ownerInfoForError?.service_type === 'beauty_clinic';
        const resourceTypeError = isBeautyClinicError ? 'treatment' : 'doctor';

        return res.status(201).json({
          ok: true,
          message: 'Lead submitted successfully but call initiation failed',
          lead: {
            id: newLead.id,
            name: newLead.name,
            phone: newLead.phone,
            status: 'call_failed',
            assigned_to: {
              resource_type: resourceTypeError,
              resource_name: assignment.doctor.name,
              resource_specialty: assignment.doctor.specialty || assignment.doctor.main_category,
              agent_name: assignment.agent.name,
              business_owner: assignment.doctor.owner_id
            }
          },
          error: 'Call initiation failed - will retry later'
        });
      }

    } catch (assignmentError) {
      log.error(`Failed to assign doctor/agent for lead ${newLead.id}:`, assignmentError);
      
      // Update lead status to indicate assignment failure
      await supa
        .from('leads')
        .update({ 
          status: 'assignment_failed',
            next_retry_at: toIsoStringSaoPaulo(new Date(getNowInSaoPaulo().getTime() + 30 * 60 * 1000)) // Retry in 30 minutes (São Paulo timezone)
        })
        .eq('id', newLead.id);

      return res.status(201).json({
        ok: true,
        message: 'Lead submitted but doctor/agent assignment failed',
        lead: {
          id: newLead.id,
          name: newLead.name,
          phone: newLead.phone,
          status: 'assignment_failed'
        },
        error: 'No available doctor/agent for this specialty - will retry later'
      });
    }

  } catch (error) {
    log.error('Lead submission error:', error);
    res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });
  }
});

router.post('/lead/submit/webhook', verifyApiTokenFlexible, async (req, res) => {
  try {
    const authenticatedOwnerId = req.user.id;
    const serviceType = req.user.service_type; // 'clinic' or 'beauty_clinic'

    log.info('Webhook lead submission received from owner:', authenticatedOwnerId);

    // Get owner info to determine service type if not in user object
    let ownerServiceType = serviceType;
    if (!ownerServiceType) {
      const { data: ownerInfo } = await supa
        .from('users')
        .select('service_type')
        .eq('id', authenticatedOwnerId)
        .single();
      ownerServiceType = ownerInfo?.service_type;
    }

    const isClinic = ownerServiceType === 'clinic';
    const isBeautyClinic = ownerServiceType === 'beauty_clinic';

    // Parse incoming data - handle different webhook formats
    let parsedData = {};
    
    // Detect source format
    if (req.body.form_response && req.body.event_type === 'form_response') {
      // Typeform format
      parsedData = parseTypeformWebhook(req.body);
      parsedData.source = 'typeform';
      log.info('Parsed Typeform webhook:', parsedData);
    } else if (req.body.leads || req.body.lead) {
      // RD Station format (typically sends leads array or lead object)
      parsedData = parseRDStationWebhook(req.body);
      parsedData.source = 'rd_station';
      log.info('Parsed RD Station webhook:', parsedData);
    } else {
      // Standard format (Google Forms via Apps Script, custom webhooks, direct API calls)
      parsedData = req.body;
      parsedData.source = parsedData.source || 'webhook';
      log.info('Standard webhook format:', parsedData);
    }

    // Extract fields - support both camelCase and snake_case
    const {
      name,
      first_name,
      last_name,
      email,
      whatsapp_number,
      phone,
      phone_number,
      city,
      specialty,
      reason,
      treatment_name,
      preferred_channel = 'call',
      preferred_language = 'Português',
      timezone = 'America/Sao_Paulo',
      source,
      campaign,
      utm_source,
      utm_medium,
      utm_campaign,
      notes,
      custom_fields = {}
    } = parsedData;

    // Combine name fields if separate
    let fullName = name;
    if (!fullName && (first_name || last_name)) {
      fullName = [first_name, last_name].filter(Boolean).join(' ');
    }

    // Validation
    if (!fullName) {
      log.warn('Webhook rejected: No name provided');
      return res.status(400).json({
        ok: false,
        error: 'Name is required'
      });
    }

    // Phone number is required - use whatsapp_number, phone, or phone_number
    const phoneNumber = whatsapp_number || phone || phone_number;
    if (!phoneNumber) {
      log.warn('Webhook rejected: No phone number provided');
      return res.status(400).json({
        ok: false,
        error: 'Phone number (whatsapp_number, phone, or phone_number) is required'
      });
    }

    // Service-specific validation (optional for webhooks - some forms may not capture all fields)
    // We'll log warnings but not reject the request
    if (isClinic && !specialty) {
      log.warn('Medical clinic webhook missing specialty field');
    }
    if (isBeautyClinic && !treatment_name) {
      log.warn('Beauty clinic webhook missing treatment_name field');
    }

    // Normalize phone number (handles Brazilian format and converts to E.164)
    let cleanPhone;
    try {
      cleanPhone = normalizePhoneNumber(phoneNumber);
    } catch (error) {
      log.warn(`Phone number normalization failed for ${phoneNumber}:`, error.message);
      return res.status(400).json({
        ok: false,
        error: `Invalid phone number format: ${error.message}`
      });
    }

    // Prepare lead data
    const leadData = {
      owner_id: authenticatedOwnerId,
      name: fullName.trim(),
      phone: cleanPhone,
      email: email?.trim(),
      city: city?.trim(),
      specialty: specialty?.trim(),
      reason: reason?.trim(),
      whatsapp: cleanPhone, // Use same phone for WhatsApp
      preferred_channel,
      preferred_language,
      timezone,
      source: source || 'webhook',
      campaign,
      utm_source,
      utm_medium,
      utm_campaign,
      notes,
      custom_fields,
      status: 'new',
    };

    // Add service-specific fields
    if (isClinic) {
      leadData.specialty = specialty?.trim();
      leadData.reason = reason?.trim();
    } else if (isBeautyClinic) {
      leadData.specialty = treatment_name?.trim();
    }

    // Create lead
    const { data: newLead, error: leadError } = await supa
      .from('leads')
      .insert(leadData)
      .select()
      .single();

    if (leadError) {
      log.error('Webhook lead creation error:', leadError);
      return res.status(500).json({
        ok: false,
        error: 'Failed to create lead',
        details: leadError.message
      });
    }

    log.info(`Webhook lead created: ${newLead.id} - ${fullName} (${cleanPhone}) from ${source || 'webhook'}`);

    // Assign doctor/treatment and agent, then initiate call
    try {
      let assignment;
      
      assignment = await agentManager.findDoctorAndAgentForLead(newLead);
      
      const updatedLead = await agentManager.assignDoctorAndAgentToLead(
        newLead.id,
        assignment.doctor,
        assignment.agent
      );

      // Attempt immediate outbound call
      try {
        const callResponse = await agentManager.makeOutboundCall(updatedLead);
        
        const { data: ownerInfo } = await supa
          .from('users')
          .select('service_type')
          .eq('id', assignment.doctor.owner_id)
          .single();
        
        const isBeautyClinicCall = ownerInfo?.service_type === 'beauty_clinic';
        const resourceType = isBeautyClinicCall ? 'treatment' : 'doctor';
        
        await supa
          .from('call_attempts')
          .insert({
            lead_id: newLead.id,
            doctor_id: isBeautyClinicCall ? null : assignment.doctor.id,
            agent_id: assignment.agent.id,
            owner_id: assignment.doctor.owner_id,
            resource_type: resourceType,
            resource_id: assignment.doctor.id,
            direction: 'outbound',
            attempt_no: 1,
            scheduled_at: getIsoStringNow(),
            started_at: getIsoStringNow(),
            retell_call_id: callResponse.call_id,
            meta: {
              source: source || 'webhook',
              agent_assignment: {
                resource_type: resourceType,
                resource_id: assignment.doctor.id,
                resource_name: assignment.doctor.name,
                resource_specialty: assignment.doctor.specialty || assignment.doctor.main_category,
                agent_id: assignment.agent.id,
                agent_name: assignment.agent.name,
                business_owner: assignment.doctor.owner_id
              }
            }
          });

        log.info(`Webhook outbound call initiated for lead ${newLead.id}: ${callResponse.call_id}`);

        return res.status(200).json({
          ok: true,
          message: 'Lead submitted successfully and call initiated'
        });

      } catch (callError) {
        log.error(`Failed to initiate webhook call for lead ${newLead.id}:`, callError);
        
        await supa
          .from('leads')
          .update({ 
            status: 'call_failed',
            next_retry_at: new Date(getNowInSaoPaulo().getTime() + 15 * 60 * 1000).toISOString()
          })
          .eq('id', newLead.id);

        return res.status(201).json({
          ok: true,
          message: 'Lead submitted successfully but call initiation failed'
        });
      }

    } catch (assignmentError) {
      log.error(`Failed to assign doctor/agent for webhook lead ${newLead.id}:`, assignmentError);
      
      await supa
        .from('leads')
        .update({ 
          status: 'assignment_failed',
          next_retry_at: new Date(getNowInSaoPaulo().getTime() + 30 * 60 * 1000).toISOString()
        })
        .eq('id', newLead.id);

      return res.status(201).json({
        ok: true,
        message: 'Lead submitted but doctor/agent assignment failed'
      });
    }

  } catch (error) {
    log.error('Webhook lead submission error:', error);
    res.status(500).json({
      ok: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

/**
 * Parse Typeform webhook payload into standard lead format
 * @param {Object} typeformPayload - The Typeform webhook payload
 * @returns {Object} Parsed lead data
 */
function parseTypeformWebhook(typeformPayload) {
  const result = {};
  const formResponse = typeformPayload.form_response;
  
  if (!formResponse || !formResponse.answers) {
    return result;
  }

  const answers = formResponse.answers;
  const definition = formResponse.definition;

  // Create a map of field IDs to titles for easier lookup
  const fieldMap = {};
  if (definition && definition.fields) {
    definition.fields.forEach(field => {
      // Trim and lowercase for consistent matching
      fieldMap[field.id] = field.title.toLowerCase().trim();
    });
  }

  // Process each answer
  answers.forEach(answer => {
    const fieldId = answer.field?.id;
    const fieldTitle = fieldMap[fieldId] || '';
    
    // Extract the value based on answer type
    let value = null;
    switch (answer.type) {
      case 'text':
        value = answer.text;
        break;
      case 'email':
        value = answer.email;
        break;
      case 'phone_number':
        value = answer.phone_number;
        break;
      case 'choice':
        value = answer.choice?.label;
        break;
      case 'number':
        value = answer.number;
        break;
      case 'date':
        value = answer.date;
        break;
      default:
        value = answer.text || answer.choice?.label || null;
    }

    if (!value) return;

    // Map to standard fields based on field title
    // Name fields
    if (fieldTitle.includes('first') && fieldTitle.includes('name') || 
        fieldTitle.includes('primeiro') && fieldTitle.includes('nome') ||
        fieldTitle === 'first name' || fieldTitle === 'primeiro nome') {
      result.first_name = value;
    }
    else if (fieldTitle.includes('last') && fieldTitle.includes('name') || 
             fieldTitle.includes('sobrenome') || fieldTitle.includes('último nome') ||
             fieldTitle === 'last name') {
      result.last_name = value;
    }
    else if (fieldTitle.includes('name') || fieldTitle.includes('nome')) {
      // Full name or just "name"
      if (result.first_name) {
        // If first_name already set, this might be last name
        result.last_name = value;
      } else {
        result.name = value;
      }
    }
    // Email
    else if (fieldTitle.includes('email') || fieldTitle.includes('e-mail')) {
      result.email = value;
    }
    // Phone
    else if (fieldTitle.includes('phone') || fieldTitle.includes('telefone') || 
             fieldTitle.includes('whatsapp') || fieldTitle.includes('celular') ||
             fieldTitle.includes('número')) {
      result.phone_number = value;
    }
    // City
    else if (fieldTitle.includes('city') || fieldTitle.includes('cidade')) {
      result.city = value;
    }
    // Specialty (for medical clinic)
    else if (fieldTitle.includes('specialty') || fieldTitle.includes('especialidade') ||
             fieldTitle.includes('médico') || fieldTitle.includes('doctor')) {
      result.specialty = value;
    }
    // Reason (for medical clinic)
    else if (fieldTitle.includes('reason') || fieldTitle.includes('razão') || 
             fieldTitle.includes('motivo') || fieldTitle.includes('porque')) {
      result.reason = value;
    }
    // Treatment (for beauty clinic)
    else if (fieldTitle.includes('treatment') || fieldTitle.includes('tratamento') ||
             fieldTitle.includes('procedimento') || fieldTitle.includes('serviço')) {
      result.treatment_name = value;
    }
  });

  // Combine first and last name if we have both
  if (result.first_name && result.last_name && !result.name) {
    result.name = `${result.first_name} ${result.last_name}`;
  } else if (result.first_name && !result.name) {
    result.name = result.first_name;
  }

  return result;
}

/**
 * Parse RD Station webhook payload into standard lead format
 * @param {Object} rdStationPayload - The RD Station webhook payload
 * @returns {Object} Parsed lead data
 */
function parseRDStationWebhook(rdStationPayload) {
  const lead = rdStationPayload.lead || rdStationPayload.leads?.[0] || rdStationPayload;
  
  return {
    name: lead.name || `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
    email: lead.email,
    phone_number: lead.mobile_phone || lead.personal_phone || lead.phone,
    city: lead.city,
    specialty: lead.specialty || lead.custom_fields?.specialty,
    reason: lead.reason || lead.custom_fields?.reason,
    treatment_name: lead.treatment_name || lead.custom_fields?.treatment_name,
    utm_source: lead.utm_source || lead.first_conversion?.source,
    utm_medium: lead.utm_medium || lead.first_conversion?.medium,
    utm_campaign: lead.utm_campaign || lead.first_conversion?.campaign,
    campaign: lead.origin || lead.last_conversion?.content
  };
}

router.post('/lead/demo', verifyApiToken, async (req, res) => {
  try {
    const ownerId = req.user.id;
    const { name, phone, email } = req.body;

    if (!name || !phone) {
      return res.status(400).json({
        ok: false,
        error: 'Name and phone are required'
      });
    }

    // Normalize phone number (handles Brazilian format and converts to E.164)
    let cleanPhone;
    try {
      cleanPhone = normalizePhoneNumber(phone);
    } catch (error) {
      log.warn(`Phone number normalization failed for ${phone}:`, error.message);
      return res.status(400).json({
        ok: false,
        error: `Invalid phone number format: ${error.message}`
      });
    }

    const { data: newLead, error: leadError } = await supa
      .from('leads')
      .insert({
        owner_id: ownerId,
        name: name.trim(),
        phone: cleanPhone,
        email: email?.trim(),
        source: 'website_demo',
        status: 'new',
      })
      .select()
      .single();

    if (leadError) {
      log.error('Demo lead creation error:', leadError);
      return res.status(500).json({
        ok: false,
        error: 'Failed to create lead'
      });
    }

    log.info(`Demo lead created: ${newLead.id} - ${name} (${cleanPhone})`);

    try {
      const assignment = await agentManager.findDoctorAndAgentForLead(newLead);
      
      const updatedLead = await agentManager.assignDoctorAndAgentToLead(
        newLead.id,
        assignment.doctor,
        assignment.agent
      );

      try {
        const callResponse = await agentManager.makeOutboundCall(updatedLead);
        
        await supa
          .from('call_attempts')
          .insert({
            lead_id: newLead.id,
            agent_id: assignment.agent.id,
            owner_id: ownerId,
            direction: 'outbound',
            attempt_no: 1,
            scheduled_at: getIsoStringNow(),
            started_at: getIsoStringNow(),
            retell_call_id: callResponse.call_id,
            meta: {
              source: 'website_demo'
            }
          });

        log.info(`Demo call initiated for lead ${newLead.id}: ${callResponse.call_id}`);

        return res.status(201).json({
          ok: true,
          message: 'Demo call initiated successfully',
          lead_id: newLead.id,
          call_id: callResponse.call_id
        });

      } catch (callError) {
        log.error(`Failed to initiate demo call for lead ${newLead.id}:`, callError);
        
        await supa
          .from('leads')
          .update({ 
            status: 'call_failed',
            next_retry_at: new Date(getNowInSaoPaulo().getTime() + 15 * 60 * 1000).toISOString()
          })
          .eq('id', newLead.id);

        return res.status(201).json({
          ok: true,
          message: 'Lead created but call initiation failed',
          lead_id: newLead.id,
          error: 'Call initiation failed - will retry later'
        });
      }

    } catch (assignmentError) {
      log.error(`Failed to assign agent for demo lead ${newLead.id}:`, assignmentError);
      
      await supa
        .from('leads')
        .update({ 
          status: 'assignment_failed',
          next_retry_at: new Date(getNowInSaoPaulo().getTime() + 30 * 60 * 1000).toISOString()
        })
        .eq('id', newLead.id);

      return res.status(201).json({
        ok: true,
        message: 'Lead created but agent assignment failed',
        lead_id: newLead.id,
        error: 'No available agent - will retry later'
      });
    }

  } catch (error) {
    log.error('Demo lead submission error:', error);
    res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });
  }
});

// Get Lead Status
router.get('/lead/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: lead, error } = await supa
      .from('leads')
      .select(`
        *,
        agents(id, name),
        doctors(id, name, specialty),
        users(id, name),
        call_attempts(
          id,
          attempt_no,
          started_at,
          ended_at,
          outcome,
          disposition,
          retell_call_id,
          duration_seconds
        )
      `)
      .eq('id', id)
      .single();

    if (error || !lead) {
      return res.status(404).json({
        ok: false,
        error: 'Lead not found'
      });
    }

    res.json({
      ok: true,
      lead
    });

  } catch (error) {
    log.error('Lead retrieval error:', error);
    res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });
  }
});

// Get Leads for a Business Owner
router.get('/leads/owner/:ownerId', async (req, res) => {
  try {
    const { ownerId } = req.params;
    const { page = 1, limit = 20, status, doctor_id, specialty, source } = req.query;

    const offset = (page - 1) * limit;

    let query = supa
      .from('leads')
      .select(`
        *,
        agents(id, name),
        doctors(id, name, specialty),
        call_attempts(
          id,
          attempt_no,
          started_at,
          ended_at,
          outcome,
          disposition
        )
      `)
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Apply filters
    if (status) query = query.eq('status', status);
    if (doctor_id) query = query.eq('assigned_doctor_id', doctor_id);
    if (specialty) query = query.eq('specialty', specialty);
    if (source) query = query.eq('source', source);

    const { data: leads, error } = await query;

    if (error) {
      log.error('Leads retrieval error:', error);
      return res.status(500).json({
        ok: false,
        error: 'Failed to retrieve leads'
      });
    }

    // Get total count
    let countQuery = supa
      .from('leads')
      .select('id', { count: 'exact' })
      .eq('owner_id', ownerId);

    if (status) countQuery = countQuery.eq('status', status);
    if (doctor_id) countQuery = countQuery.eq('assigned_doctor_id', doctor_id);
    if (specialty) countQuery = countQuery.eq('specialty', specialty);
    if (source) countQuery = countQuery.eq('source', source);

    const { count } = await countQuery;

    res.json({
      ok: true,
      leads: leads || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        total_pages: Math.ceil((count || 0) / limit)
      }
    });

  } catch (error) {
    log.error('Owner leads retrieval error:', error);
    res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });
  }
});

// Get Leads for a Specific Doctor
router.get('/leads/doctor/:doctorId', async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { page = 1, limit = 20, status } = req.query;

    const offset = (page - 1) * limit;

    let query = supa
      .from('leads')
      .select(`
        *,
        agents(id, name),
        call_attempts(
          id,
          attempt_no,
          started_at,
          ended_at,
          outcome,
          disposition
        )
      `)
      .eq('assigned_doctor_id', doctorId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) {
      query = query.eq('status', status);
    }

    const { data: leads, error } = await query;

    if (error) {
      log.error('Doctor leads retrieval error:', error);
      return res.status(500).json({
        ok: false,
        error: 'Failed to retrieve leads'
      });
    }

    // Get total count
    let countQuery = supa
      .from('leads')
      .select('id', { count: 'exact' })
      .eq('assigned_doctor_id', doctorId);

    if (status) {
      countQuery = countQuery.eq('status', status);
    }

    const { count } = await countQuery;

    res.json({
      ok: true,
      leads: leads || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        total_pages: Math.ceil((count || 0) / limit)
      }
    });

  } catch (error) {
    log.error('Doctor leads retrieval error:', error);
    res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });
  }
});

// Retry Lead Call
router.post('/lead/:id/retry', async (req, res) => {
  try {
    const { id } = req.params;

    // Get lead with assignment
    const { data: lead, error: leadError } = await supa
      .from('leads')
      .select('*')
      .eq('id', id)
      .single();

    if (leadError || !lead) {
      return res.status(404).json({
        ok: false,
        error: 'Lead not found'
      });
    }

    if (!lead.assigned_agent_id || !lead.assigned_doctor_id) {
      // Try to assign doctor and agent first
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
      } catch (assignmentError) {
        return res.status(400).json({
          ok: false,
          error: 'No available doctor/agent for this lead'
        });
      }
    }

    // Get current attempt number
    const { data: attempts } = await supa
      .from('call_attempts')
      .select('attempt_no')
      .eq('lead_id', id)
      .order('attempt_no', { ascending: false })
      .limit(1);

    const nextAttemptNo = (attempts?.[0]?.attempt_no || 0) + 1;

    if (nextAttemptNo > (lead.max_attempts || 3)) {
      return res.status(400).json({
        ok: false,
        error: 'Maximum retry attempts reached'
      });
    }

    // Make the call
    try {
      const callResponse = await agentManager.makeOutboundCall(lead);
      
      // Record call attempt
      await supa
        .from('call_attempts')
        .insert({
          lead_id: id,
          doctor_id: lead.assigned_doctor_id,
          agent_id: lead.assigned_agent_id,
          owner_id: lead.owner_id,
          direction: 'outbound',
          attempt_no: nextAttemptNo,
          scheduled_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          retell_call_id: callResponse.call_id
        });

      // Update lead status
      await supa
        .from('leads')
        .update({ 
          status: 'calling',
          next_retry_at: null
        })
        .eq('id', id);

      res.json({
        ok: true,
        message: 'Retry call initiated successfully',
        call: {
          call_id: callResponse.call_id,
          attempt_no: nextAttemptNo
        }
      });

    } catch (callError) {
      log.error(`Retry call failed for lead ${id}:`, callError);
      res.status(500).json({
        ok: false,
        error: 'Failed to initiate retry call'
      });
    }

  } catch (error) {
    log.error('Lead retry error:', error);
    res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });
  }
});

// Update Lead
router.put('/lead/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Remove sensitive fields that shouldn't be updated directly
    delete updates.id;
    delete updates.owner_id;
    delete updates.created_at;

    // Update lead
    const { data: updatedLead, error } = await supa
      .from('leads')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      log.error('Lead update error:', error);
      return res.status(500).json({
        ok: false,
        error: 'Failed to update lead'
      });
    }

    if (!updatedLead) {
      return res.status(404).json({
        ok: false,
        error: 'Lead not found'
      });
    }

    res.json({
      ok: true,
      message: 'Lead updated successfully',
      lead: updatedLead
    });

  } catch (error) {
    log.error('Lead update error:', error);
    res.status(500).json({
      ok: false,
      error: 'Internal server error'
    });
  }
});

// Lead Analytics for Business Owner
router.get('/analytics/leads/:ownerId', async (req, res) => {
  try {
    const { ownerId } = req.params;
    const { timeframe = '30d' } = req.query;

    // Calculate date filter
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

    // Get leads for the timeframe
    const { data: leads, error } = await supa
      .from('leads')
      .select(`
        *,
        call_attempts(outcome, disposition)
      `)
      .eq('owner_id', ownerId)
      .gte('created_at', dateFilter.toISOString());

    if (error) {
      throw error;
    }

    // Calculate analytics
    const analytics = {
      total_leads: leads?.length || 0,
      by_status: {},
      by_specialty: {},
      by_source: {},
      by_outcome: {},
      conversion_rate: 0,
      average_response_time: 0
    };

    // Group data
    leads?.forEach(lead => {
      // By status
      analytics.by_status[lead.status] = (analytics.by_status[lead.status] || 0) + 1;
      
      // By specialty
      if (lead.specialty) {
        analytics.by_specialty[lead.specialty] = (analytics.by_specialty[lead.specialty] || 0) + 1;
      }
      
      // By source
      if (lead.source) {
        analytics.by_source[lead.source] = (analytics.by_source[lead.source] || 0) + 1;
      }

      // By call outcomes
      lead.call_attempts?.forEach(attempt => {
        if (attempt.outcome) {
          analytics.by_outcome[attempt.outcome] = (analytics.by_outcome[attempt.outcome] || 0) + 1;
        }
      });
    });

    // Calculate conversion rate (completed calls / total leads)
    const completedCalls = analytics.by_outcome.completed || 0;
    analytics.conversion_rate = analytics.total_leads > 0 
      ? Math.round((completedCalls / analytics.total_leads) * 100) 
      : 0;

    res.json({
      ok: true,
      analytics,
      timeframe
    });

  } catch (error) {
    log.error('Lead analytics error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to fetch lead analytics'
    });
  }
});

export default router; 