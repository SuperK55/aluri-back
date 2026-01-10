import { Router } from 'express';
import { supa } from '../lib/supabase.js';
import { log } from '../config/logger.js';
import { verifyJWT } from '../middleware/verifyJWT.js';
import { googleCalendarService } from '../services/googleCalendar.js';
import { updateAgentVariablesForLead } from './retell.js';

const router = Router();

/**
 * Get all appointments for the authenticated user
 * GET /api/appointments
 */
router.get('/', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get appointments for this business owner (only fetch leads relationship)
    const { data: appointments, error } = await supa
      .from('appointments')
      .select(`
        *,
        leads(
          id,
          name,
          phone,
          email
        )
      `)
      .eq('owner_id', userId)
      .order('start_at', { ascending: true });

    if (error) {
      throw new Error(error.message);
    }

    // Fetch resources (doctors/treatments) based on resource_type and resource_id
    const resourceIds = {
      doctor: new Set(),
      treatment: new Set()
    };

    appointments?.forEach(appointment => {
      if (appointment.resource_type === 'doctor' && appointment.resource_id) {
        resourceIds.doctor.add(appointment.resource_id);
      } else if (appointment.resource_type === 'treatment' && appointment.resource_id) {
        resourceIds.treatment.add(appointment.resource_id);
      }
    });

    // Fetch all doctors
    const doctorsMap = new Map();
    if (resourceIds.doctor.size > 0) {
      const { data: doctors } = await supa
        .from('doctors')
        .select('id, name, specialty')
        .in('id', Array.from(resourceIds.doctor))
        .eq('owner_id', userId);

      doctors?.forEach(doctor => {
        doctorsMap.set(doctor.id, doctor);
      });
    }

    // Fetch all treatments
    const treatmentsMap = new Map();
    if (resourceIds.treatment.size > 0) {
      const { data: treatments } = await supa
        .from('treatments')
        .select('id, treatment_name as name, main_category, subcategory')
        .in('id', Array.from(resourceIds.treatment))
        .eq('owner_id', userId);

      treatments?.forEach(treatment => {
        treatmentsMap.set(treatment.id, treatment);
      });
    }

    // Transform the data to flatten related information
    const transformedAppointments = appointments?.map(appointment => {
      // Get resource info based on resource_type
      let resourceName = 'Unknown';
      let resourceSpecialty = '';
      
      if (appointment.resource_type === 'doctor' && appointment.resource_id) {
        const doctor = doctorsMap.get(appointment.resource_id);
        resourceName = doctor?.name || 'Unknown Doctor';
        resourceSpecialty = doctor?.specialty || '';
      } else if (appointment.resource_type === 'treatment' && appointment.resource_id) {
        const treatment = treatmentsMap.get(appointment.resource_id);
        resourceName = treatment?.name || 'Unknown Treatment';
        resourceSpecialty = treatment?.subcategory || treatment?.main_category || '';
      }

      return {
        ...appointment,
        // Map to frontend expected field names
        start_time: appointment.start_at,
        end_time: appointment.end_at,
        patient_name: appointment.leads?.name || 'Unknown Patient',
        patient_email: appointment.leads?.email,
        patient_phone: appointment.leads?.phone,
        doctor_name: resourceName,
        doctor_specialty: resourceSpecialty,
        doctor_id: appointment.resource_id, // For backward compatibility
        title: `${appointment.appointment_type} - ${appointment.leads?.name || 'Patient'}`,
        description: appointment.notes,
        google_event_id: appointment.gcal_event_id,
        timezone: appointment.timezone || 'America/Sao_Paulo',
        // Remove nested objects
        leads: undefined
      };
    }) || [];

    res.json({
      ok: true,
      appointments: transformedAppointments
    });

  } catch (error) {
    log.error('Get appointments error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to fetch appointments'
    });
  }
});

/**
 * Create a new appointment
 * POST /api/appointments
 */
router.post('/', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      patient_name,
      patient_email,
      patient_phone,
      doctor_id,
      lead_id,
      title,
      description,
      start_time,
      end_time,
      appointment_type = 'consultation',
      is_telemedicine = false,
      meeting_link,
      office_address,
      price,
      timezone = 'America/Sao_Paulo'
    } = req.body;

    // Validate required fields
    if (!doctor_id || !start_time || !end_time) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: doctor_id, start_time, end_time'
      });
    }

    // Check if it's a doctor or treatment
    let resourceType = 'doctor';
    let resource = null;
    
    // First, try to find as a doctor
    const { data: doctor, error: doctorError } = await supa
      .from('doctors')
      .select('id, name, google_calendar_id, google_refresh_token')
      .eq('id', doctor_id)
      .eq('owner_id', userId)
      .single();

    if (doctor && !doctorError) {
      resource = doctor;
      resourceType = 'doctor';
    } else {
      // If not found as doctor, try as treatment
      const { data: treatment, error: treatmentError } = await supa
        .from('treatments')
        .select('id, treatment_name as name, google_calendar_id, google_refresh_token')
        .eq('id', doctor_id)
        .eq('owner_id', userId)
        .single();

      if (treatment && !treatmentError) {
        resource = treatment;
        resourceType = 'treatment';
      } else {
        return res.status(404).json({
          ok: false,
          error: 'Doctor or treatment not found or does not belong to you'
        });
      }
    }

    // Validate appointment time is in the future
    const appointmentStart = new Date(start_time);
    const now = new Date();
    if (appointmentStart <= now) {
      return res.status(400).json({
        ok: false,
        error: 'Appointment time must be in the future'
      });
    }

    // Check availability if Google Calendar is connected (only for doctors)
    if (resourceType === 'doctor' && resource.google_calendar_id && resource.google_refresh_token) {
      try {
        const endTime = new Date(end_time);
        const availability = await googleCalendarService.getAvailableSlots(
          doctor_id,
          start_time,
          endTime.toISOString()
        );

        // Check if the requested time slot conflicts with busy times
        const requestedStart = new Date(start_time);
        const requestedEnd = new Date(end_time);
        
        const hasConflict = availability.busySlots.some(busySlot => {
          const busyStart = new Date(busySlot.start);
          const busyEnd = new Date(busySlot.end);
          return (requestedStart < busyEnd && requestedEnd > busyStart);
        });

        if (hasConflict) {
          return res.status(409).json({
            ok: false,
            error: 'The requested time slot conflicts with existing appointments',
            availableSlots: availability.availableSlots.slice(0, 10) // Return first 10 available slots
          });
        }

        // Check if the requested time is within doctor's working hours
        const dayName = requestedStart.toLocaleDateString('en-US', { weekday: 'lowercase' });
        const workingHours = availability.workingHours[dayName];
        
        if (!workingHours || !workingHours.enabled) {
          return res.status(400).json({
            ok: false,
            error: `Doctor is not available on ${dayName}`,
            availableSlots: availability.availableSlots.slice(0, 10)
          });
        }

        // Check if requested time falls within any working time slot
        const requestedTimeStr = requestedStart.toTimeString().slice(0, 5); // HH:MM format
        const requestedEndTimeStr = requestedEnd.toTimeString().slice(0, 5);
        
        const isWithinWorkingHours = workingHours.timeSlots?.some(timeSlot => {
          return requestedTimeStr >= timeSlot.start && requestedEndTimeStr <= timeSlot.end;
        });

        if (!isWithinWorkingHours) {
          return res.status(400).json({
            ok: false,
            error: 'The requested time is outside doctor\'s working hours',
            availableSlots: availability.availableSlots.slice(0, 10)
          });
        }

      } catch (availabilityError) {
        log.warn(`Failed to check availability for appointment:`, availabilityError);
        // Continue with appointment creation if availability check fails
      }
    }

    // If lead_id is not provided but we have patient info, try to find or create lead
    let finalLeadId = lead_id;
    if (!lead_id && patient_name) {
      // Try to find existing lead by email or phone
      let existingLead = null;
      if (patient_email) {
        const { data: leadByEmail } = await supa
          .from('leads')
          .select('id')
          .eq('email', patient_email)
          .eq('owner_id', userId)
          .single();
        existingLead = leadByEmail;
      }
      
      if (!existingLead && patient_phone) {
        const { data: leadByPhone } = await supa
          .from('leads')
          .select('id')
          .eq('phone', patient_phone)
          .eq('owner_id', userId)
          .single();
        existingLead = leadByPhone;
      }

      if (existingLead) {
        finalLeadId = existingLead.id;
      } else {
        // Create new lead
        const { data: newLead, error: leadError } = await supa
          .from('leads')
          .insert({
            owner_id: userId,
            name: patient_name,
            email: patient_email,
            phone: patient_phone,
            status: 'appointment_scheduled'
          })
          .select('id')
          .single();

        if (leadError) {
          log.warn('Failed to create lead for appointment:', leadError);
        } else {
          finalLeadId = newLead.id;
        }
      }
    }

    // Create appointment in database
    const { data: appointment, error: appointmentError } = await supa
      .from('appointments')
      .insert({
        owner_id: userId,
        lead_id: finalLeadId,
        resource_type: resourceType,
        resource_id: doctor_id,
        appointment_type,
        start_at: start_time,
        end_at: end_time,
        timezone,
        status: 'scheduled',
        is_telemedicine,
        meeting_link,
        office_address,
        price: price ? parseFloat(price) : null,
        notes: description
      })
      .select()
      .single();

    if (appointmentError) {
      throw new Error(appointmentError.message);
    }

    // Create Google Calendar event if resource has calendar connected
    let googleEventId = null;
    let googleEventLink = null;
    
    if (resource.google_calendar_id && resource.google_refresh_token) {
      try {
        const appointmentData = {
          summary: title || `${appointment_type} - ${patient_name}`,
          description: description || `Appointment with ${patient_name}`,
          start: {
            dateTime: start_time,
            timeZone: timezone
          },
          end: {
            dateTime: end_time,
            timeZone: timezone
          },
          attendees: patient_email ? [{ email: patient_email }] : [],
          location: office_address || undefined,
          conferenceData: is_telemedicine && meeting_link ? {
            createRequest: {
              requestId: `appointment-${appointment.id}`,
              conferenceSolutionKey: { type: 'hangoutsMeet' }
            }
          } : undefined
        };

        // Use appropriate method based on resource type
        let googleEvent;
        if (resourceType === 'treatment') {
          googleEvent = await googleCalendarService.createTreatmentAppointment(userId, appointmentData);
        } else {
          googleEvent = await googleCalendarService.createAppointment(doctor_id, appointmentData);
        }
        
        googleEventId = googleEvent.id;
        googleEventLink = googleEvent.htmlLink;

        // Update appointment with Google Calendar event ID
        await supa
          .from('appointments')
          .update({ gcal_event_id: googleEventId })
          .eq('id', appointment.id);

        log.info(`Google Calendar event created: ${googleEventId} for appointment ${appointment.id}`);
      } catch (calendarError) {
        log.warn(`Failed to create Google Calendar event for appointment ${appointment.id}:`, calendarError);
        // Don't fail the entire appointment creation if Google Calendar fails
      }
    }

    log.info(`Appointment created: ${appointment.id} for ${resourceType} ${doctor_id}`);

    // Update agent_variables in active whatsapp_chats and Retell chats
    if (appointment.lead_id) {
      // Add a small delay to ensure database consistency
      await new Promise(resolve => setTimeout(resolve, 100));
      updateAgentVariablesForLead(appointment.lead_id, 'appointment-create')
        .catch(err => log.warn('Failed to update agent_variables after appointment creation:', err.message));
    }
    
    res.status(201).json({
      ok: true,
      message: 'Appointment created successfully',
      appointment: {
        ...appointment,
        google_event_id: googleEventId,
        google_event_link: googleEventLink
      }
    });

  } catch (error) {
    log.error('Create appointment error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to create appointment'
    });
  }
});

/**
 * Update an appointment
 * PUT /api/appointments/:id
 */
router.put('/:id', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const appointmentId = req.params.id;
    const updateData = req.body;

    // Verify appointment belongs to this user
    const { data: appointment, error: fetchError } = await supa
      .from('appointments')
      .select('*')
      .eq('id', appointmentId)
      .eq('owner_id', userId)
      .single();

    if (fetchError || !appointment) {
      return res.status(404).json({
        ok: false,
        error: 'Appointment not found or access denied'
      });
    }

    // Map frontend field names to database field names
    const mappedUpdateData = {};
    if (updateData.start_time) mappedUpdateData.start_at = updateData.start_time;
    if (updateData.end_time) mappedUpdateData.end_at = updateData.end_time;
    if (updateData.description) mappedUpdateData.notes = updateData.description;
    if (updateData.google_event_id) mappedUpdateData.gcal_event_id = updateData.google_event_id;
    
    // Copy other fields directly
    const directFields = ['appointment_type', 'status', 'is_telemedicine', 'meeting_link', 'office_address', 'price', 'timezone'];
    directFields.forEach(field => {
      if (updateData[field] !== undefined) {
        mappedUpdateData[field] = updateData[field];
      }
    });

    // Update appointment
    const { data: updatedAppointment, error: updateError } = await supa
      .from('appointments')
      .update(mappedUpdateData)
      .eq('id', appointmentId)
      .select()
      .single();

    if (updateError) {
      throw new Error(updateError.message);
    }

    log.info(`Appointment updated: ${appointmentId}`);

    // Update agent_variables in active whatsapp_chats and Retell chats
    if (updatedAppointment.lead_id) {
      updateAgentVariablesForLead(updatedAppointment.lead_id, 'appointment-update')
        .catch(err => log.warn('Failed to update agent_variables after appointment update:', err.message));
    }
    
    res.json({
      ok: true,
      message: 'Appointment updated successfully',
      appointment: updatedAppointment
    });

  } catch (error) {
    log.error('Update appointment error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to update appointment'
    });
  }
});

/**
 * Delete an appointment
 * DELETE /api/appointments/:id
 */
router.delete('/:id', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const appointmentId = req.params.id;

    // Verify appointment belongs to this user
    const { data: appointment, error: fetchError } = await supa
      .from('appointments')
      .select('*')
      .eq('id', appointmentId)
      .eq('owner_id', userId)
      .single();

    if (fetchError || !appointment) {
      return res.status(404).json({
        ok: false,
        error: 'Appointment not found or access denied'
      });
    }

    // Delete appointment
    const { error: deleteError } = await supa
      .from('appointments')
      .delete()
      .eq('id', appointmentId);

    if (deleteError) {
      throw new Error(deleteError.message);
    }

    log.info(`Appointment deleted: ${appointmentId}`);

    // Update agent_variables in active whatsapp_chats and Retell chats
    if (appointment.lead_id) {
      updateAgentVariablesForLead(appointment.lead_id, 'appointment-delete')
        .catch(err => log.warn('Failed to update agent_variables after appointment delete:', err.message));
    }
    
    res.json({
      ok: true,
      message: 'Appointment deleted successfully'
    });

  } catch (error) {
    log.error('Delete appointment error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to delete appointment'
    });
  }
});

/**
 * Get patients/clients for the authenticated user
 * GET /api/patients or /api/clients
 * Returns unique leads with their appointment history
 */
router.get('/patients', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get all appointments with lead information for this business owner
    const { data: appointments, error: appointmentsError } = await supa
      .from('appointments')
      .select(`
        *,
        leads(
          id,
          name,
          phone,
          email,
          city,
          specialty,
          status,
          created_at
        )
      `)
      .eq('owner_id', userId)
      .order('start_at', { ascending: false });

    if (appointmentsError) {
      throw new Error(appointmentsError.message);
    }

    // Fetch resources (doctors/treatments) based on resource_type and resource_id
    const resourceIds = {
      doctor: new Set(),
      treatment: new Set()
    };

    appointments?.forEach(appointment => {
      if (appointment.resource_type === 'doctor' && appointment.resource_id) {
        resourceIds.doctor.add(appointment.resource_id);
      } else if (appointment.resource_type === 'treatment' && appointment.resource_id) {
        resourceIds.treatment.add(appointment.resource_id);
      }
    });

    // Fetch all doctors
    const doctorsMap = new Map();
    if (resourceIds.doctor.size > 0) {
      const { data: doctors } = await supa
        .from('doctors')
        .select('id, name, specialty')
        .in('id', Array.from(resourceIds.doctor))
        .eq('owner_id', userId);

      doctors?.forEach(doctor => {
        doctorsMap.set(doctor.id, doctor);
      });
    }

    // Fetch all treatments
    const treatmentsMap = new Map();
    if (resourceIds.treatment.size > 0) {
      const { data: treatments } = await supa
        .from('treatments')
        .select('id, treatment_name as name, main_category, subcategory')
        .in('id', Array.from(resourceIds.treatment))
        .eq('owner_id', userId);

      treatments?.forEach(treatment => {
        treatmentsMap.set(treatment.id, treatment);
      });
    }

    // Group appointments by lead to create unique patients
    const patientsMap = new Map();

    appointments?.forEach(appointment => {
      const lead = appointment.leads;
      if (!lead || !lead.id) return;

      const leadId = lead.id;
      
      if (!patientsMap.has(leadId)) {
        patientsMap.set(leadId, {
          id: lead.id,
          name: lead.name || 'Unknown',
          phone: lead.phone,
          email: lead.email,
          city: lead.city,
          specialty: lead.specialty,
          status: lead.status,
          first_contact: lead.created_at,
          total_appointments: 0,
          completed_appointments: 0,
          upcoming_appointments: 0,
          last_appointment: null,
          next_appointment: null,
          appointments: []
        });
      }

      const patient = patientsMap.get(leadId);
      
      // Get resource info based on resource_type
      let resourceName = null;
      let resourceSpecialty = null;
      
      if (appointment.resource_type === 'doctor' && appointment.resource_id) {
        const doctor = doctorsMap.get(appointment.resource_id);
        resourceName = doctor?.name;
        resourceSpecialty = doctor?.specialty;
      } else if (appointment.resource_type === 'treatment' && appointment.resource_id) {
        const treatment = treatmentsMap.get(appointment.resource_id);
        resourceName = treatment?.name;
        resourceSpecialty = treatment?.subcategory || treatment?.main_category || '';
      }
      
      const appointmentData = {
        id: appointment.id,
        start_at: appointment.start_at,
        end_at: appointment.end_at,
        status: appointment.status,
        appointment_type: appointment.appointment_type,
        doctor_name: resourceName,
        doctor_specialty: resourceSpecialty || '',
        price: appointment.price,
        timezone: appointment.timezone || 'America/Sao_Paulo'
      };

      patient.appointments.push(appointmentData);
      patient.total_appointments++;

      if (appointment.status === 'completed') {
        patient.completed_appointments++;
      }

      const appointmentDate = new Date(appointment.start_at);
      const now = new Date();

      if (appointmentDate > now && appointment.status !== 'cancelled') {
        patient.upcoming_appointments++;
        if (!patient.next_appointment || new Date(appointment.start_at) < new Date(patient.next_appointment.start_at)) {
          patient.next_appointment = appointmentData;
        }
      }

      if (!patient.last_appointment || new Date(appointment.start_at) > new Date(patient.last_appointment.start_at)) {
        patient.last_appointment = appointmentData;
      }
    });

    // Convert map to array and sort by last appointment date
    const patients = Array.from(patientsMap.values()).sort((a, b) => {
      if (!a.last_appointment) return 1;
      if (!b.last_appointment) return -1;
      return new Date(b.last_appointment.start_at).getTime() - new Date(a.last_appointment.start_at).getTime();
    });

    res.json({
      ok: true,
      patients
    });

  } catch (error) {
    log.error('Get patients error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to fetch patients'
    });
  }
});

// Alias for beauty clinic clients - same logic as patients
router.get('/clients', verifyJWT, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get all appointments with lead information for this business owner
    const { data: appointments, error: appointmentsError } = await supa
      .from('appointments')
      .select(`
        *,
        leads(
          id,
          name,
          phone,
          email,
          city,
          specialty,
          status,
          created_at
        )
      `)
      .eq('owner_id', userId)
      .order('start_at', { ascending: false });

    if (appointmentsError) {
      throw new Error(appointmentsError.message);
    }

    // Fetch resources (doctors/treatments) based on resource_type and resource_id
    const resourceIds = {
      doctor: new Set(),
      treatment: new Set()
    };

    appointments?.forEach(appointment => {
      if (appointment.resource_type === 'doctor' && appointment.resource_id) {
        resourceIds.doctor.add(appointment.resource_id);
      } else if (appointment.resource_type === 'treatment' && appointment.resource_id) {
        resourceIds.treatment.add(appointment.resource_id);
      }
    });

    // Fetch all doctors
    const doctorsMap = new Map();
    if (resourceIds.doctor.size > 0) {
      const { data: doctors } = await supa
        .from('doctors')
        .select('id, name, specialty')
        .in('id', Array.from(resourceIds.doctor))
        .eq('owner_id', userId);

      doctors?.forEach(doctor => {
        doctorsMap.set(doctor.id, doctor);
      });
    }

    // Fetch all treatments
    const treatmentsMap = new Map();
    if (resourceIds.treatment.size > 0) {
      const { data: treatments } = await supa
        .from('treatments')
        .select('id, treatment_name as name, main_category, subcategory')
        .in('id', Array.from(resourceIds.treatment))
        .eq('owner_id', userId);

      treatments?.forEach(treatment => {
        treatmentsMap.set(treatment.id, treatment);
      });
    }

    // Group appointments by lead to create unique clients
    const clientsMap = new Map();

    appointments?.forEach(appointment => {
      const lead = appointment.leads;
      if (!lead || !lead.id) return;

      const leadId = lead.id;
      
      if (!clientsMap.has(leadId)) {
        clientsMap.set(leadId, {
          id: lead.id,
          name: lead.name || 'Unknown',
          phone: lead.phone,
          email: lead.email,
          city: lead.city,
          specialty: lead.specialty,
          status: lead.status,
          first_contact: lead.created_at,
          total_appointments: 0,
          completed_appointments: 0,
          upcoming_appointments: 0,
          last_appointment: null,
          next_appointment: null,
          appointments: []
        });
      }

      const client = clientsMap.get(leadId);
      
      // Get resource info based on resource_type
      let resourceName = null;
      let resourceSpecialty = null;
      
      if (appointment.resource_type === 'doctor' && appointment.resource_id) {
        const doctor = doctorsMap.get(appointment.resource_id);
        resourceName = doctor?.name;
        resourceSpecialty = doctor?.specialty;
      } else if (appointment.resource_type === 'treatment' && appointment.resource_id) {
        const treatment = treatmentsMap.get(appointment.resource_id);
        resourceName = treatment?.name;
        resourceSpecialty = treatment?.subcategory || treatment?.main_category || '';
      }
      
      const appointmentData = {
        id: appointment.id,
        start_at: appointment.start_at,
        end_at: appointment.end_at,
        status: appointment.status,
        appointment_type: appointment.appointment_type,
        doctor_name: resourceName,
        doctor_specialty: resourceSpecialty || '',
        price: appointment.price,
        timezone: appointment.timezone || 'America/Sao_Paulo'
      };

      client.appointments.push(appointmentData);
      client.total_appointments++;

      if (appointment.status === 'completed') {
        client.completed_appointments++;
      }

      const appointmentDate = new Date(appointment.start_at);
      const now = new Date();

      if (appointmentDate > now && appointment.status !== 'cancelled') {
        client.upcoming_appointments++;
        if (!client.next_appointment || new Date(appointment.start_at) < new Date(client.next_appointment.start_at)) {
          client.next_appointment = appointmentData;
        }
      }

      if (!client.last_appointment || new Date(appointment.start_at) > new Date(client.last_appointment.start_at)) {
        client.last_appointment = appointmentData;
      }
    });

    // Convert map to array and sort by last appointment date
    const clients = Array.from(clientsMap.values()).sort((a, b) => {
      if (!a.last_appointment) return 1;
      if (!b.last_appointment) return -1;
      return new Date(b.last_appointment.start_at).getTime() - new Date(a.last_appointment.start_at).getTime();
    });

    res.json({
      ok: true,
      patients: clients // Return as 'patients' for consistency with frontend
    });

  } catch (error) {
    log.error('Get clients error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to fetch clients'
    });
  }
});

export default router;
