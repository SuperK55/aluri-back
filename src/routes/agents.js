import { Router } from 'express';
import { verifyJWT } from '../middleware/verifyJWT.js';
import { supa } from '../lib/supabase.js';
import { log } from '../config/logger.js';
import { retellDeleteAgent } from '../lib/retell.js';
import Retell from 'retell-sdk';
import { env } from '../config/env.js';
import { agentManager } from '../services/agentManager.js';
import { 
  createTwilioSubAccount, 
  purchasePhoneNumber, 
  registerPhoneNumberWithRetell 
} from '../services/twilioService.js';

const client = new Retell({ apiKey: env.RETELL_API_KEY });

const router = Router();

// Helper function to calculate agent stats
async function calculateAgentStats(userId) {
  // Get all agents for the user
  const { data: agents, error: agentsError } = await supa
    .from('agents')
    .select('*')
    .eq('owner_id', userId);

  if (agentsError) {
    throw new Error(agentsError.message);
  }

  // Calculate active agents
  const activeAgents = agents?.filter(agent => agent.is_active) || [];
  
  // Use São Paulo timezone for daily stats
  const { getStartOfDaySaoPaulo, getEndOfDaySaoPaulo } = await import('../utils/timezone.js');
  const todayStart = getStartOfDaySaoPaulo();
  const todayEnd = getEndOfDaySaoPaulo();

  let totalCallsToday = 0;
  let successfulCalls = 0;
  let totalAgentHours = 0;

  if (activeAgents.length > 0) {
    const agentIds = activeAgents.map(a => a.id);
    
    const { data: todayCalls } = await supa
      .from('call_attempts')
      .select('*')
      .in('agent_id', agentIds)
      .gte('started_at', todayStart.toISOString())
      .lt('started_at', todayEnd.toISOString());

    if (todayCalls) {
      totalCallsToday = todayCalls.length;
      successfulCalls = todayCalls.filter(call => 
        call.outcome === 'completed' || call.outcome === 'qualified' ||
        call.disposition === 'interested' || call.disposition === 'scheduled'
      ).length;
      
      totalAgentHours = todayCalls.reduce((total, call) => {
        const duration = call.total_call_duration || call.total_duration_seconds || call.duration_seconds;
        return duration ? total + (duration / 3600) : total;
      }, 0);
    }
  }

  const successRate = totalCallsToday > 0 ? Math.round((successfulCalls / totalCallsToday) * 100) : 0;

  return {
    activeAgents: activeAgents.length,
    totalAgents: agents?.length || 0,
    totalCallsToday,
    successRate: `${successRate}%`,
    totalAgentHours: `${totalAgentHours.toFixed(1)}h`,
    trends: {
      calls: { value: 0, isPositive: true },
      successRate: { value: 0, isPositive: true }
    },
    recentActivity: []
  };
}

// Create a new agent (voice or chat)
router.post('/', verifyJWT, async (req, res) => {
  try {
    const agentData = req.body;
    // Default to voice for backward compatibility, but allow channel to be specified
    agentData.channel = agentData.channel || 'voice';

    // Validate channel
    if (!['voice', 'chat'].includes(agentData.channel)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid channel. Must be "voice" or "chat"'
      });
    }

    const result = await agentManager.createAgentForOwner(req.user.id, agentData);
    
    // Handle both single agent (backward compat) and dual agent (voice + chat) responses
    const newAgent = result.voiceAgent || result.chatAgent || result; // Support old and new return formats
    const chatAgent = result.chatAgent || null;

    // Get all agents for this user
    const { data: allAgents } = await supa
      .from('agents')
      .select('*')
      .eq('owner_id', req.user.id)
      .order('created_at', { ascending: false });

    // Calculate stats
    const stats = await calculateAgentStats(req.user.id);

    const response = {
      ok: true,
      message: agentData.channel === 'voice' && chatAgent 
        ? 'Voice and WhatsApp agents created successfully'
        : `${agentData.channel === 'chat' ? 'Chat' : 'Voice'} agent created successfully`,
      agent: newAgent,
      agents: allAgents || [], // Return all agents
      stats // Return updated stats
    };

    // Include chat agent if it was auto-created
    if (chatAgent) {
      response.chatAgent = chatAgent;
    }

    res.status(201).json(response);

  } catch (error) {
    log.error('Create agent error:', error);
    
    if (error.message.includes('required') || error.message.includes('Invalid')) {
      return res.status(400).json({
        ok: false,
        error: error.message
      });
    }

    res.status(500).json({
      ok: false,
      error: 'Failed to create agent'
    });
  }
});

router.post('/chat', verifyJWT, async (req, res) => {
  try {
    const agentData = {
      ...req.body,
      channel: 'chat', // Force chat channel
      skipChatAgentCreation: true // Don't auto-create another agent
    };

    const result = await agentManager.createAgentForOwner(req.user.id, agentData);
    const newAgent = result.chatAgent || result; // Handle new return format

    // Get all agents for this user
    const { data: allAgents } = await supa
      .from('agents')
      .select('*')
      .eq('owner_id', req.user.id)
      .order('created_at', { ascending: false });

    // Calculate stats
    const stats = await calculateAgentStats(req.user.id);

    res.status(201).json({
      ok: true,
      message: 'Chat agent created successfully',
      agent: newAgent,
      agents: allAgents || [],
      stats
    });

  } catch (error) {
    log.error('Create chat agent error:', error);
    
    if (error.message.includes('required') || error.message.includes('Invalid')) {
      return res.status(400).json({
        ok: false,
        error: error.message
      });
    }

    res.status(500).json({
      ok: false,
      error: 'Failed to create chat agent'
    });
  }
});

// Get WhatsApp chat agents
router.get('/chat', verifyJWT, async (req, res) => {
  try {
    const { service_type } = req.query;
    
    let query = supa
      .from('agents')
      .select('*')
      .eq('owner_id', req.user.id)
      .eq('channel', 'chat');

    // Filter by service_type if provided
    if (service_type && ['clinic', 'beauty_clinic'].includes(service_type)) {
      query = query.eq('service_type', service_type);
    }

    const { data: chatAgents, error } = await query.order('created_at', { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    res.json({ agents: chatAgents || [] });
  } catch (error) {
    log.error('Error fetching chat agents:', error);
    res.status(500).json({ error: error.message });
  }
});

// Configure Twilio sub-account and phone number for user (Step 2)
// This configures Twilio for the user, not the agent
router.post('/:agentId/configure-twilio', verifyJWT, async (req, res) => {
  try {
    const { agentId } = req.params;
    const { sub_account_name, area_code, country_code = 'BR' } = req.body;

    if (!sub_account_name) {
      return res.status(400).json({
        ok: false,
        error: 'Sub-account name is required'
      });
    }

    // Verify agent ownership and get agent info
    const { data: agent, error: agentError } = await supa
      .from('agents')
      .select('id, owner_id, retell_agent_id, agent_name')
      .eq('id', agentId)
      .eq('owner_id', req.user.id)
      .single();

    if (agentError || !agent) {
      return res.status(404).json({
        ok: false,
        error: 'Agent not found or access denied'
      });
    }

    if (!agent.retell_agent_id) {
      return res.status(400).json({
        ok: false,
        error: 'Agent must have a Retell agent ID'
      });
    }

    // Check if user already has a Twilio sub-account and phone number
    const { data: existingUser } = await supa
      .from('users')
      .select('twilio_subaccount_sid, twilio_phone_number')
      .eq('id', req.user.id)
      .single();

    if (existingUser?.twilio_subaccount_sid && existingUser?.twilio_phone_number) {
      return res.status(400).json({
        ok: false,
        error: 'Twilio sub-account and phone number already configured for this account'
      });
    }

    log.info(`Configuring Twilio for user ${req.user.id} (via agent ${agentId})`);

    // Step 1: Create Twilio sub-account
    log.info(`Creating Twilio sub-account: ${sub_account_name}`);
    const twilioSubAccount = await createTwilioSubAccount(sub_account_name, req.user.id);
    log.info(`Twilio sub-account created: ${twilioSubAccount.sid}`);

    // Step 2: Purchase phone number
    log.info('Purchasing phone number...');
    const purchasedPhone = await purchasePhoneNumber(
      twilioSubAccount.sid,
      twilioSubAccount.authToken,
      {
        countryCode: country_code,
        areaCode: area_code || null,
        voiceEnabled: true,
        smsEnabled: true
      }
    );
    log.info(`Phone number purchased: ${purchasedPhone.phoneNumber}`);

    // Step 3: Import phone number to Retell for this agent
    // This will also create SIP trunk and associate phone number with it
    log.info('Importing phone number to Retell...');
    const retellClient = new Retell({ apiKey: env.RETELL_API_KEY });
    await registerPhoneNumberWithRetell(
      purchasedPhone.phoneNumber,
      purchasedPhone.sid, // Pass phone number SID to associate with trunk
      agent.retell_agent_id,
      twilioSubAccount.sid,
      twilioSubAccount.authToken,
      retellClient,
      `${sub_account_name} - ${agent.agent_name}`
    );
    log.info(`Phone number ${purchasedPhone.phoneNumber} imported to Retell`);

    // Step 4: Update user in database with Twilio configuration
    const { data: updatedUser, error: updateError } = await supa
      .from('users')
      .update({
        twilio_subaccount_sid: twilioSubAccount.sid,
        twilio_subaccount_auth_token: twilioSubAccount.authToken,
        twilio_phone_sid: purchasedPhone.sid,
        twilio_phone_number: purchasedPhone.phoneNumber
      })
      .eq('id', req.user.id)
      .select()
      .single();

    if (updateError) {
      log.error('Error updating user with Twilio config:', updateError);
      throw new Error(`Failed to save Twilio configuration: ${updateError.message}`);
    }

    log.info(`Twilio configuration completed for user ${req.user.id}`);

    res.status(200).json({
      ok: true,
      message: 'Twilio sub-account and phone number configured successfully',
      user: {
        twilio_subaccount_sid: updatedUser.twilio_subaccount_sid,
        twilio_phone_number: updatedUser.twilio_phone_number
      },
      twilio: {
        sub_account_sid: twilioSubAccount.sid,
        phone_number: purchasedPhone.phoneNumber,
        phone_sid: purchasedPhone.sid
      }
    });

  } catch (error) {
    log.error('Configure Twilio error:', error);
    
    res.status(500).json({
      ok: false,
      error: error.message || 'Failed to configure Twilio sub-account'
    });
  }
});

// Get statistics for voice agents
router.get('/get/stats', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get all agents for the user
    const { data: agents, error: agentsError } = await supa
      .from('agents')
      .select('*')
      .eq('owner_id', userId);

    if (agentsError) {
      throw new Error(agentsError.message);
    }

    // Calculate active agents (published and active)
    const activeAgents = agents?.filter(agent => agent.is_active) || [];
    
    // Get today's date for filtering calls
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);

    // Get real call statistics from call_attempts table
    let totalCallsToday = 0;
    let successfulCalls = 0;
    let totalAgentHours = 0;
    let callsTrend = 0;
    let successTrend = 0;

    if (activeAgents.length > 0) {
      const agentIds = activeAgents.map(a => a.id);
      
      // Get today's call attempts
      const { data: todayCalls, error: todayCallsError } = await supa
        .from('call_attempts')
        .select('*')
        .in('agent_id', agentIds)
        .gte('started_at', todayStart.toISOString())
        .lt('started_at', todayEnd.toISOString());

      if (!todayCallsError && todayCalls) {
        totalCallsToday = todayCalls.length;
        
        // Count successful calls (completed, qualified, or any positive outcome)
        successfulCalls = todayCalls.filter(call => 
          call.outcome === 'completed' || 
          call.outcome === 'qualified' ||
          call.disposition === 'interested' ||
          call.disposition === 'scheduled'
        ).length;
        
        // Calculate total agent hours based on call durations
        totalAgentHours = todayCalls.reduce((total, call) => {
          const duration = call.total_call_duration || call.total_duration_seconds || call.duration_seconds;
          if (duration) {
            return total + (duration / 3600); // Convert seconds to hours
          }
          return total;
        }, 0);
      }

      // Get yesterday's data for trend calculation
      const yesterdayStart = new Date(todayStart);
      yesterdayStart.setDate(yesterdayStart.getDate() - 1);
      const yesterdayEnd = new Date(todayEnd);
      yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);

      const { data: yesterdayCalls, error: yesterdayCallsError } = await supa
        .from('call_attempts')
        .select('*')
        .in('agent_id', agentIds)
        .gte('started_at', yesterdayStart.toISOString())
        .lt('started_at', yesterdayEnd.toISOString());

      if (!yesterdayCallsError && yesterdayCalls) {
        const yesterdayTotalCalls = yesterdayCalls.length;
        const yesterdaySuccessfulCalls = yesterdayCalls.filter(call => 
          call.outcome === 'completed' || 
          call.outcome === 'qualified' ||
          call.disposition === 'interested' ||
          call.disposition === 'scheduled'
        ).length;
        
        const yesterdaySuccessRate = yesterdayTotalCalls > 0 ? (yesterdaySuccessfulCalls / yesterdayTotalCalls) * 100 : 0;
        const todaySuccessRate = totalCallsToday > 0 ? (successfulCalls / totalCallsToday) * 100 : 0;
        
        // Calculate trends
        callsTrend = yesterdayTotalCalls > 0 ? Math.round(((totalCallsToday - yesterdayTotalCalls) / yesterdayTotalCalls) * 100) : 0;
        successTrend = Math.round(todaySuccessRate - yesterdaySuccessRate);
      }
    }

    const successRate = totalCallsToday > 0 ? Math.round((successfulCalls / totalCallsToday) * 100) : 0;

    // Get real recent activity from call_attempts
    let recentActivity = [];
    
    if (activeAgents.length > 0) {
      const agentIds = activeAgents.map(a => a.id);
      
      // Get recent call attempts (last 24 hours)
      const recentStart = new Date();
      recentStart.setHours(recentStart.getHours() - 24);
      
      const { data: recentCalls, error: recentCallsError } = await supa
        .from('call_attempts')
        .select(`
          *,
          leads!inner(name, phone),
          agents!inner(agent_name, voice_tone, script_style)
        `)
        .in('agent_id', agentIds)
        .gte('started_at', recentStart.toISOString())
        .order('started_at', { ascending: false })
        .limit(10);

      if (!recentCallsError && recentCalls) {
        recentActivity = recentCalls.map(call => {
          const now = new Date();
          const callTime = new Date(call.started_at);
          const minutesAgo = Math.floor((now - callTime) / (1000 * 60));
          
          // Determine activity type and status based on outcome
          let activityType = 'call';
          let status = 'success';
          let title = `Call with ${call.leads.name}`;
          
          if (call.outcome === 'completed' || call.outcome === 'qualified') {
            activityType = 'completed';
            title = `Completed call with ${call.leads.name}`;
          } else if (call.outcome === 'no_answer' || call.outcome === 'voicemail') {
            activityType = 'failed';
            status = 'error';
            title = `No answer from ${call.leads.name}`;
          } else if (call.disposition === 'scheduled') {
            activityType = 'appointment';
            title = `Scheduled appointment for ${call.leads.name}`;
          } else if (call.disposition === 'interested') {
            activityType = 'interested';
            title = `Qualified lead: ${call.leads.name}`;
          }
          
          // Format duration
          const callDuration = call.total_call_duration || call.total_duration_seconds || call.duration_seconds;
          const duration = callDuration ? 
            `${Math.floor(callDuration / 60)}:${String(callDuration % 60).padStart(2, '0')}` : 
            '0:00';
          
          return {
            id: call.id,
            type: activityType,
            status: status,
            title: title,
            agentType: call.agents.agent_name || 'Voice Agent',
            duration: duration,
            timeAgo: minutesAgo < 60 ? 
              `${minutesAgo} minute${minutesAgo !== 1 ? 's' : ''} ago` :
              `${Math.floor(minutesAgo / 60)} hour${Math.floor(minutesAgo / 60) !== 1 ? 's' : ''} ago`
          };
        });
      }
    }

    const stats = {
      activeAgents: activeAgents.length,
      totalAgents: agents?.length || 0,
      totalCallsToday,
      successRate: `${successRate}%`,
      totalAgentHours: `${totalAgentHours.toFixed(1)}h`,
      trends: {
        calls: {
          value: Math.abs(callsTrend),
          isPositive: callsTrend >= 0
        },
        successRate: {
          value: Math.abs(successTrend),
          isPositive: successTrend >= 0
        }
      },
      recentActivity
    };

    res.json({ stats });
  } catch (error) {
    log.error('Error fetching agent stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all agents for the authenticated user
// Get all agents for the user, optionally filtered by channel
router.get('/', verifyJWT, async (req, res) => {
  try {
    const { channel, service_type } = req.query;
    
    let query = supa
      .from('agents')
      .select('*')
      .eq('owner_id', req.user.id);

    // Filter by channel if provided
    if (channel && ['voice', 'chat'].includes(channel)) {
      query = query.eq('channel', channel);
    }

    // Filter by service_type if provided
    if (service_type && ['clinic', 'beauty_clinic'].includes(service_type)) {
      query = query.eq('service_type', service_type);
    }

    const { data: agents, error } = await query.order('created_at', { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    res.json({ agents: agents || [] });
  } catch (error) {
    log.error('Error fetching agents:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get call logs for user (must be before /:id route)
router.get('/call-logs', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20, status, agent_id, date_from, date_to } = req.query;
    
    // Get user's service type to determine clinic type
    const { data: userData } = await supa
      .from('users')
      .select('service_type')
      .eq('id', userId)
      .single();
    
    const isBeautyClinic = userData?.service_type === 'beauty_clinic';
    
    // Calculate offset for pagination
    const offset = (page - 1) * limit;
    
    // Build query conditions - use LEFT JOIN for doctors to support beauty clinics
    let query = supa
      .from('call_attempts')
      .select(`
        *,
        leads!inner(name, phone, city, specialty),
        agents!inner(agent_name, voice_tone, script_style),
        doctors(name, specialty)
      `)
      .eq('owner_id', userId)
      .order('started_at', { ascending: false })
      .range(offset, offset + limit - 1);
    
    // Apply filters
    if (status) {
      query = query.eq('outcome', status);
    }
    
    if (agent_id) {
      query = query.eq('agent_id', agent_id);
    }
    
    if (date_from) {
      query = query.gte('started_at', date_from);
    }
    
    if (date_to) {
      query = query.lte('started_at', date_to);
    }
    
    const { data: callLogs, error } = await query;
    
    if (error) {
      throw new Error(error.message);
    }
    
    // Fetch treatments for beauty clinic call logs
    const treatmentIds = callLogs
      .filter(log => log.resource_type === 'treatment' && log.resource_id)
      .map(log => log.resource_id);
    
    let treatmentsMap = {};
    if (treatmentIds.length > 0) {
      const { data: treatments } = await supa
        .from('treatments')
        .select('id, treatment_name, treatment_benefit')
        .in('id', treatmentIds);
      
      if (treatments) {
        treatmentsMap = treatments.reduce((acc, treatment) => {
          acc[treatment.id] = treatment;
          return acc;
        }, {});
      }
    }
    
    // Get total count for pagination
    let countQuery = supa
      .from('call_attempts')
      .select('id', { count: 'exact' })
      .eq('owner_id', userId);
    
    if (status) {
      countQuery = countQuery.eq('outcome', status);
    }
    
    if (agent_id) {
      countQuery = countQuery.eq('agent_id', agent_id);
    }
    
    if (date_from) {
      countQuery = countQuery.gte('started_at', date_from);
    }
    
    if (date_to) {
      countQuery = countQuery.lte('started_at', date_to);
    }
    
    const { count, error: countError } = await countQuery;
    
    if (countError) {
      throw new Error(countError.message);
    }
    
    // Format the response - handle both doctors and treatments
    const formattedLogs = callLogs.map(log => {
      const isTreatment = log.resource_type === 'treatment';
      const treatment = isTreatment && log.resource_id ? treatmentsMap[log.resource_id] : null;
      
      return {
        id: log.id,
        callId: log.retell_call_id,
        leadName: log.leads.name,
        leadPhone: log.leads.phone,
        leadCity: log.leads.city,
        leadSpecialty: log.leads.specialty,
        agentName: log.agents.agent_name,
        voiceTone: log.agents.voice_tone,
        scriptStyle: log.agents.script_style,
        // For medical clinics: use doctor data
        // For beauty clinics: use treatment data
        doctorName: isTreatment 
          ? (treatment?.treatment_name || null)
          : (log.doctors?.name || null),
        doctorSpecialty: isTreatment
          ? (treatment?.treatment_benefit || null)
          : (log.doctors?.specialty || null),
        outcome: log.outcome,
        disposition: log.disposition,
        attemptNo: log.attempt_no,
        startedAt: log.started_at,
        endedAt: log.ended_at,
        duration: log.total_call_duration || log.total_duration_seconds || log.duration_seconds || 0,
        transcript: log.transcript,
        summary: log.summary,
        callAnalysis: log.call_analysis
      };
    });
    
    res.json({
      success: true,
      data: formattedLogs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
    
  } catch (error) {
    log.error('Error fetching call logs:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get call log details (must be before /:id route)
router.get('/call-logs/:id', verifyJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    // Get user's service type to determine clinic type
    const { data: userData } = await supa
      .from('users')
      .select('service_type')
      .eq('id', userId)
      .single();
    
    const isBeautyClinic = userData?.service_type === 'beauty_clinic';
    
    // Use LEFT JOIN for doctors to support beauty clinics
    const { data: callLog, error } = await supa
      .from('call_attempts')
      .select(`
        *,
        leads!inner(name, phone, city, specialty, reason),
        agents!inner(agent_name, voice_tone, script_style),
        doctors(name, specialty, bio)
      `)
      .eq('id', id)
      .eq('owner_id', userId)
      .single();
    
    if (error || !callLog) {
      return res.status(404).json({ error: 'Call log not found' });
    }
    
    // Fetch treatment if this is a beauty clinic call log
    let treatment = null;
    if (callLog.resource_type === 'treatment' && callLog.resource_id) {
      const { data: treatmentData } = await supa
        .from('treatments')
        .select('id, treatment_name, treatment_benefit, treatment_effects')
        .eq('id', callLog.resource_id)
        .single();
      
      treatment = treatmentData;
    }
    
    const isTreatment = callLog.resource_type === 'treatment';
    
    res.json({
      success: true,
      data: {
        id: callLog.id,
        callId: callLog.retell_call_id,
        leadName: callLog.leads.name,
        leadPhone: callLog.leads.phone,
        leadCity: callLog.leads.city,
        leadSpecialty: callLog.leads.specialty,
        leadReason: callLog.leads.reason,
        agentName: callLog.agents.agent_name,
        voiceTone: callLog.agents.voice_tone,
        scriptStyle: callLog.agents.script_style,
        // For medical clinics: use doctor data
        // For beauty clinics: use treatment data
        doctorName: isTreatment
          ? (treatment?.treatment_name || null)
          : (callLog.doctors?.name || null),
        doctorSpecialty: isTreatment
          ? (treatment?.treatment_benefit || null)
          : (callLog.doctors?.specialty || null),
        doctorBio: isTreatment
          ? (treatment?.treatment_effects || null)
          : (callLog.doctors?.bio || null),
        outcome: callLog.outcome,
        disposition: callLog.disposition,
        attemptNo: callLog.attempt_no,
        startedAt: callLog.started_at,
        endedAt: callLog.ended_at,
        duration: callLog.total_call_duration || callLog.total_duration_seconds || callLog.duration_seconds || 0,
        transcript: callLog.transcript,
        summary: callLog.summary,
        callAnalysis: callLog.call_analysis,
        analysis: callLog.analysis,
        meta: callLog.meta
      }
    });
    
  } catch (error) {
    log.error('Error fetching call log details:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get chat logs for user (must be before /:id route)
router.get('/chat-logs', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20, status, agent_id, date_from, date_to } = req.query;
    
    // Get user's service type to determine clinic type
    const { data: userData } = await supa
      .from('users')
      .select('service_type')
      .eq('id', userId)
      .single();
    
    const isBeautyClinic = userData?.service_type === 'beauty_clinic';
    
    // Calculate offset for pagination
    const offset = (page - 1) * limit;
    
    // Build query - join with leads to get patient info
    let query = supa
      .from('whatsapp_chats')
      .select(`
        *,
        leads(name, phone, city, specialty)
      `)
      .eq('owner_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    
    // Apply filters
    if (status) {
      query = query.eq('status', status);
    }
    
    if (agent_id) {
      query = query.eq('agent_id', agent_id);
    }
    
    if (date_from) {
      query = query.gte('created_at', date_from);
    }
    
    if (date_to) {
      query = query.lte('created_at', date_to);
    }
    
    const { data: chatLogs, error } = await query;
    
    if (error) {
      throw new Error(error.message);
    }
    
    // Get message counts and last message for each chat
    const chatIds = chatLogs.map(chat => chat.id);
    let messageCounts = {};
    let lastMessages = {};
    
    if (chatIds.length > 0) {
      // Get message counts per chat
      const { data: messageStats } = await supa
        .from('whatsapp_messages')
        .select('chat_id, direction')
        .in('chat_id', chatIds);
      
      if (messageStats) {
        messageCounts = messageStats.reduce((acc, msg) => {
          if (!acc[msg.chat_id]) {
            acc[msg.chat_id] = { inbound: 0, outbound: 0, total: 0 };
          }
          acc[msg.chat_id].total++;
          if (msg.direction === 'inbound') {
            acc[msg.chat_id].inbound++;
          } else {
            acc[msg.chat_id].outbound++;
          }
          return acc;
        }, {});
      }
      
      // Get last message for each chat
      const { data: lastMessagesData } = await supa
        .from('whatsapp_messages')
        .select('chat_id, body, direction, created_at')
        .in('chat_id', chatIds)
        .order('created_at', { ascending: false });
      
      if (lastMessagesData) {
        // Get the most recent message per chat
        const seenChats = new Set();
        lastMessagesData.forEach(msg => {
          if (!seenChats.has(msg.chat_id)) {
            lastMessages[msg.chat_id] = {
              body: msg.body,
              direction: msg.direction,
              created_at: msg.created_at
            };
            seenChats.add(msg.chat_id);
          }
        });
      }
    }
    
    // Get total count for pagination
    let countQuery = supa
      .from('whatsapp_chats')
      .select('id', { count: 'exact' })
      .eq('owner_id', userId);
    
    if (status) {
      countQuery = countQuery.eq('status', status);
    }
    
    if (agent_id) {
      countQuery = countQuery.eq('agent_id', agent_id);
    }
    
    if (date_from) {
      countQuery = countQuery.gte('created_at', date_from);
    }
    
    if (date_to) {
      countQuery = countQuery.lte('created_at', date_to);
    }
    
    const { count, error: countError } = await countQuery;
    
    if (countError) {
      throw new Error(countError.message);
    }
    
    // Format the response
    const formattedLogs = chatLogs.map(chat => {
      const stats = messageCounts[chat.id] || { inbound: 0, outbound: 0, total: 0 };
      const lastMessage = lastMessages[chat.id] || null;
      const chatType = chat.metadata?.chat_type || 'other';
      
      return {
        id: chat.id,
        chatId: chat.retell_chat_id,
        leadName: chat.leads?.name || null,
        leadPhone: chat.wa_phone,
        leadCity: chat.leads?.city || null,
        leadSpecialty: chat.leads?.specialty || null,
        agentId: chat.agent_id,
        status: chat.status,
        chatType: chatType,
        messageCount: stats.total,
        inboundCount: stats.inbound,
        outboundCount: stats.outbound,
        lastMessage: lastMessage,
        lastMessageAt: chat.last_message_at,
        createdAt: chat.created_at,
        updatedAt: chat.updated_at,
        metadata: chat.metadata,
        chatAnalysis: chat.retell_chat_analysis,
        chatCost: chat.retell_chat_cost
      };
    });
    
    res.json({
      success: true,
      data: formattedLogs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
    
  } catch (error) {
    log.error('Error fetching chat logs:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get chat log details with all messages (must be before /:id route)
router.get('/chat-logs/:id', verifyJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    // Get chat details
    const { data: chat, error: chatError } = await supa
      .from('whatsapp_chats')
      .select(`
        *,
        leads(name, phone, city, specialty, reason)
      `)
      .eq('id', id)
      .eq('owner_id', userId)
      .single();
    
    if (chatError || !chat) {
      return res.status(404).json({ error: 'Chat log not found' });
    }
    
    // Get all messages for this chat
    const { data: messages, error: messagesError } = await supa
      .from('whatsapp_messages')
      .select('*')
      .eq('chat_id', id)
      .order('created_at', { ascending: true });
    
    if (messagesError) {
      throw new Error(messagesError.message);
    }
    
    // Get resource info if available (doctor or treatment)
    let resourceInfo = null;
    if (chat.metadata?.resource_type && chat.metadata?.resource_id) {
      if (chat.metadata.resource_type === 'doctor') {
        const { data: doctor } = await supa
          .from('doctors')
          .select('id, name, specialty')
          .eq('id', chat.metadata.resource_id)
          .single();
        resourceInfo = doctor ? {
          type: 'doctor',
          name: doctor.name,
          specialty: doctor.specialty
        } : null;
      } else if (chat.metadata.resource_type === 'treatment') {
        const { data: treatment } = await supa
          .from('treatments')
          .select('id, treatment_name, treatment_benefit')
          .eq('id', chat.metadata.resource_id)
          .single();
        resourceInfo = treatment ? {
          type: 'treatment',
          name: treatment.treatment_name,
          specialty: treatment.treatment_benefit
        } : null;
      }
    }
    
    res.json({
      success: true,
      data: {
        id: chat.id,
        chatId: chat.retell_chat_id,
        leadName: chat.leads?.name || null,
        leadPhone: chat.wa_phone,
        leadCity: chat.leads?.city || null,
        leadSpecialty: chat.leads?.specialty || null,
        leadReason: chat.leads?.reason || null,
        agentId: chat.agent_id,
        status: chat.status,
        chatType: chat.metadata?.chat_type || 'other',
        resourceInfo: resourceInfo,
        messages: messages.map(msg => ({
          id: msg.id,
          direction: msg.direction,
          sender: msg.sender,
          body: msg.body,
          messageType: msg.message_type,
          isTemplate: msg.is_template,
          payload: msg.payload,
          createdAt: msg.created_at,
          waMessageId: msg.wa_message_id,
          retellMessageId: msg.retell_message_id
        })),
        metadata: chat.metadata,
        chatAnalysis: chat.retell_chat_analysis,
        chatCost: chat.retell_chat_cost,
        collectedVariables: chat.retell_collected_variables,
        createdAt: chat.created_at,
        updatedAt: chat.updated_at,
        lastMessageAt: chat.last_message_at
      }
    });
    
  } catch (error) {
    log.error('Error fetching chat log details:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get a single agent by ID
router.get('/:id', verifyJWT, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: agent, error } = await supa
      .from('agents')
      .select('*')
      .eq('id', id)
      .eq('owner_id', req.user.id)
      .single();

    if (error) {
      throw new Error(error.message);
    }

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({ agent });
  } catch (error) {
    log.error('Error fetching agent:', error);
    res.status(500).json({ error: error.message });
  }
});

// Set default agent for user
router.put('/default/:agentId', verifyJWT, async (req, res) => {
  try {
    const { agentId } = req.params;
    const userId = req.user.id;

    // Verify the agent belongs to the user and get user's phone number
    const { data: agent, error: agentError } = await supa
      .from('agents')
      .select(`
        id, 
        agent_name, 
        is_active,
        retell_agent_id,
        users!agents_owner_id_fkey(phone_number)
      `)
      .eq('id', agentId)
      .eq('owner_id', userId)
      .single();

    if (agentError || !agent) {
      return res.status(404).json({ error: 'Agent not found or not owned by user' });
    }

    if (!agent.is_active) {
      return res.status(400).json({ error: 'Cannot set inactive agent as default' });
    }

    // Update user's default agent
    const { error: updateError } = await supa
      .from('users')
      .update({ default_agent_id: agentId })
      .eq('id', userId);

    if (updateError) {
      throw new Error(updateError.message);
    }

    // Update Retell agent configuration with user's phone number if available
    if (agent.retell_agent_id && agent.users?.phone_number) {
      try {
        await client.phoneNumber.update( agent.users.twilio_phone_number, {
          outbound_agent_id: agent.retell_agent_id,
        })
        log.info(`Updated Retell agent ${agent.retell_agent_id} with phone number ${agent.users.twilio_phone_number}`);
      } catch (retellError) {
        log.warn(`Failed to update Retell agent with phone number: ${retellError.message}`);
        // Don't fail the request if Retell update fails
      }
    }

    log.info(`User ${userId} set default agent to ${agentId} (${agent.agent_name})`);

    res.json({
      success: true,
      message: 'Default agent updated successfully',
      defaultAgent: {
        id: agent.id,
        name: agent.agent_name
      }
    });

  } catch (error) {
    log.error('Error setting default agent:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get default agent for user
router.get('/get/default', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user's default agent
    const { data: user, error: userError } = await supa
      .from('users')
      .select('default_agent_id')
      .eq('id', userId)
      .single();

    if (userError) {
      throw new Error(userError.message);
    }

    if (!user.default_agent_id) {
      return res.json({
        success: true,
        defaultAgent: null,
        message: 'No default agent set'
      });
    }

    // Get default agent details
    const { data: agent, error: agentError } = await supa
      .from('agents')
      .select('id, agent_name, voice_tone, script_style, is_active')
      .eq('id', user.default_agent_id)
      .eq('owner_id', userId)
      .single();

    if (agentError || !agent) {
      // Default agent was deleted or doesn't belong to user, clear it
      await supa
        .from('users')
        .update({ default_agent_id: null })
        .eq('id', userId);

      return res.json({
        success: true,
        defaultAgent: null,
        message: 'Default agent was invalid and has been cleared'
      });
    }

    res.json({
      success: true,
      defaultAgent: {
        id: agent.id,
        name: agent.agent_name,
        voiceTone: agent.voice_tone,
        scriptStyle: agent.script_style,
        isActive: agent.is_active
      }
    });

  } catch (error) {
    log.error('Error getting default agent:', error);
    res.status(500).json({ error: error.message });
  }
});

// Remove default agent
router.delete('/default', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;

    const { error: updateError } = await supa
      .from('users')
      .update({ default_agent_id: null })
      .eq('id', userId);

    if (updateError) {
      throw new Error(updateError.message);
    }

    log.info(`User ${userId} removed default agent`);

    res.json({
      success: true,
      message: 'Default agent removed successfully'
    });

  } catch (error) {
    log.error('Error removing default agent:', error);
    res.status(500).json({ error: error.message });
  }
});


// Update an agent (PUT for full update)
router.put('/:id', verifyJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    // Validate required fields
    if (!updateData.agent_name) {
      return res.status(400).json({ error: 'Agent name is required' });
    }

    // First get the current agent to check if it has a retell_agent_id and service_type
    const { data: currentAgent, error: fetchError } = await supa
      .from('agents')
      .select('retell_agent_id, service_type')
      .eq('id', id)
      .eq('owner_id', req.user.id)
      .single();

    if (fetchError || !currentAgent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Validate script_style: beauty clinics cannot use 'copy' style
    if (currentAgent.service_type === 'beauty_clinic' && updateData.script_style === 'copy') {
      return res.status(400).json({ error: 'Copy script style is not available for beauty clinic agents' });
    }

    const { data: agent, error } = await supa
      .from('agents')
      .update(updateData)
      .eq('id', id)
      .eq('owner_id', req.user.id) // Ensure user owns the agent
      .select()
      .single();

    if (error) {
      throw new Error(error.message);
    }

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Get all agents for this user
    const { data: allAgents } = await supa
      .from('agents')
      .select('*')
      .eq('owner_id', req.user.id)
      .order('created_at', { ascending: false });

    // Calculate stats
    const stats = await calculateAgentStats(req.user.id);

    res.json({ 
      agent,
      agents: allAgents || [], // Return all agents
      stats // Return updated stats
    });
  } catch (error) {
    log.error('Error updating agent:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update an agent (PATCH for partial update)
router.patch('/:id', verifyJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    // If no valid fields to update, return error
    if (Object.keys(filteredUpdateData).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // First get the current agent to check if it has a retell_agent_id and service_type
    const { data: currentAgent, error: fetchError } = await supa
      .from('agents')
      .select('retell_agent_id, service_type')
      .eq('id', id)
      .eq('owner_id', req.user.id)
      .single();

    if (fetchError || !currentAgent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Validate script_style: beauty clinics cannot use 'copy' style
    if (currentAgent.service_type === 'beauty_clinic' && updateData.script_style === 'copy') {
      return res.status(400).json({ error: 'Copy script style is not available for beauty clinic agents' });
    }

    const { data: agent, error } = await supa
      .from('agents')
      .update(updateData)
      .eq('id', id)
      .eq('owner_id', req.user.id) // Ensure user owns the agent
      .select()
      .single();

    if (error) {
      throw new Error(error.message);
    }

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Get all agents for this user
    const { data: allAgents } = await supa
      .from('agents')
      .select('*')
      .eq('owner_id', req.user.id)
      .order('created_at', { ascending: false });

    // Calculate stats
    const stats = await calculateAgentStats(req.user.id);

    res.json({ 
      agent,
      agents: allAgents || [], // Return all agents
      stats // Return updated stats
    });
  } catch (error) {
    log.error('Error updating agent:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete an agent
router.delete('/:id', verifyJWT, async (req, res) => {
  try {
    const { id } = req.params;

    // First, get the agent to check ownership and get retell_agent_id
    const { data: agent, error: fetchError } = await supa
      .from('agents')
      .select('retell_agent_id')
      .eq('id', id)
      .eq('owner_id', req.user.id)
      .single();

    if (fetchError) {
      throw new Error(fetchError.message);
    }

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Handle foreign key constraints - reassign or delete associated data
    try {
      // First, check if there are any leads assigned to this agent
      const { data: assignedLeads, error: leadsError } = await supa
        .from('leads')
        .select('id')
        .eq('assigned_agent_id', id);

      if (leadsError) {
        log.error('Error checking assigned leads:', leadsError);
      } else if (assignedLeads && assignedLeads.length > 0) {
        // Reassign leads to null (unassigned) or delete them
        // For now, we'll unassign them by setting assigned_agent_id to null
        const { error: updateLeadsError } = await supa
          .from('leads')
          .update({ assigned_agent_id: null })
          .eq('assigned_agent_id', id);

        if (updateLeadsError) {
          log.error('Error unassigning leads:', updateLeadsError);
          throw new Error('Cannot delete agent: Failed to unassign associated leads');
        }
        
        log.info(`Unassigned ${assignedLeads.length} leads from agent ${id}`);
      }

      // Check if there are any call attempts associated with this agent
      const { data: callAttempts, error: callAttemptsError } = await supa
        .from('call_attempts')
        .select('id')
        .eq('agent_id', id);

      if (callAttemptsError) {
        log.error('Error checking call attempts:', callAttemptsError);
      } else if (callAttempts && callAttempts.length > 0) {
        // Delete call attempts associated with this agent
        const { error: deleteCallAttemptsError } = await supa
          .from('call_attempts')
          .delete()
          .eq('agent_id', id);

        if (deleteCallAttemptsError) {
          log.error('Error deleting call attempts:', deleteCallAttemptsError);
          throw new Error('Cannot delete agent: Failed to delete associated call attempts');
        }
        
        log.info(`Deleted ${callAttempts.length} call attempts for agent ${id}`);
      }

        // Check if this agent is set as default_agent_id for any user
      const { data: usersWithDefaultAgent, error: usersError } = await supa
        .from('users')
        .select('id')
        .eq('default_agent_id', id);

      if (usersError) {
        log.error('Error checking users with default agent:', usersError);
      } else if (usersWithDefaultAgent && usersWithDefaultAgent.length > 0) {
        // Remove this agent as the default agent for all users
        const { error: updateUsersError } = await supa
          .from('users')
          .update({ default_agent_id: null })
          .eq('default_agent_id', id);

        if (updateUsersError) {
          log.error('Error updating users default agent:', updateUsersError);
          throw new Error('Cannot delete agent: Failed to update users with this agent as default');
        }
        
        log.info(`Removed agent ${id} as default agent for ${usersWithDefaultAgent.length} users`);
      }
    } catch (constraintError) {
      log.error('Error handling foreign key constraints:', constraintError);
      throw new Error('Cannot delete agent: Agent has associated data that cannot be removed');
    }

    // Delete from Retell AI if retell_agent_id exists
    if (agent.retell_agent_id) {
      try {
        await retellDeleteAgent(agent.retell_agent_id);
        log.info(`Retell agent ${agent.retell_agent_id} deleted successfully`);
      } catch (retellError) {
        log.error('Error deleting Retell agent:', retellError);
        // Continue with database deletion even if Retell deletion fails
      }
    }

    // Delete from database
    const { error: deleteError } = await supa
      .from('agents')
      .delete()
      .eq('id', id)
      .eq('owner_id', req.user.id);

    if (deleteError) {
      throw new Error(deleteError.message);
    }

    // Get all remaining agents for this user
    const { data: allAgents } = await supa
      .from('agents')
      .select('*')
      .eq('owner_id', req.user.id)
      .order('created_at', { ascending: false });

    // Calculate stats
    const stats = await calculateAgentStats(req.user.id);

    res.json({ 
      ok: true,
      message: 'Agent deleted successfully',
      agents: allAgents || [], // Return remaining agents
      stats // Return updated stats
    });
  } catch (error) {
    log.error('Error deleting agent:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
