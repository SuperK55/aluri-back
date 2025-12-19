import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { supa } from '../lib/supabase.js';
import { env } from '../config/env.js';
import { log } from '../config/logger.js';
import { agentManager } from '../services/agentManager.js';
import { googleCalendarService } from '../services/googleCalendar.js';

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

    // Check if user is active (if column exists)
    if (user.is_active === false) {
      return res.status(401).json({
        ok: false,
        error: 'User account is inactive'
      });
    }

    req.ownerId = user.id;
    req.ownerRole = user.role;
    req.businessName = user.name; // Use name instead of business_name
    next();

  } catch (error) {
    return res.status(401).json({
      ok: false,
      error: 'Invalid token'
    });
  }
};

// Get all doctors for the business owner
router.get('/doctors', authenticateOwner, async (req, res) => {
  try {
    const { active_only = true } = req.query;
    
    const doctors = await agentManager.getDoctorsForOwner(req.ownerId, {
      activeOnly: active_only === 'true'
    });

    res.json({
      ok: true,
      doctors
    });

  } catch (error) {
    log.error('Get doctors error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to fetch doctors'
    });
  }
});

// Get a specific doctor by ID
router.get('/doctors/:doctorId', authenticateOwner, async (req, res) => {
  try {
    const { doctorId } = req.params;

    const { data: doctor, error } = await supa
      .from('doctors')
      .select('*')
      .eq('id', doctorId)
      .eq('owner_id', req.ownerId)
      .single();

    if (error || !doctor) {
      return res.status(404).json({
        ok: false,
        error: 'Doctor not found'
      });
    }

    res.json({
      ok: true,
      doctor
    });

  } catch (error) {
    log.error('Get doctor error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to fetch doctor'
    });
  }
});

// Create a new doctor
router.post('/doctors', authenticateOwner, async (req, res) => {
  try {
    const doctorData = req.body;

    // Add owner_id to the doctor data
    doctorData.owner_id = req.ownerId;

    const newDoctor = await agentManager.createDoctor(req.ownerId, doctorData);

    // Fetch updated doctors list
    const doctors = await agentManager.getDoctorsForOwner(req.ownerId, {
      activeOnly: true
    });

    res.status(201).json({
      ok: true,
      message: 'Doctor created successfully',
      doctor: newDoctor,
      doctors: doctors || []
    });

  } catch (error) {
    log.error('Create doctor error:', error);
    
    if (error.message.includes('required')) {
      return res.status(400).json({
        ok: false,
        error: error.message
      });
    }

    res.status(500).json({
      ok: false,
      error: 'Failed to create doctor'
    });
  }
});

// Update a doctor
router.put('/doctors/:doctorId', authenticateOwner, async (req, res) => {
  try {
    const { doctorId } = req.params;
    const updates = req.body;

    // Remove owner_id from updates to prevent changing ownership
    delete updates.owner_id;

    // Verify doctor belongs to this owner
    const { data: existingDoctor, error: checkError } = await supa
      .from('doctors')
      .select('id')
      .eq('id', doctorId)
      .eq('owner_id', req.ownerId)
      .single();

    if (checkError || !existingDoctor) {
      return res.status(404).json({
        ok: false,
        error: 'Doctor not found'
      });
    }

    // Update doctor
    const { data: updatedDoctor, error: updateError } = await supa
      .from('doctors')
      .update(updates)
      .eq('id', doctorId)
      .select()
      .single();

    if (updateError) {
      log.error('Update doctor error:', updateError);
      return res.status(500).json({
        ok: false,
        error: 'Failed to update doctor'
      });
    }

    // Fetch updated doctors list
    const doctors = await agentManager.getDoctorsForOwner(req.ownerId, {
      activeOnly: true
    });

    res.json({
      ok: true,
      message: 'Doctor updated successfully',
      doctor: updatedDoctor,
      doctors: doctors || []
    });

  } catch (error) {
    log.error('Update doctor error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to update doctor'
    });
  }
});

// Delete (deactivate) a doctor
router.delete('/doctors/:doctorId', authenticateOwner, async (req, res) => {
  try {
    const { doctorId } = req.params;

    // Verify doctor belongs to this owner
    const { data: existingDoctor, error: checkError } = await supa
      .from('doctors')
      .select('id, name')
      .eq('id', doctorId)
      .eq('owner_id', req.ownerId)
      .single();

    if (checkError || !existingDoctor) {
      return res.status(404).json({
        ok: false,
        error: 'Doctor not found'
      });
    }

    // Check if doctor has any assigned leads (resource assignment)
    const { data: assignedLeads, error: leadsError } = await supa
      .from('leads')
      .select('id, name')
      .eq('assigned_resource_id', doctorId)
      .eq('assigned_resource_type', 'doctor')
      .eq('owner_id', req.ownerId);

    if (leadsError) {
      log.error('Error checking assigned leads:', leadsError);
      return res.status(500).json({
        ok: false,
        error: 'Failed to check doctor assignments'
      });
    }

    // If doctor has assigned leads, unassign them first
    if (assignedLeads && assignedLeads.length > 0) {
      const { error: unassignError } = await supa
        .from('leads')
        .update({ assigned_resource_id: null, assigned_resource_type: null })
        .eq('assigned_resource_id', doctorId)
        .eq('assigned_resource_type', 'doctor')
        .eq('owner_id', req.ownerId);

      if (unassignError) {
        log.error('Error unassigning leads from doctor:', unassignError);
        return res.status(500).json({
          ok: false,
          error: 'Failed to unassign leads from doctor'
        });
      }

      log.info(`Unassigned ${assignedLeads.length} leads from doctor ${doctorId}`);
    }

    // Check if doctor has any appointments
    const { data: appointments, error: appointmentsError } = await supa
      .from('appointments')
      .select('id')
      .eq('resource_type', 'doctor')
      .eq('resource_id', doctorId)
      .eq('owner_id', req.ownerId);

    if (appointmentsError) {
      log.error('Error checking doctor appointments:', appointmentsError);
      return res.status(500).json({
        ok: false,
        error: 'Failed to check doctor appointments'
      });
    }

    // Check if doctor has any call attempts
    const { data: callAttempts, error: callAttemptsError } = await supa
      .from('call_attempts')
      .select('id')
      .eq('doctor_id', doctorId)
      .eq('owner_id', req.ownerId);

    if (callAttemptsError) {
      log.error('Error checking doctor call attempts:', callAttemptsError);
      return res.status(500).json({
        ok: false,
        error: 'Failed to check doctor call attempts'
      });
    }

    // If doctor has appointments or call attempts, we should not delete them but deactivate the doctor instead
    if ((appointments && appointments.length > 0) || (callAttempts && callAttempts.length > 0)) {
      // Deactivate doctor instead of deleting
      const { error: deactivateError } = await supa
        .from('doctors')
        .update({ is_active: false })
        .eq('id', doctorId);

      if (deactivateError) {
        log.error('Error deactivating doctor:', deactivateError);
        return res.status(500).json({
          ok: false,
          error: 'Failed to deactivate doctor'
        });
      }

      const totalRecords = (appointments?.length || 0) + (callAttempts?.length || 0);
      log.info(`Deactivated doctor ${doctorId} (has ${appointments?.length || 0} appointments, ${callAttempts?.length || 0} call attempts)`);
      
      // Fetch updated doctors list
      const doctors = await agentManager.getDoctorsForOwner(req.ownerId, {
        activeOnly: true
      });
      
      return res.json({
        ok: true,
        message: `Doctor ${existingDoctor.name} deactivated (has existing records: ${totalRecords} total)`,
        doctors: doctors || []
      });
    } else {
      // No appointments, safe to delete permanently
      const { error: doctorError } = await supa
        .from('doctors')
        .delete()
        .eq('id', doctorId);

      if (doctorError) {
        log.error('Delete doctor error:', doctorError);
        return res.status(500).json({
          ok: false,
          error: 'Failed to delete doctor'
        });
      }

      log.info(`Permanently deleted doctor ${doctorId} for owner ${req.ownerId}`);
      
      // Fetch updated doctors list
      const doctors = await agentManager.getDoctorsForOwner(req.ownerId, {
        activeOnly: true
      });
      
      res.json({
        ok: true,
        message: `Doctor ${existingDoctor.name} permanently deleted`,
        doctors: doctors || []
      });
    }

  } catch (error) {
    log.error('Delete doctor error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to delete doctor'
    });
  }
});

// Get available specialties
router.get('/specialties', authenticateOwner, async (req, res) => {
  try {
    const { data: specialties, error } = await supa
      .from('specialties')
      .select('*')
      .order('name');

    if (error) {
      throw error;
    }

    res.json({
      ok: true,
      specialties: specialties || []
    });

  } catch (error) {
    log.error('Get specialties error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to fetch specialties'
    });
  }
});

// Bulk operations for doctors
router.post('/doctors/bulk-action', authenticateOwner, async (req, res) => {
  try {
    const { action, doctor_ids } = req.body;

    if (!action || !Array.isArray(doctor_ids) || doctor_ids.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Action and doctor_ids array are required'
      });
    }

    // Verify all doctors belong to this owner
    const { data: doctors, error: verifyError } = await supa
      .from('doctors')
      .select('id, name')
      .eq('owner_id', req.ownerId)
      .in('id', doctor_ids);

    if (verifyError || doctors.length !== doctor_ids.length) {
      return res.status(400).json({
        ok: false,
        error: 'Some doctors not found or do not belong to you'
      });
    }

    let updateData = {};
    let message = '';

    switch (action) {
      case 'activate':
        updateData = { is_active: true };
        message = `${doctors.length} doctor(s) activated`;
        break;
      case 'deactivate':
        updateData = { is_active: false };
        message = `${doctors.length} doctor(s) deactivated`;
        break;
      default:
        return res.status(400).json({
          ok: false,
          error: 'Invalid action. Supported actions: activate, deactivate'
        });
    }

    // Perform bulk update
    const { error: updateError } = await supa
      .from('doctors')
      .update(updateData)
      .in('id', doctor_ids);

    if (updateError) {
      log.error('Bulk doctor update error:', updateError);
      return res.status(500).json({
        ok: false,
        error: 'Failed to perform bulk action'
      });
    }

    res.json({
      ok: true,
      message,
      affected_doctors: doctors.length
    });

  } catch (error) {
    log.error('Bulk doctor action error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to perform bulk action'
    });
  }
});

// ========================================
// DOCTOR CALENDAR MANAGEMENT ROUTES
// ========================================

/**
 * Get doctor's calendar settings and availability
 * GET /api/doctors/:doctorId/calendar
 */
router.get('/doctors/:doctorId/calendar', authenticateOwner, async (req, res) => {
  try {
    const { doctorId } = req.params;

    // Verify doctor belongs to this owner
    const { data: doctor, error: doctorError } = await supa
      .from('doctors')
      .select('id, name, working_hours, consultation_duration, timezone, google_calendar_id, calendar_sync_enabled, last_calendar_sync')
      .eq('id', doctorId)
      .eq('owner_id', req.ownerId)
      .single();

    if (doctorError || !doctor) {
      return res.status(404).json({
        ok: false,
        error: 'Doctor not found'
      });
    }

    res.json({
      ok: true,
      doctor: {
        id: doctor.id,
        name: doctor.name,
        workingHours: doctor.working_hours,
        consultationDuration: doctor.consultation_duration,
        timezone: doctor.timezone,
        googleCalendarConnected: !!doctor.google_calendar_id,
        calendarSyncEnabled: doctor.calendar_sync_enabled,
        lastCalendarSync: doctor.last_calendar_sync
      }
    });

  } catch (error) {
    log.error('Get doctor calendar settings error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to get doctor calendar settings'
    });
  }
});

/**
 * Update doctor's working hours
 * PUT /api/doctors/:doctorId/calendar/working-hours
 */
router.put('/doctors/:doctorId/calendar/working-hours', authenticateOwner, async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { working_hours } = req.body;

    if (!working_hours) {
      return res.status(400).json({
        ok: false,
        error: 'Working hours are required'
      });
    }

    // Verify doctor belongs to this owner
    const { data: existingDoctor, error: checkError } = await supa
      .from('doctors')
      .select('id')
      .eq('id', doctorId)
      .eq('owner_id', req.ownerId)
      .single();

    if (checkError || !existingDoctor) {
      return res.status(404).json({
        ok: false,
        error: 'Doctor not found'
      });
    }

    // Update working hours
    const { data: updatedDoctor, error: updateError } = await supa
      .from('doctors')
      .update({ working_hours })
      .eq('id', doctorId)
      .select('id, name, working_hours')
      .single();

    if (updateError) {
      log.error('Update working hours error:', updateError);
      return res.status(500).json({
        ok: false,
        error: 'Failed to update working hours'
      });
    }

    log.info(`Updated working hours for doctor ${doctorId}`);

    res.json({
      ok: true,
      message: 'Working hours updated successfully',
      doctor: updatedDoctor
    });

  } catch (error) {
    log.error('Update working hours error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to update working hours'
    });
  }
});

/**
 * Get doctor's availability for a date range
 * GET /api/doctors/:doctorId/calendar/availability
 * Query params: startDate, endDate (ISO 8601 format)
 */
router.get('/doctors/:doctorId/calendar/availability', authenticateOwner, async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { startDate, endDate } = req.query;

    // Validate required query parameters
    if (!startDate || !endDate) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required query parameters: startDate and endDate (ISO 8601 format)'
      });
    }

    // Validate date format
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid date format. Use ISO 8601 format (e.g., 2024-01-20T00:00:00-03:00)'
      });
    }

    if (start >= end) {
      return res.status(400).json({
        ok: false,
        error: 'startDate must be before endDate'
      });
    }

    // Verify doctor belongs to this owner
    const { data: doctor, error: doctorError } = await supa
      .from('doctors')
      .select('id, name, google_calendar_id, google_refresh_token, working_hours, date_specific_availability, consultation_duration, timezone')
      .eq('id', doctorId)
      .eq('owner_id', req.ownerId)
      .single();

    if (doctorError || !doctor) {
      return res.status(404).json({
        ok: false,
        error: 'Doctor not found'
      });
    }

    // If Google Calendar is connected, get busy slots from Google Calendar
    let availabilityData = {
      availableSlots: [],
      busySlots: [],
      workingHours: doctor.working_hours,
      dateSpecificAvailability: doctor.date_specific_availability || [],
      consultationDuration: doctor.consultation_duration || 90,
      timezone: doctor.timezone || 'America/Sao_Paulo'
    };

    if (doctor.google_calendar_id && doctor.google_refresh_token) {
      try {
        const availability = await googleCalendarService.getAvailableSlots(
          doctorId,
          startDate,
          endDate
        );
        availabilityData = availability;
      } catch (calendarError) {
        log.warn(`Failed to get Google Calendar availability for doctor ${doctorId}:`, calendarError);
        // Continue without Google Calendar data
      }
    }

    res.json({
      ok: true,
      doctor: {
        id: doctor.id,
        name: doctor.name,
        workingHours: doctor.working_hours,
        dateSpecificAvailability: doctor.date_specific_availability || [],
        consultationDuration: doctor.consultation_duration || 90,
        timezone: doctor.timezone || 'America/Sao_Paulo',
        googleCalendarConnected: !!doctor.google_calendar_id
      },
      availability: {
        availableSlots: availabilityData.availableSlots,
        busySlots: availabilityData.busySlots,
        workingHours: availabilityData.workingHours,
        dateSpecificAvailability: availabilityData.dateSpecificAvailability,
        consultationDuration: availabilityData.consultationDuration,
        timezone: availabilityData.timezone,
        timeRange: {
          start: startDate,
          end: endDate
        }
      }
    });

  } catch (error) {
    log.error('Get doctor availability error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to get doctor availability'
    });
  }
});

/**
 * Update doctor's consultation duration
 * PUT /api/doctors/:doctorId/calendar/consultation-duration
 */
router.put('/doctors/:doctorId/calendar/consultation-duration', authenticateOwner, async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { consultation_duration } = req.body;

    if (!consultation_duration || consultation_duration < 15 || consultation_duration > 480) {
      return res.status(400).json({
        ok: false,
        error: 'Consultation duration must be between 15 and 480 minutes'
      });
    }

    // Verify doctor belongs to this owner
    const { data: existingDoctor, error: checkError } = await supa
      .from('doctors')
      .select('id')
      .eq('id', doctorId)
      .eq('owner_id', req.ownerId)
      .single();

    if (checkError || !existingDoctor) {
      return res.status(404).json({
        ok: false,
        error: 'Doctor not found'
      });
    }

    // Update consultation duration
    const { data: updatedDoctor, error: updateError } = await supa
      .from('doctors')
      .update({ consultation_duration: parseInt(consultation_duration) })
      .eq('id', doctorId)
      .select('id, name, consultation_duration')
      .single();

    if (updateError) {
      log.error('Update consultation duration error:', updateError);
      return res.status(500).json({
        ok: false,
        error: 'Failed to update consultation duration'
      });
    }

    log.info(`Updated consultation duration for doctor ${doctorId} to ${consultation_duration} minutes`);

    res.json({
      ok: true,
      message: 'Consultation duration updated successfully',
      doctor: updatedDoctor
    });

  } catch (error) {
    log.error('Update consultation duration error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to update consultation duration'
    });
  }
});

/**
 * Get doctor's date-specific availability
 * GET /api/doctors/:doctorId/calendar/date-specific
 */
router.get('/doctors/:doctorId/calendar/date-specific', authenticateOwner, async (req, res) => {
  try {
    const { doctorId } = req.params;

    // Verify doctor belongs to this owner
    const { data: doctor, error: doctorError } = await supa
      .from('doctors')
      .select('id, name, date_specific_availability')
      .eq('id', doctorId)
      .eq('owner_id', req.ownerId)
      .single();

    if (doctorError || !doctor) {
      return res.status(404).json({
        ok: false,
        error: 'Doctor not found'
      });
    }

    res.json({
      ok: true,
      doctor: {
        id: doctor.id,
        name: doctor.name,
        dateSpecificAvailability: doctor.date_specific_availability || []
      }
    });

  } catch (error) {
    log.error('Get date-specific availability error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to get date-specific availability'
    });
  }
});

/**
 * Update doctor's date-specific availability
 * PUT /api/doctors/:doctorId/calendar/date-specific
 */
router.put('/doctors/:doctorId/calendar/date-specific', authenticateOwner, async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { date_specific_availability } = req.body;

    if (!Array.isArray(date_specific_availability)) {
      return res.status(400).json({
        ok: false,
        error: 'Date-specific availability must be an array'
      });
    }

    // Normalize date string to YYYY-MM-DD format
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

    // Validate and normalize each availability entry
    const normalizedAvailability = date_specific_availability.map(availability => {
      if (!availability.date || !availability.type) {
        throw new Error('Each availability entry must have date and type');
      }

      if (!['unavailable', 'modified_hours'].includes(availability.type)) {
        throw new Error('Type must be either "unavailable" or "modified_hours"');
      }

      if (availability.type === 'modified_hours' && (!availability.start || !availability.end)) {
        throw new Error('Modified hours must have start and end times');
      }

      // Normalize the date to YYYY-MM-DD format
      const normalizedDate = normalizeDateString(availability.date);
      log.debug(`Normalizing date: ${availability.date} -> ${normalizedDate}`);

      return {
        ...availability,
        date: normalizedDate
      };
    });

    // Verify doctor belongs to this owner
    const { data: existingDoctor, error: checkError } = await supa
      .from('doctors')
      .select('id')
      .eq('id', doctorId)
      .eq('owner_id', req.ownerId)
      .single();

    if (checkError || !existingDoctor) {
      return res.status(404).json({
        ok: false,
        error: 'Doctor not found'
      });
    }

    // Update date-specific availability with normalized dates
    const { data: updatedDoctor, error: updateError } = await supa
      .from('doctors')
      .update({ date_specific_availability: normalizedAvailability })
      .eq('id', doctorId)
      .select('id, name, date_specific_availability')
      .single();

    if (updateError) {
      log.error('Update date-specific availability error:', updateError);
      return res.status(500).json({
        ok: false,
        error: 'Failed to update date-specific availability'
      });
    }

    log.info(`Updated date-specific availability for doctor ${doctorId}`);

    res.json({
      ok: true,
      message: 'Date-specific availability updated successfully',
      doctor: updatedDoctor
    });

  } catch (error) {
    log.error('Update date-specific availability error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to update date-specific availability'
    });
  }
});

/**
 * Add a single date-specific availability entry
 * POST /api/doctors/:doctorId/calendar/date-specific
 */
router.post('/doctors/:doctorId/calendar/date-specific', authenticateOwner, async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { date, type, reason, start, end } = req.body;

    if (!date || !type) {
      return res.status(400).json({
        ok: false,
        error: 'Date and type are required'
      });
    }

    if (!['unavailable', 'modified_hours'].includes(type)) {
      return res.status(400).json({
        ok: false,
        error: 'Type must be either "unavailable" or "modified_hours"'
      });
    }

    if (type === 'modified_hours' && (!start || !end)) {
      return res.status(400).json({
        ok: false,
        error: 'Modified hours must have start and end times'
      });
    }

    // Verify doctor belongs to this owner
    const { data: doctor, error: doctorError } = await supa
      .from('doctors')
      .select('id, name, date_specific_availability')
      .eq('id', doctorId)
      .eq('owner_id', req.ownerId)
      .single();

    if (doctorError || !doctor) {
      return res.status(404).json({
        ok: false,
        error: 'Doctor not found'
      });
    }

    // Normalize date string to YYYY-MM-DD format
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

    // Normalize the incoming date
    const normalizedDate = normalizeDateString(date);
    log.debug(`Normalizing date for POST: ${date} -> ${normalizedDate}`);

    // Check if date already exists (compare normalized dates)
    const existingAvailability = doctor.date_specific_availability || [];
    const existingEntry = existingAvailability.find(entry => {
      const entryDate = normalizeDateString(entry.date);
      return entryDate === normalizedDate;
    });

    if (existingEntry) {
      return res.status(400).json({
        ok: false,
        error: 'Date-specific availability already exists for this date'
      });
    }

    // Add new availability entry with normalized date
    const newEntry = {
      id: Date.now().toString(),
      date: normalizedDate,
      type,
      reason: reason || '',
      ...(type === 'modified_hours' && { start, end })
    };

    const updatedAvailability = [...existingAvailability, newEntry];

    // Update database
    const { data: updatedDoctor, error: updateError } = await supa
      .from('doctors')
      .update({ date_specific_availability: updatedAvailability })
      .eq('id', doctorId)
      .select('id, name, date_specific_availability')
      .single();

    if (updateError) {
      log.error('Add date-specific availability error:', updateError);
      return res.status(500).json({
        ok: false,
        error: 'Failed to add date-specific availability'
      });
    }

    log.info(`Added date-specific availability for doctor ${doctorId} on ${date}`);

    res.json({
      ok: true,
      message: 'Date-specific availability added successfully',
      doctor: updatedDoctor,
      newEntry
    });

  } catch (error) {
    log.error('Add date-specific availability error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to add date-specific availability'
    });
  }
});

/**
 * Delete a date-specific availability entry
 * DELETE /api/doctors/:doctorId/calendar/date-specific/:entryId
 */
router.delete('/doctors/:doctorId/calendar/date-specific/:entryId', authenticateOwner, async (req, res) => {
  try {
    const { doctorId, entryId } = req.params;

    // Verify doctor belongs to this owner
    const { data: doctor, error: doctorError } = await supa
      .from('doctors')
      .select('id, name, date_specific_availability')
      .eq('id', doctorId)
      .eq('owner_id', req.ownerId)
      .single();

    if (doctorError || !doctor) {
      return res.status(404).json({
        ok: false,
        error: 'Doctor not found'
      });
    }

    // Remove the entry
    const existingAvailability = doctor.date_specific_availability || [];
    const updatedAvailability = existingAvailability.filter(entry => entry.id !== entryId);

    if (updatedAvailability.length === existingAvailability.length) {
      return res.status(404).json({
        ok: false,
        error: 'Date-specific availability entry not found'
      });
    }

    // Update database
    const { data: updatedDoctor, error: updateError } = await supa
      .from('doctors')
      .update({ date_specific_availability: updatedAvailability })
      .eq('id', doctorId)
      .select('id, name, date_specific_availability')
      .single();

    if (updateError) {
      log.error('Delete date-specific availability error:', updateError);
      return res.status(500).json({
        ok: false,
        error: 'Failed to delete date-specific availability'
      });
    }

    log.info(`Deleted date-specific availability entry ${entryId} for doctor ${doctorId}`);

    res.json({
      ok: true,
      message: 'Date-specific availability deleted successfully',
      doctor: updatedDoctor
    });

  } catch (error) {
    log.error('Delete date-specific availability error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to delete date-specific availability'
    });
  }
});

export default router; 