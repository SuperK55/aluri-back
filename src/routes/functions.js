import { Router } from 'express';
import { bookAppointment } from '../services/appointments.js';
import { supa } from '../lib/supabase.js';
import { env } from '../config/env.js';
import Retell from 'retell-sdk';
import { agentManager } from '../services/agentManager.js';

const r = Router();
const client = new Retell({
  apiKey: env.RETELL_API_KEY
});

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

r.get('/fn/get-conversation-flow', async (req, res) => {
  try {
    // Validate required environment variables
    if (!env.RETELL_API_KEY) {
      return res.status(500).json({ error: 'RETELL_API_KEY not configured' });
    }

    const conversationFlowResponse = await client.conversationFlow.retrieve("conversation_flow_6d07157731f7");
    res.json(conversationFlowResponse);
  } catch (error) {
    console.error('Error retrieving conversation flow:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve conversation flow', 
      details: error.message 
    });
  }
});

r.get('/fn/get-agent-out', async (req, res) => {
  const agentResponse = await client.agent.retrieve("agent_7df541e206b5f77698b97f3735");
  // const agentResponse = await client.chatAgent.retrieve("agent_7df541e206b5f77698b97f3735");
  res.json(agentResponse);
});

r.post('/fn/create-conversation-flow', async (req,res)=>{
  const conversation_flow = req.body || {};
  const response = await client.conversationFlow.create(
    conversation_flow
  );
  res.json(response?.conversation_flow_id);
});

r.post('/fn/create-agent', async (req,res)=>{
  const agent = req.body || {};
  const response = await client.agent.create(
    agent
  );
  res.json(response?.agent_id);
});

r.post('/fn/book-appointment', async (req,res)=>{
  const { doctor_id, start, duration_min, timezone } = req.body.args || {};
  if(!start) return res.status(400).json({ error:'start required' });
  let doctorName = '';
  if (doctor_id) {
    const { data } = await supa.from('doctors').select('name').eq('id', doctor_id).limit(1);
    doctorName = data?.[0]?.name || '';
  }
  const ev = await bookAppointment({ start, durationMin: duration_min, timezone, doctorName });
  res.json({ ok:true, gcal_event_id: ev.id, gcal_link: ev.htmlLink });
});

r.post('/fn/set-communication-preference', async (req,res)=>{
  const { lead_id, preferred_channel } = req.body || {};
  if(!lead_id || !preferred_channel) return res.status(400).json({ error:'lead_id and preferred_channel required' });
  await supa.from('leads').update({ preferred_channel }).eq('id', lead_id);
  res.json({ ok:true });
});

r.post('/fn/schedule-call', async (req,res)=>{
  const { lead_id, when_iso } = req.body.args || {};
  // if(!lead_id || !when_iso) return res.status(400).json({ error:'lead_id and when_iso required' });
  // await supa.from('leads').update({ status:'reschedule', next_retry_at: when_iso }).eq('id', lead_id);
  res.json({ ok:true });
});

r.post('/fn/check-specialty', async (req, res) => {

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
    // According to Retell docs: Request body contains: { name, call, args }
    const specialty = req.body?.args?.specialty || req.body?.specialty || req.query?.specialty;
    const lead_id = req.body?.args?.lead_id || req.body?.lead_id || req.query?.lead_id;
    
    console.log('[check-specialty] Request received:', { 
      specialty, 
      lead_id,
      query: req.query,
      'body.args': req.body?.args,
      'function_name': req.body?.name
    });
    
    if (!specialty) {
      return res.status(400).json({ 
        available: false, 
        ok: false, 
        error: 'specialty is required' 
      });
    }

    // Get owner_id from lead if lead_id is provided
    let ownerId = null;
    if (lead_id) {
      const { data: lead, error: leadError } = await supa
        .from('leads')
        .select('owner_id')
        .eq('id', lead_id)
        .single();
      
      if (!leadError && lead) {
        ownerId = lead.owner_id;
      }
    }

    // Search for doctors with matching specialty
    let query = supa
      .from('doctors')
      .select('id, name, specialty')
      .eq('is_active', true);
    
    // Filter by owner if lead_id was provided
    if (ownerId) {
      query = query.eq('owner_id', ownerId);
    }
    
    const { data: doctors, error } = await query;
    
    if (error) {
      console.error('[check-specialty] Database error:', error);
      return res.status(500).json({ 
        available: false, 
        ok: false, 
        error: 'Database error' 
      });
    }

    // Check if any doctor has the requested specialty (case-insensitive partial match)
    const specialtyLower = String(specialty).toLowerCase();
    const hasSpecialty = (doctors || []).some(doc => {
      const docSpecialty = (doc.specialty || '').toLowerCase();
      return docSpecialty.includes(specialtyLower) || specialtyLower.includes(docSpecialty);
    });

    res.json({ 
      available: hasSpecialty,
      ok: true,
      specialty: specialty
    });
  } catch (error) {
    console.error('[check-specialty] Error:', error);
    res.status(500).json({ 
      available: false, 
      ok: false, 
      error: error.message 
    });
  }
});

// Beauty Clinic Functions
r.post('/fn/recommend_treatment', async (req,res)=>{
  const { need, desired_result, treatment_category } = req.body.args || {};
  
  const { data, error } = await supa
    .from('treatments')
    .select('id,name,main_category,subcategory,description,applicable_areas,main_indication,recommended_sessions,interval_between_sessions,average_duration,recovery_time,contraindications,price,payment_methods,promotional_discount_available,apply_discount_for_pix,discount_percentage,working_hours,date_specific_availability,timezone,is_active')
    .eq('is_active', true)
    .limit(200);
  
  if(error) return res.status(500).json({ error:error.message });

  function scoreTreatment(treatment){
    let s = 0;
    const categoryName = (treatment.main_category || '').toLowerCase();
    const subcategoryName = (treatment.subcategory || '').toLowerCase();
    const indication = (treatment.main_indication || '').toLowerCase();
    const description = (treatment.description || '').toLowerCase();
    
    // Match category
    if (treatment_category && categoryName.includes(String(treatment_category).toLowerCase())) s += 5;
    
    // Match need/desired_result in description or indication
    if (need) {
      const needTokens = String(need).toLowerCase().split(/[^a-zá-ú0-9]+/i).filter(Boolean);
      needTokens.forEach(token => {
        if (description.includes(token) || indication.includes(token)) s += 3;
        if (categoryName.includes(token) || subcategoryName.includes(token)) s += 2;
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

  const ranked = (data || []).map(t => ({t, s: scoreTreatment(t)})).sort((a,b) => b.s - a.s);
  
  if(!ranked.length || ranked[0].s <= 0) {
    // Return first active treatment as fallback
    const fallback = data?.[0];
    if (!fallback) return res.json({ ok: false, reason: 'no_treatments' });
    
    return res.json({ 
      ok: true, 
      treatment: {
        id: fallback.id,
        name: fallback.name,
        description: fallback.description,
        category: fallback.main_category,
        subcategory: fallback.subcategory,
        benefits: fallback.main_indication || fallback.description,
        duration: `${fallback.average_duration} minutos`,
        price: formatBrazilianCurrency(fallback.price),
        payment_methods: formatPaymentMethods(fallback.payment_methods, fallback.apply_discount_for_pix, fallback.discount_percentage),
        applicable_areas: fallback.applicable_areas,
        recommended_sessions: fallback.recommended_sessions,
        interval_between_sessions: fallback.interval_between_sessions,
        recovery_time: fallback.recovery_time
      },
      treatment_name: fallback.name,
      clinic: {
        city: 'São Paulo' // TODO: Get from clinic settings
      }
    });
  }

  const top = ranked[0].t;
  
  res.json({ 
    ok: true, 
    treatment: {
      id: top.id,
      name: top.name,
      description: top.description,
      category: top.main_category,
      subcategory: top.subcategory,
      benefits: top.main_indication || top.description,
      duration: `${top.average_duration} minutos`,
      price: formatBrazilianCurrency(top.price),
      payment_methods: formatPaymentMethods(top.payment_methods, top.apply_discount_for_pix, top.discount_percentage),
      applicable_areas: top.applicable_areas,
      recommended_sessions: top.recommended_sessions,
      interval_between_sessions: top.interval_between_sessions,
      recovery_time: top.recovery_time
    },
    treatment_name: top.name,
    clinic: {
      city: 'São Paulo' // TODO: Get from clinic settings
    }
  });
});

// Helper function to format Brazilian currency
function formatBrazilianCurrency(amount) {
  if (!amount) return 'R$ 0,00';
  return `R$ ${Number(amount).toFixed(2).replace('.', ',')}`;
}

// Helper function to format payment methods
function formatPaymentMethods(methods, applyDiscountForPix, discountPercentage) {
  if (!methods || !Array.isArray(methods)) return 'PIX ou Cartão';
  
  const methodsMap = {
    'pix': 'PIX',
    'creditCard': 'Cartão de Crédito'
  };
  
  let formattedMethods = methods.map(m => {
    const key = m.toLowerCase().replace(/\s+/g, '');
    return methodsMap[key] || m;
  }).join(', ');
  
  // Add discount information if applicable
  if (applyDiscountForPix && discountPercentage) {
    formattedMethods += ` (${discountPercentage}% de desconto no PIX à vista)`;
  }
  
  return formattedMethods;
}

// Book treatment session (similar to book-appointment but for beauty clinic)
r.post('/fn/book-treatment-session', async (req,res)=>{
  const { treatment_id, lead_id, start, duration_min, timezone } = req.body.args || {};
  
  if(!start) return res.status(400).json({ error:'start required' });
  if(!treatment_id) return res.status(400).json({ error:'treatment_id required' });
  
  // Get treatment details
  const { data: treatmentData } = await supa
    .from('treatments')
    .select('name,owner_id')
    .eq('id', treatment_id)
    .limit(1);
  
  const treatmentName = treatmentData?.[0]?.name || '';
  const ownerId = treatmentData?.[0]?.owner_id;
  
  // Create appointment record in database
  const { data: appointment, error } = await supa
    .from('appointments')
    .insert({
      treatment_id,
      lead_id,
      owner_id: ownerId,
      scheduled_at: start,
      duration_minutes: duration_min || 60,
      timezone: timezone || 'America/Sao_Paulo',
      status: 'scheduled',
      appointment_type: 'treatment_session'
    })
    .select()
    .single();
  
  if (error) {
    console.error('Error booking treatment session:', error);
    return res.status(500).json({ error: error.message });
  }
  
  // TODO: Integrate with Google Calendar if treatment has calendar sync enabled
  // const ev = await bookAppointment({ start, durationMin: duration_min, timezone, treatmentName });
  
  res.json({ 
    ok: true, 
    appointment_id: appointment.id,
    treatment_name: treatmentName,
    // gcal_event_id: ev?.id, 
    // gcal_link: ev?.htmlLink 
  });
});

// Check treatment availability
r.post('/fn/check-treatment-availability', async (req, res) => {
  const { treatment_id, date, timezone } = req.body.args || {};
  
  if (!treatment_id) return res.status(400).json({ error: 'treatment_id required' });
  
  // Get treatment working hours
  const { data: treatment } = await supa
    .from('treatments')
    .select('working_hours,date_specific_availability,timezone')
    .eq('id', treatment_id)
    .single();
  
  if (!treatment) return res.status(404).json({ error: 'Treatment not found' });
  
  // TODO: Implement proper availability checking logic based on working_hours and date_specific_availability
  // For now, return sample slots
  const sampleSlots = [
    '2025-10-20T09:00:00-03:00',
    '2025-10-20T14:00:00-03:00',
    '2025-10-21T10:00:00-03:00',
    '2025-10-22T15:00:00-03:00'
  ];
  
  res.json({ 
    ok: true, 
    next_slots: sampleSlots,
    timezone: treatment.timezone || 'America/Sao_Paulo'
  });
});

export default r;
