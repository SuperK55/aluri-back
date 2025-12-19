import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { supa } from '../../lib/supabase.js';
import { env } from '../../config/env.js';
import { log } from '../../config/logger.js';

const router = Router();
const JWT_SECRET = env.JWT_SECRET || 'geniumed-secret-key-change-in-production';

// Middleware to authenticate and get owner ID
const authenticateOwner = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        ok: false,
        error: 'No token provided'
      });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET);

    // Verify user exists and is active
    const { data: user, error } = await supa
      .from('users')
      .select('*')
      .eq('id', decoded.id)
      .single();

    if (error || !user) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid token'
      });
    }

    // Check if user is active
    if (user.is_active === false) {
      return res.status(401).json({
        ok: false,
        error: 'User account is inactive'
      });
    }

    // Verify user has beauty_clinic service type
    if (user.service_type !== 'beauty_clinic') {
      return res.status(403).json({
        ok: false,
        error: 'Access denied. This endpoint is only for beauty clinic users.'
      });
    }

    req.ownerId = user.id;
    req.ownerRole = user.role;
    req.serviceType = user.service_type;
    next();

  } catch (error) {
    return res.status(401).json({
      ok: false,
      error: 'Invalid token'
    });
  }
};

// GET /api/beauty/treatments - List all treatments for the owner
router.get('/', authenticateOwner, async (req, res) => {
  try {
    const { active_only = 'true' } = req.query;
    
    let query = supa
      .from('treatments')
      .select('*')
      .eq('owner_id', req.ownerId)
      .order('created_at', { ascending: false });
      
    if (active_only === 'true') {
      query = query.eq('is_active', true);
    }
    
    const { data: treatments, error } = await query;
    
    if (error) {
      log.error('Error fetching treatments:', error);
      return res.status(500).json({ 
        ok: false, 
        error: 'Failed to fetch treatments' 
      });
    }
    
    res.json({ 
      ok: true, 
      treatments: treatments || [] 
    });

  } catch (error) {
    log.error('Get treatments error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to fetch treatments'
    });
  }
});

// GET /api/beauty/treatments/:id - Get a specific treatment
router.get('/:id', authenticateOwner, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: treatment, error } = await supa
      .from('treatments')
      .select('*')
      .eq('id', id)
      .eq('owner_id', req.ownerId)
      .single();
      
    if (error || !treatment) {
      return res.status(404).json({
        ok: false,
        error: 'Treatment not found'
      });
    }
    
    res.json({
      ok: true,
      treatment
    });

  } catch (error) {
    log.error('Get treatment error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to fetch treatment'
    });
  }
});

// POST /api/beauty/treatments - Create a new treatment
router.post('/', authenticateOwner, async (req, res) => {
  try {
    const {
      // Treatment identification and marketing
      treatment_name,
      treatment_benefit,
      
      // Client pain points
      pain_point_1,
      pain_point_2,
      pain_point_3,
      
      // Treatment outcomes
      treatment_effects,
      treatment_result,
      client_feedback,
      
      // Session details
      session_duration,
      recommended_sessions,
      interval_between_sessions,
      
      // Offer type and pricing
      offer_type = 'single_session',
      single_session_price,
      package_sessions_count,
      package_price,
      
      // Payment options
      installment_options,
      pix_discount_percentage = 0
    } = req.body;
    
    // Validate required fields
    if (!treatment_name || !offer_type) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: treatment_name, offer_type'
      });
    }
    
    // Validate offer type and pricing
    if (offer_type === 'single_session' && !single_session_price) {
      return res.status(400).json({
        ok: false,
        error: 'single_session_price is required when offer_type is single_session'
      });
    }
    
    if (offer_type === 'package' && (!package_sessions_count || !package_price)) {
      return res.status(400).json({
        ok: false,
        error: 'package_sessions_count and package_price are required when offer_type is package'
      });
    }
    
    const treatmentData = {
      owner_id: req.ownerId,
      // Treatment identification and marketing
      treatment_name,
      treatment_benefit: treatment_benefit || null,
      
      // Client pain points
      pain_point_1: pain_point_1 || null,
      pain_point_2: pain_point_2 || null,
      pain_point_3: pain_point_3 || null,
      
      // Treatment outcomes
      treatment_effects: treatment_effects || null,
      treatment_result: treatment_result || null,
      client_feedback: client_feedback || null,
      
      // Session details
      session_duration: session_duration ? parseInt(session_duration) : null,
      recommended_sessions: recommended_sessions ? parseInt(recommended_sessions) : null,
      interval_between_sessions: interval_between_sessions || null,
      
      // Offer type and pricing
      offer_type,
      single_session_price: single_session_price ? parseFloat(single_session_price) : null,
      package_sessions_count: package_sessions_count ? parseInt(package_sessions_count) : null,
      package_price: package_price ? parseFloat(package_price) : null,
      
      // Payment options
      installment_options: installment_options || null,
      pix_discount_percentage: pix_discount_percentage ? parseInt(pix_discount_percentage) : 0,
      
      is_active: true
    };
    
    const { data: treatment, error } = await supa
      .from('treatments')
      .insert(treatmentData)
      .select()
      .single();
      
    if (error) {
      log.error('Error creating treatment:', error);
      return res.status(400).json({ 
        ok: false, 
        error: error.message 
      });
    }
    
    log.info(`Treatment created: ${treatment.id} by owner ${req.ownerId}`);
    
    // Fetch updated treatments list
    const { data: allTreatments } = await supa
      .from('treatments')
      .select('*')
      .eq('owner_id', req.ownerId)
      .eq('is_active', true)
      .order('created_at', { ascending: false });
    
    res.status(201).json({ 
      ok: true, 
      message: 'Treatment created successfully',
      treatment,
      treatments: allTreatments || []
    });

  } catch (error) {
    log.error('Create treatment error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to create treatment'
    });
  }
});

// PUT /api/beauty/treatments/:id - Update a treatment
router.put('/:id', authenticateOwner, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verify treatment exists and belongs to owner
    const { data: existingTreatment, error: fetchError } = await supa
      .from('treatments')
      .select('id')
      .eq('id', id)
      .eq('owner_id', req.ownerId)
      .single();
      
    if (fetchError || !existingTreatment) {
      return res.status(404).json({
        ok: false,
        error: 'Treatment not found'
      });
    }
    
    // Update treatment
    const {
      // Treatment identification and marketing
      treatment_name,
      treatment_benefit,
      
      // Client pain points
      pain_point_1,
      pain_point_2,
      pain_point_3,
      
      // Treatment outcomes
      treatment_effects,
      treatment_result,
      client_feedback,
      
      // Session details
      session_duration,
      recommended_sessions,
      interval_between_sessions,
      
      // Offer type and pricing
      offer_type,
      single_session_price,
      package_sessions_count,
      package_price,
      
      // Payment options
      installment_options,
      pix_discount_percentage
    } = req.body;
    
    // Process and validate the update data
    const updateData = {
      // Treatment identification and marketing
      treatment_name: treatment_name || null,
      treatment_benefit: treatment_benefit || null,
      
      // Client pain points
      pain_point_1: pain_point_1 || null,
      pain_point_2: pain_point_2 || null,
      pain_point_3: pain_point_3 || null,
      
      // Treatment outcomes
      treatment_effects: treatment_effects || null,
      treatment_result: treatment_result || null,
      client_feedback: client_feedback || null,
      
      // Session details
      session_duration: session_duration ? parseInt(session_duration) : null,
      recommended_sessions: recommended_sessions ? parseInt(recommended_sessions) : null,
      interval_between_sessions: interval_between_sessions || null,
      
      // Offer type and pricing
      offer_type: offer_type || 'single_session',
      single_session_price: single_session_price ? parseFloat(single_session_price) : null,
      package_sessions_count: package_sessions_count ? parseInt(package_sessions_count) : null,
      package_price: package_price ? parseFloat(package_price) : null,
      
      // Payment options
      installment_options: installment_options || null,
      pix_discount_percentage: pix_discount_percentage ? parseInt(pix_discount_percentage) : 0
    };
    
    const { data: treatment, error } = await supa
      .from('treatments')
      .update(updateData)
      .eq('id', id)
      .eq('owner_id', req.ownerId)
      .select()
      .single();
      
    if (error) {
      log.error('Error updating treatment:', error);
      return res.status(400).json({ 
        ok: false, 
        error: error.message 
      });
    }
    
    log.info(`Treatment updated: ${id} by owner ${req.ownerId}`);
    
    // Fetch updated treatments list
    const { data: allTreatments } = await supa
      .from('treatments')
      .select('*')
      .eq('owner_id', req.ownerId)
      .eq('is_active', true)
      .order('created_at', { ascending: false });
    
    res.json({ 
      ok: true,
      message: 'Treatment updated successfully',
      treatment,
      treatments: allTreatments || []
    });

  } catch (error) {
    log.error('Update treatment error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to update treatment'
    });
  }
});

// DELETE /api/beauty/treatments/:id - Delete or deactivate a treatment
router.delete('/:id', authenticateOwner, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verify treatment exists and belongs to owner
    const { data: existingTreatment, error: fetchError } = await supa
      .from('treatments')
      .select('treatment_name')
      .eq('id', id)
      .eq('owner_id', req.ownerId)
      .single();
      
    if (fetchError || !existingTreatment) {
      return res.status(404).json({
        ok: false,
        error: 'Treatment not found'
      });
    }
    
    // Check if treatment has any assigned leads
    const { data: assignedLeads } = await supa
      .from('leads')
      .select('id')
      .eq('assigned_resource_id', id)
      .eq('assigned_resource_type', 'treatment')
      .eq('owner_id', req.ownerId);
      
    if (assignedLeads && assignedLeads.length > 0) {
      // Unassign leads before deletion/deactivation
      await supa
        .from('leads')
        .update({ 
          assigned_resource_id: null,
          assigned_resource_type: null
        })
        .eq('assigned_resource_id', id)
        .eq('assigned_resource_type', 'treatment')
        .eq('owner_id', req.ownerId);
        
      log.info(`Unassigned ${assignedLeads.length} leads from treatment ${id}`);
    }
    
    // Check for existing appointments/sessions
    const { data: sessions } = await supa
      .from('appointments')
      .select('id')
      .eq('resource_id', id)
      .eq('resource_type', 'treatment')
      .eq('owner_id', req.ownerId);
      
    // Check for existing call attempts
    const { data: callAttempts } = await supa
      .from('call_attempts')
      .select('id')
      .eq('resource_id', id)
      .eq('resource_type', 'treatment')
      .eq('owner_id', req.ownerId);
      
    if ((sessions && sessions.length > 0) || (callAttempts && callAttempts.length > 0)) {
      // Deactivate instead of delete if there are existing records
      await supa
        .from('treatments')
        .update({ is_active: false })
        .eq('id', id)
        .eq('owner_id', req.ownerId);
        
      const totalRecords = (sessions?.length || 0) + (callAttempts?.length || 0);
      log.info(`Deactivated treatment ${id} (has ${sessions?.length || 0} sessions, ${callAttempts?.length || 0} call attempts)`);
      
      // Fetch updated treatments list
      const { data: allTreatments } = await supa
        .from('treatments')
        .select('*')
        .eq('owner_id', req.ownerId)
        .eq('is_active', true)
        .order('created_at', { ascending: false });
      
      return res.json({ 
        ok: true, 
        message: `Treatment "${existingTreatment.treatment_name}" deactivated (has existing records: ${totalRecords} total)`,
        treatments: allTreatments || []
      });
    }
    
    // Permanent delete if no sessions or call attempts
    await supa
      .from('treatments')
      .delete()
      .eq('id', id)
      .eq('owner_id', req.ownerId);
      
    log.info(`Permanently deleted treatment ${id} for owner ${req.ownerId}`);
    
    // Fetch updated treatments list
    const { data: allTreatments } = await supa
      .from('treatments')
      .select('*')
      .eq('owner_id', req.ownerId)
      .eq('is_active', true)
      .order('created_at', { ascending: false });
    
    res.json({ 
      ok: true, 
      message: `Treatment "${existingTreatment.treatment_name}" permanently deleted`,
      treatments: allTreatments || []
    });

  } catch (error) {
    log.error('Delete treatment error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to delete treatment'
    });
  }
});

export default router;

