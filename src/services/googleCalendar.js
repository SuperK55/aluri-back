import { google } from 'googleapis';
import { supa } from '../lib/supabase.js';
import { log } from '../config/logger.js';
import { env } from '../config/env.js';

class GoogleCalendarService {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      `${env.APP_BASE_URL}/api/google-calendar/callback`
    );
  }

  /**
   * Get authenticated calendar client for a doctor
   */
  async getCalendarClient(doctorId) {
    try {
      // Get doctor's Google Calendar credentials
      const { data: doctor, error } = await supa
        .from('doctors')
        .select('google_calendar_id, google_refresh_token, google_access_token, google_token_expires_at')
        .eq('id', doctorId)
        .single();

      if (error || !doctor) {
        throw new Error('Doctor not found');
      }

      if (!doctor.google_refresh_token) {
        throw new Error('Google Calendar not connected for this doctor');
      }

      // Set credentials
      this.oauth2Client.setCredentials({
        refresh_token: doctor.google_refresh_token,
        access_token: doctor.google_access_token
      });

      // Check if token needs refresh
      const now = new Date();
      const expiresAt = doctor.google_token_expires_at ? new Date(doctor.google_token_expires_at) : null;

      if (!expiresAt || now >= expiresAt) {
        try {
        // Refresh access token
        const { credentials } = await this.oauth2Client.refreshAccessToken();
        this.oauth2Client.setCredentials(credentials);

        // Update tokens in database
        await supa
          .from('doctors')
          .update({
            google_access_token: credentials.access_token,
            google_token_expires_at: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null
          })
          .eq('id', doctorId);

        log.info(`Refreshed Google Calendar token for doctor ${doctorId}`);
        } catch (refreshError) {
          // Check if refresh token has expired or been revoked
          const isInvalidGrant = refreshError.response?.data?.error === 'invalid_grant' || 
                                 refreshError.message?.includes('invalid_grant') ||
                                 refreshError.message?.includes('Token has been expired or revoked');

          if (isInvalidGrant) {
            log.warn(`Google Calendar refresh token expired for doctor ${doctorId}. Marking as disconnected.`);
            
            // Mark calendar as disconnected (but keep the calendar_id for reference)
            await supa
              .from('doctors')
              .update({
                calendar_sync_enabled: false,
                google_refresh_token: null,
                google_access_token: null,
                google_token_expires_at: null
              })
              .eq('id', doctorId);

            throw new Error('Google Calendar refresh token expired. Please reconnect your calendar.');
          }
          
          // Re-throw other errors
          throw refreshError;
        }
      }

      return google.calendar({ version: 'v3', auth: this.oauth2Client });

    } catch (error) {
      log.error('Error getting calendar client:', error);
      throw error;
    }
  }

  /**
   * Create an appointment in Google Calendar
   */
  async createAppointment(doctorId, appointmentData) {
    try {
      const calendar = await this.getCalendarClient(doctorId);

      const { data: doctor } = await supa
        .from('doctors')
        .select('google_calendar_id, name')
        .eq('id', doctorId)
        .single();

      if (!doctor) {
        throw new Error(`Doctor ${doctorId} not found`);
      }

      if (!doctor.google_calendar_id) {
        throw new Error(`Doctor ${doctorId} (${doctor.name}) does not have a Google Calendar ID configured`);
      }

      // Verify the calendar exists and is accessible, and get its timezone
      let calendarTimezone = 'America/Sao_Paulo';
      try {
        const calendarInfo = await calendar.calendars.get({
          calendarId: doctor.google_calendar_id
        });
        calendarTimezone = calendarInfo.data.timeZone || 'America/Sao_Paulo';
        log.info(`Verified calendar access for doctor ${doctorId}:`, {
          calendarId: doctor.google_calendar_id,
          calendarSummary: calendarInfo.data.summary,
          calendarTimeZone: calendarTimezone
        });
      } catch (calendarCheckError) {
        log.error(`Cannot access calendar ${doctor.google_calendar_id} for doctor ${doctorId}:`, calendarCheckError.message);
        throw new Error(`Calendar ${doctor.google_calendar_id} is not accessible: ${calendarCheckError.message}`);
      }

      // Handle both old format (startTime/endTime) and new format (start.dateTime/end.dateTime)
      let startDateTime, endDateTime, appointmentTimezone;
      
      if (appointmentData.start && appointmentData.start.dateTime) {
        // New format from consultation endpoint
        startDateTime = appointmentData.start.dateTime;
        endDateTime = appointmentData.end.dateTime;
        appointmentTimezone = appointmentData.start.timeZone || appointmentData.end.timeZone || 'America/Sao_Paulo';
      } else {
        // Old format from appointments endpoint
        startDateTime = appointmentData.startTime;
        endDateTime = appointmentData.endTime;
        appointmentTimezone = appointmentData.timezone || 'America/Sao_Paulo';
      }

      // Convert appointment times to calendar's timezone
      // Parse the appointment datetime and convert to calendar timezone
      const startDate = new Date(startDateTime);
      const endDate = new Date(endDateTime);
      
      // Format dates in the calendar's timezone
      const formatDateTimeForTimezone = (date, timezone) => {
        // Use Intl.DateTimeFormat to format in the target timezone
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
        
        const parts = formatter.formatToParts(date);
        const year = parts.find(p => p.type === 'year').value;
        const month = parts.find(p => p.type === 'month').value;
        const day = parts.find(p => p.type === 'day').value;
        const hour = parts.find(p => p.type === 'hour').value;
        const minute = parts.find(p => p.type === 'minute').value;
        const second = parts.find(p => p.type === 'second').value;
        
        // Calculate timezone offset for the calendar timezone
        // Create a date formatter to get the offset
        const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
        const tzDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
        const offsetMs = tzDate.getTime() - utcDate.getTime();
        const offsetHours = Math.floor(Math.abs(offsetMs) / (1000 * 60 * 60));
        const offsetMinutes = Math.floor((Math.abs(offsetMs) % (1000 * 60 * 60)) / (1000 * 60));
        const offsetSign = offsetMs >= 0 ? '+' : '-';
        const offset = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;
        
        return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
      };
      
      const startDateTimeInCalendarTZ = formatDateTimeForTimezone(startDate, calendarTimezone);
      const endDateTimeInCalendarTZ = formatDateTimeForTimezone(endDate, calendarTimezone);

      log.info('Creating Google Calendar event with:', { 
        originalStart: startDateTime,
        originalEnd: endDateTime,
        originalTimezone: appointmentTimezone,
        calendarTimezone: calendarTimezone,
        convertedStart: startDateTimeInCalendarTZ,
        convertedEnd: endDateTimeInCalendarTZ
      });

      const event = {
        summary: appointmentData.summary || appointmentData.title || `Consulta com ${appointmentData.patientName || 'Paciente'}`,
        description: appointmentData.description || `Consulta médica com ${appointmentData.patientName || 'Paciente'}`,
        start: {
          dateTime: startDateTimeInCalendarTZ,
          timeZone: calendarTimezone
        },
        end: {
          dateTime: endDateTimeInCalendarTZ,
          timeZone: calendarTimezone
        },
        attendees: appointmentData.attendees || [],
        location: appointmentData.location || appointmentData.office_address,
        conferenceData: appointmentData.conferenceData,
        reminders: appointmentData.reminders || {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 24 * 60 }, // 1 day before
            { method: 'popup', minutes: 60 } // 1 hour before
          ]
        },
        colorId: '9' // Blue color for medical appointments
      };

      log.info(`Creating Google Calendar event for doctor ${doctorId} in calendar ${doctor.google_calendar_id}`, {
        summary: event.summary,
        start: event.start.dateTime,
        end: event.end.dateTime,
        timezone: event.start.timeZone
      });

      const response = await calendar.events.insert({
        calendarId: doctor.google_calendar_id,
        resource: event,
        sendUpdates: 'all' // Send email notifications to attendees
      });

      log.info(`Created Google Calendar event ${response.data.id} for doctor ${doctorId}`, {
        eventId: response.data.id,
        htmlLink: response.data.htmlLink,
        calendarId: doctor.google_calendar_id,
        summary: response.data.summary,
        start: response.data.start?.dateTime,
        end: response.data.end?.dateTime
      });

      // Verify the event was actually created by trying to retrieve it
      try {
        const verifyResponse = await calendar.events.get({
          calendarId: doctor.google_calendar_id,
          eventId: response.data.id
        });
        log.info(`Verified Google Calendar event exists: ${verifyResponse.data.id}`, {
          status: verifyResponse.data.status,
          htmlLink: verifyResponse.data.htmlLink
        });
      } catch (verifyError) {
        log.error(`Failed to verify Google Calendar event ${response.data.id}:`, verifyError.message);
      }

      // Update last sync timestamp
      await supa
        .from('doctors')
        .update({ last_calendar_sync: new Date().toISOString() })
        .eq('id', doctorId);

      return response.data;

    } catch (error) {
      log.error('Error creating appointment in Google Calendar:', error);
      throw error;
    }
  }

  /**
   * Get authenticated calendar client for an owner (for beauty clinic treatments)
   */
  async getCalendarClientForOwner(ownerId) {
    try {
      // Get owner's Google Calendar credentials from users table
      const { data: owner, error } = await supa
        .from('users')
        .select('google_calendar_id, google_refresh_token, google_access_token, google_token_expires_at')
        .eq('id', ownerId)
        .single();

      if (error || !owner) {
        throw new Error('Owner not found');
      }

      if (!owner.google_refresh_token) {
        throw new Error('Google Calendar not connected for this owner');
      }

      // Set credentials
      this.oauth2Client.setCredentials({
        refresh_token: owner.google_refresh_token,
        access_token: owner.google_access_token
      });

      // Check if token needs refresh
      const now = new Date();
      const expiresAt = owner.google_token_expires_at ? new Date(owner.google_token_expires_at) : null;

      if (!expiresAt || now >= expiresAt) {
        try {
        // Refresh access token
        const { credentials } = await this.oauth2Client.refreshAccessToken();
        this.oauth2Client.setCredentials(credentials);

        // Update tokens in database
        await supa
          .from('users')
          .update({
            google_access_token: credentials.access_token,
            google_token_expires_at: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null
          })
          .eq('id', ownerId);

        log.info(`Refreshed Google Calendar token for owner ${ownerId}`);
        } catch (refreshError) {
          // Check if refresh token has expired or been revoked
          const isInvalidGrant = refreshError.response?.data?.error === 'invalid_grant' || 
                                 refreshError.message?.includes('invalid_grant') ||
                                 refreshError.message?.includes('Token has been expired or revoked');

          if (isInvalidGrant) {
            log.warn(`Google Calendar refresh token expired for owner ${ownerId}. Marking as disconnected.`);
            
            // Mark calendar as disconnected (but keep the calendar_id for reference)
            await supa
              .from('users')
              .update({
                calendar_sync_enabled: false,
                google_refresh_token: null,
                google_access_token: null,
                google_token_expires_at: null
              })
              .eq('id', ownerId);

            throw new Error('Google Calendar refresh token expired. Please reconnect your calendar.');
          }
          
          // Re-throw other errors
          throw refreshError;
        }
      }

      return google.calendar({ version: 'v3', auth: this.oauth2Client });

    } catch (error) {
      log.error('Error getting calendar client for owner:', error);
      throw error;
    }
  }

  /**
   * Create a treatment appointment in Google Calendar (for beauty clinics)
   * Uses owner's calendar from users table
   */
  async createTreatmentAppointment(ownerId, appointmentData) {
    try {
      const calendar = await this.getCalendarClientForOwner(ownerId);

      const { data: owner } = await supa
        .from('users')
        .select('google_calendar_id, name')
        .eq('id', ownerId)
        .single();

      // Handle both old format (startTime/endTime) and new format (start.dateTime/end.dateTime)
      let startDateTime, endDateTime, timezone;
      
      if (appointmentData.start && appointmentData.start.dateTime) {
        // New format from consultation endpoint
        startDateTime = appointmentData.start.dateTime;
        endDateTime = appointmentData.end.dateTime;
        timezone = appointmentData.start.timeZone || appointmentData.end.timeZone || 'America/Sao_Paulo';
      } else {
        // Old format from appointments endpoint
        startDateTime = appointmentData.startTime;
        endDateTime = appointmentData.endTime;
        timezone = appointmentData.timezone || 'America/Sao_Paulo';
      }

      log.info('Creating Google Calendar event for treatment with:', { startDateTime, endDateTime, timezone });

      const event = {
        summary: appointmentData.summary || appointmentData.title || `Tratamento - ${appointmentData.patientName || 'Cliente'}`,
        description: appointmentData.description || `Tratamento com ${appointmentData.treatmentName || 'Cliente'}`,
        start: {
          dateTime: startDateTime,
          timeZone: timezone
        },
        end: {
          dateTime: endDateTime,
          timeZone: timezone
        },
        attendees: appointmentData.attendees || [],
        location: appointmentData.location || appointmentData.office_address,
        reminders: appointmentData.reminders || {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 24 * 60 }, // 1 day before
            { method: 'popup', minutes: 60 } // 1 hour before
          ]
        },
        colorId: '10' // Green color for beauty/treatment appointments
      };

      const response = await calendar.events.insert({
        calendarId: owner.google_calendar_id,
        resource: event,
        sendUpdates: 'all' // Send email notifications to attendees
      });

      log.info(`Created Google Calendar event ${response.data.id} for owner ${ownerId}`);

      // Update last sync timestamp
      await supa
        .from('users')
        .update({ last_calendar_sync: new Date().toISOString() })
        .eq('id', ownerId);

      return response.data;

    } catch (error) {
      log.error('Error creating treatment appointment in Google Calendar:', error);
      throw error;
    }
  }

  /**
   * Update an appointment in Google Calendar
   */
  async updateAppointment(doctorId, eventId, updates) {
    try {
      const calendar = await this.getCalendarClient(doctorId);

      const { data: doctor } = await supa
        .from('doctors')
        .select('google_calendar_id')
        .eq('id', doctorId)
        .single();

      if (!doctor || !doctor.google_calendar_id) {
        throw new Error(`Doctor ${doctorId} not found or calendar not connected`);
      }

      // Get calendar timezone
      let calendarTimezone = 'America/Sao_Paulo';
      try {
        const calendarInfo = await calendar.calendars.get({
          calendarId: doctor.google_calendar_id
        });
        calendarTimezone = calendarInfo.data.timeZone || 'America/Sao_Paulo';
        log.info(`Updating calendar event - calendar timezone: ${calendarTimezone}`);
      } catch (calendarCheckError) {
        log.warn(`Could not get calendar timezone, using default: ${calendarCheckError.message}`);
      }

      const appointmentTimezone = updates.timezone || 'America/Sao_Paulo';

      // Format dates in the calendar's timezone (same logic as createAppointment)
      const formatDateTimeForTimezone = (date, timezone) => {
        // Use Intl.DateTimeFormat to format in the target timezone
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
        
        const parts = formatter.formatToParts(date);
        const year = parts.find(p => p.type === 'year').value;
        const month = parts.find(p => p.type === 'month').value;
        const day = parts.find(p => p.type === 'day').value;
        const hour = parts.find(p => p.type === 'hour').value;
        const minute = parts.find(p => p.type === 'minute').value;
        const second = parts.find(p => p.type === 'second').value;
        
        // Calculate timezone offset for the specific date and timezone
        // Create a date string in UTC and in the target timezone, then compare
        const dateInUTC = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
        const dateInTZ = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
        const offsetMs = dateInTZ.getTime() - dateInUTC.getTime();
        const offsetHours = Math.floor(Math.abs(offsetMs) / (1000 * 60 * 60));
        const offsetMinutes = Math.floor((Math.abs(offsetMs) % (1000 * 60 * 60)) / (1000 * 60));
        const offsetSign = offsetMs >= 0 ? '+' : '-';
        const offset = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;
        
        return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
      };

      const event = {};
      if (updates.title) event.summary = updates.title;
      if (updates.description) event.description = updates.description;
      
      if (updates.startTime) {
        // Convert to calendar's timezone
        const startDate = new Date(updates.startTime);
        const startDateTimeInCalendarTZ = formatDateTimeForTimezone(startDate, calendarTimezone);
        event.start = {
          dateTime: startDateTimeInCalendarTZ,
          timeZone: calendarTimezone
        };
        log.debug(`Formatted start time for update: ${startDateTimeInCalendarTZ} in timezone ${calendarTimezone} (original: ${updates.startTime})`);
      }
      
      if (updates.endTime) {
        const endDate = new Date(updates.endTime);
        const endDateTimeInCalendarTZ = formatDateTimeForTimezone(endDate, calendarTimezone);
        event.end = {
          dateTime: endDateTimeInCalendarTZ,
          timeZone: calendarTimezone
        };
        log.debug(`Formatted end time for update: ${endDateTimeInCalendarTZ} in timezone ${calendarTimezone} (original: ${updates.endTime})`);
      }

      // Get the existing event first (recommended by Google for partial updates)
      let existingEvent;
      try {
        const getResponse = await calendar.events.get({
          calendarId: doctor.google_calendar_id,
          eventId: eventId
        });
        existingEvent = getResponse.data;
        log.debug(`Retrieved existing event for update:`, {
          existingStart: existingEvent.start?.dateTime,
          existingEnd: existingEvent.end?.dateTime
        });
      } catch (getError) {
        log.warn(`Could not retrieve existing event ${eventId}, using patch method:`, getError.message);
        // Fallback to patch if we can't get the event
        const response = await calendar.events.patch({
          calendarId: doctor.google_calendar_id,
          eventId: eventId,
          resource: event,
          sendUpdates: 'all'
        });
        return response.data;
      }

      // Merge updates with existing event (preserve all other fields)
      const updatedEvent = {
        ...existingEvent,
        ...event,
        // Ensure start and end are properly set
        start: event.start || existingEvent.start,
        end: event.end || existingEvent.end
      };

      log.info(`Updating Google Calendar event ${eventId} for doctor ${doctorId}:`, {
        eventId,
        calendarId: doctor.google_calendar_id,
        calendarTimezone,
        updates: event,
        mergedEvent: {
          start: updatedEvent.start,
          end: updatedEvent.end,
          summary: updatedEvent.summary
        }
      });

      // Use update method with full event resource (recommended by Google)
      const response = await calendar.events.update({
        calendarId: doctor.google_calendar_id,
        eventId: eventId,
        resource: updatedEvent,
        sendUpdates: 'all'
      });

      // Verify the event was actually updated by fetching it back
      try {
        const verifyResponse = await calendar.events.get({
          calendarId: doctor.google_calendar_id,
          eventId: eventId
        });
        
        log.info(`Updated Google Calendar event ${eventId} for doctor ${doctorId}`, {
          eventId: response.data.id,
          htmlLink: response.data.htmlLink,
          start: response.data.start?.dateTime,
          end: response.data.end?.dateTime,
          verifiedStart: verifyResponse.data.start?.dateTime,
          verifiedEnd: verifyResponse.data.end?.dateTime,
          verifiedSummary: verifyResponse.data.summary
        });
      } catch (verifyError) {
        log.warn(`Could not verify updated event ${eventId}:`, verifyError.message);
        log.info(`Updated Google Calendar event ${eventId} for doctor ${doctorId}`, {
          eventId: response.data.id,
          htmlLink: response.data.htmlLink,
          start: response.data.start?.dateTime,
          end: response.data.end?.dateTime
        });
      }

      await supa
        .from('doctors')
        .update({ last_calendar_sync: new Date().toISOString() })
        .eq('id', doctorId);

      return response.data;

    } catch (error) {
      log.error('Error updating appointment in Google Calendar:', error);
      throw error;
    }
  }

  /**
   * Update a treatment appointment in Google Calendar (for beauty clinic)
   */
  async updateTreatmentAppointment(ownerId, eventId, updates) {
    try {
      const calendar = await this.getCalendarClientForOwner(ownerId);

      const { data: owner } = await supa
        .from('users')
        .select('google_calendar_id, name')
        .eq('id', ownerId)
        .single();

      if (!owner || !owner.google_calendar_id) {
        throw new Error(`Owner ${ownerId} not found or calendar not connected`);
      }

      // Get calendar timezone
      let calendarTimezone = 'America/Sao_Paulo';
      try {
        const calendarInfo = await calendar.calendars.get({
          calendarId: owner.google_calendar_id
        });
        calendarTimezone = calendarInfo.data.timeZone || 'America/Sao_Paulo';
        log.info(`Updating treatment calendar event - calendar timezone: ${calendarTimezone}`);
      } catch (calendarCheckError) {
        log.warn(`Could not get calendar timezone, using default: ${calendarCheckError.message}`);
      }

      const appointmentTimezone = updates.timezone || 'America/Sao_Paulo';

      const event = {};
      if (updates.title) event.summary = updates.title;
      if (updates.description) event.description = updates.description;
      
      if (updates.startTime) {
        // Convert to calendar's timezone if different
        const startDate = new Date(updates.startTime);
        const formatDateTimeForTimezone = (date, timezone) => {
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
          
          const parts = formatter.formatToParts(date);
          const year = parts.find(p => p.type === 'year').value;
          const month = parts.find(p => p.type === 'month').value;
          const day = parts.find(p => p.type === 'day').value;
          const hour = parts.find(p => p.type === 'hour').value;
          const minute = parts.find(p => p.type === 'minute').value;
          const second = parts.find(p => p.type === 'second').value;
          
          // Get timezone offset
          const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
          const tzDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
          const offsetMs = tzDate.getTime() - utcDate.getTime();
          const offsetHours = Math.floor(Math.abs(offsetMs) / (1000 * 60 * 60));
          const offsetMinutes = Math.floor((Math.abs(offsetMs) % (1000 * 60 * 60)) / (1000 * 60));
          const offsetSign = offsetMs >= 0 ? '+' : '-';
          const offset = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;
          
          return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
        };
        
        const startDateTimeInCalendarTZ = formatDateTimeForTimezone(startDate, calendarTimezone);
        event.start = {
          dateTime: startDateTimeInCalendarTZ,
          timeZone: calendarTimezone
        };
      }
      
      if (updates.endTime) {
        const endDate = new Date(updates.endTime);
        const formatDateTimeForTimezone = (date, timezone) => {
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
          
          const parts = formatter.formatToParts(date);
          const year = parts.find(p => p.type === 'year').value;
          const month = parts.find(p => p.type === 'month').value;
          const day = parts.find(p => p.type === 'day').value;
          const hour = parts.find(p => p.type === 'hour').value;
          const minute = parts.find(p => p.type === 'minute').value;
          const second = parts.find(p => p.type === 'second').value;
          
          // Get timezone offset
          const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
          const tzDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
          const offsetMs = tzDate.getTime() - utcDate.getTime();
          const offsetHours = Math.floor(Math.abs(offsetMs) / (1000 * 60 * 60));
          const offsetMinutes = Math.floor((Math.abs(offsetMs) % (1000 * 60 * 60)) / (1000 * 60));
          const offsetSign = offsetMs >= 0 ? '+' : '-';
          const offset = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;
          
          return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
        };
        
        const endDateTimeInCalendarTZ = formatDateTimeForTimezone(endDate, calendarTimezone);
        event.end = {
          dateTime: endDateTimeInCalendarTZ,
          timeZone: calendarTimezone
        };
      }

      // Get the existing event first (recommended by Google for partial updates)
      let existingEvent;
      try {
        const getResponse = await calendar.events.get({
          calendarId: owner.google_calendar_id,
          eventId: eventId
        });
        existingEvent = getResponse.data;
        log.debug(`Retrieved existing treatment event for update:`, {
          existingStart: existingEvent.start?.dateTime,
          existingEnd: existingEvent.end?.dateTime
        });
      } catch (getError) {
        log.warn(`Could not retrieve existing treatment event ${eventId}, using patch method:`, getError.message);
        // Fallback to patch if we can't get the event
        const response = await calendar.events.patch({
          calendarId: owner.google_calendar_id,
          eventId: eventId,
          resource: event,
          sendUpdates: 'all'
        });
        return response.data;
      }

      // Merge updates with existing event (preserve all other fields)
      const updatedEvent = {
        ...existingEvent,
        ...event,
        // Ensure start and end are properly set
        start: event.start || existingEvent.start,
        end: event.end || existingEvent.end
      };

      log.info(`Updating Google Calendar treatment event ${eventId} for owner ${ownerId}:`, {
        eventId,
        calendarId: owner.google_calendar_id,
        calendarTimezone,
        updates: event,
        mergedEvent: {
          start: updatedEvent.start,
          end: updatedEvent.end,
          summary: updatedEvent.summary
        }
      });

      // Use update method with full event resource (recommended by Google)
      const response = await calendar.events.update({
        calendarId: owner.google_calendar_id,
        eventId: eventId,
        resource: updatedEvent,
        sendUpdates: 'all'
      });

      log.info(`Updated Google Calendar treatment event ${eventId} for owner ${ownerId}`, {
        eventId: response.data.id,
        htmlLink: response.data.htmlLink,
        start: response.data.start?.dateTime,
        end: response.data.end?.dateTime
      });

      await supa
        .from('users')
        .update({ last_calendar_sync: new Date().toISOString() })
        .eq('id', ownerId);

      return response.data;

    } catch (error) {
      log.error('Error updating treatment appointment in Google Calendar:', error);
      throw error;
    }
  }

  /**
   * Delete an appointment from Google Calendar
   */
  async deleteAppointment(doctorId, eventId) {
    try {
      const calendar = await this.getCalendarClient(doctorId);

      const { data: doctor } = await supa
        .from('doctors')
        .select('google_calendar_id')
        .eq('id', doctorId)
        .single();

      await calendar.events.delete({
        calendarId: doctor.google_calendar_id,
        eventId: eventId,
        sendUpdates: 'all'
      });

      log.info(`Deleted Google Calendar event ${eventId} for doctor ${doctorId}`);

      await supa
        .from('doctors')
        .update({ last_calendar_sync: new Date().toISOString() })
        .eq('id', doctorId);

    } catch (error) {
      log.error('Error deleting appointment from Google Calendar:', error);
      throw error;
    }
  }

  /**
   * Get available time slots for a doctor
   */
  async getAvailableSlots(doctorId, startDate, endDate) {
    try {
      // Validate input parameters
      if (!doctorId || !startDate || !endDate) {
        throw new Error('Missing required parameters: doctorId, startDate, endDate');
      }

      // Validate date format
      const start = new Date(startDate);
      const end = new Date(endDate);
      
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        throw new Error('Invalid date format. Use ISO 8601 format');
      }

      if (start >= end) {
        throw new Error('startDate must be before endDate');
      }

      const calendar = await this.getCalendarClient(doctorId);

      const { data: doctor, error: doctorError } = await supa
        .from('doctors')
        .select('google_calendar_id, working_hours, date_specific_availability, consultation_duration, timezone')
        .eq('id', doctorId)
        .single();

      if (doctorError) {
        log.error('Database error fetching doctor:', doctorError);
        throw new Error(`Database error: ${doctorError.message}`);
      }

      if (!doctor) {
        throw new Error('Doctor not found');
      }

      if (!doctor.google_calendar_id) {
        throw new Error('Google Calendar not connected for this doctor');
      }

      // Get busy times from Google Calendar
      let busySlots = [];
      if (doctor.google_calendar_id) {
        try {
          const response = await calendar.freebusy.query({
            resource: {
              timeMin: startDate,
              timeMax: endDate,
              timeZone: doctor.timezone || 'America/Sao_Paulo',
              items: [{ id: doctor.google_calendar_id }]
            }
          });

          busySlots = response.data.calendars[doctor.google_calendar_id]?.busy || [];
        } catch (calendarError) {
          log.warn(`Failed to get Google Calendar busy slots for doctor ${doctorId}:`, calendarError);
          // Continue without Google Calendar data
        }
      }

      // Process working hours and date-specific availability to generate available slots
      const availableSlots = this.generateAvailableSlots(
        startDate,
        endDate,
        doctor.working_hours || {},
        doctor.date_specific_availability || [],
        busySlots,
        doctor.consultation_duration || 90,
        doctor.timezone || 'America/Sao_Paulo'
      );

      log.info(`Generated ${availableSlots.length} available slots for doctor ${doctorId}`);

      return {
        availableSlots,
        busySlots,
        workingHours: doctor.working_hours,
        dateSpecificAvailability: doctor.date_specific_availability || [],
        consultationDuration: doctor.consultation_duration || 90,
        timezone: doctor.timezone || 'America/Sao_Paulo'
      };

    } catch (error) {
      log.error('Error getting available slots:', error);
      throw error;
    }
  }

  /**
   * Generate available time slots based on working hours, date-specific availability, and busy slots
   */
  generateAvailableSlots(startDate, endDate, workingHours, dateSpecificAvailability, busySlots, consultationDuration, timezone) {
    try {
      const availableSlots = [];
      const start = new Date(startDate);
      const end = new Date(endDate);
      
      // Validate inputs
      if (!workingHours || typeof workingHours !== 'object') {
        log.warn('Invalid working hours format, using empty object');
        workingHours = {};
      }

      if (!Array.isArray(dateSpecificAvailability)) {
        log.warn('Invalid date specific availability format, using empty array');
        dateSpecificAvailability = [];
      }

      if (!Array.isArray(busySlots)) {
        log.warn('Invalid busy slots format, using empty array');
        busySlots = [];
      }

      if (!consultationDuration || consultationDuration <= 0) {
        log.warn('Invalid consultation duration, using default 90 minutes');
        consultationDuration = 90;
      }
    
    // Convert busy slots to a more usable format
    const busyTimes = busySlots.map(slot => ({
      start: new Date(slot.start),
      end: new Date(slot.end)
    }));

    // Create a map of date-specific availability for quick lookup
    const dateSpecificMap = {};
    dateSpecificAvailability.forEach(entry => {
      const dateKey = entry.date.split('T')[0]; // Get YYYY-MM-DD part
      dateSpecificMap[dateKey] = entry;
    });

    // Generate slots for each day in the range
    for (let currentDate = new Date(start); currentDate <= end; currentDate.setDate(currentDate.getDate() + 1)) {
      const dateKey = currentDate.toISOString().split('T')[0];
      const dayName = currentDate.toLocaleDateString('en-US', { weekday: 'lowercase' });
      
      // Check if this date has specific availability rules
      const dateSpecific = dateSpecificMap[dateKey];
      
      if (dateSpecific && dateSpecific.type === 'unavailable') {
        // Skip this date entirely
        continue;
      }

      // Get working hours for this day
      let dayWorkingHours = [];
      
      if (dateSpecific && dateSpecific.type === 'modified_hours') {
        // Use modified hours for this specific date
        if (dateSpecific.start && dateSpecific.end) {
          dayWorkingHours = [{
            start: dateSpecific.start,
            end: dateSpecific.end
          }];
        }
      } else if (workingHours[dayName] && workingHours[dayName].enabled) {
        // Use regular working hours for this day
        dayWorkingHours = workingHours[dayName].timeSlots || [];
      }

      // Generate time slots for this day
      dayWorkingHours.forEach(timeSlot => {
        const slotStart = new Date(currentDate);
        const slotEnd = new Date(currentDate);
        
        // Parse time strings (HH:MM format)
        const [startHour, startMinute] = timeSlot.start.split(':').map(Number);
        const [endHour, endMinute] = timeSlot.end.split(':').map(Number);
        
        slotStart.setHours(startHour, startMinute, 0, 0);
        slotEnd.setHours(endHour, endMinute, 0, 0);

        // Generate consultation slots within this time range
        let currentSlotStart = new Date(slotStart);
        
        while (currentSlotStart < slotEnd) {
          const currentSlotEnd = new Date(currentSlotStart.getTime() + consultationDuration * 60000);
          
          // Check if this slot would exceed the working hours
          if (currentSlotEnd > slotEnd) {
            break;
          }

          // Check if this slot conflicts with any busy times
          const isBusy = busyTimes.some(busyTime => {
            return (currentSlotStart < busyTime.end && currentSlotEnd > busyTime.start);
          });

          if (!isBusy) {
            availableSlots.push({
              start: currentSlotStart.toISOString(),
              end: currentSlotEnd.toISOString(),
              duration: consultationDuration,
              date: dateKey,
              timeSlot: {
                start: timeSlot.start,
                end: timeSlot.end
              }
            });
          }

          // Move to next slot (default 30-minute increments)
          currentSlotStart.setMinutes(currentSlotStart.getMinutes() + 30);
        }
      });
    }

    return availableSlots;
    } catch (error) {
      log.error('Error generating available slots:', error);
      // Return empty array if slot generation fails
      return [];
    }
  }

  /**
   * List upcoming appointments for a doctor
   */
  async listUpcomingAppointments(doctorId, maxResults = 10) {
    try {
      const calendar = await this.getCalendarClient(doctorId);

      const { data: doctor } = await supa
        .from('doctors')
        .select('google_calendar_id')
        .eq('id', doctorId)
        .single();

      const response = await calendar.events.list({
        calendarId: doctor.google_calendar_id,
        timeMin: new Date().toISOString(),
        maxResults: maxResults,
        singleEvents: true,
        orderBy: 'startTime'
      });

      return response.data.items || [];

    } catch (error) {
      log.error('Error listing upcoming appointments:', error);
      throw error;
    }
  }

  /**
   * Setup push notifications for a doctor's calendar
   * This allows us to receive webhooks when calendar events change
   */
  async setupPushNotifications(doctorId) {
    try {
      const calendar = await this.getCalendarClient(doctorId);

      const { data: doctor } = await supa
        .from('doctors')
        .select('google_calendar_id, name')
        .eq('id', doctorId)
        .single();

      // Generate a unique channel ID and token
      const channelId = `geniumed-${doctorId}-${Date.now()}`;
      const channelToken = Math.random().toString(36).substring(7);

      // Set up push notification (watch request)
      // Channel expires after 1 week (max allowed by Google)
      const expiration = Date.now() + (7 * 24 * 60 * 60 * 1000); // 7 days

      const watchResponse = await calendar.events.watch({
        calendarId: doctor.google_calendar_id || 'primary',
        requestBody: {
          id: channelId,
          type: 'web_hook',
          address: `${env.APP_BASE_URL}/api/google-calendar/webhook`,
          token: channelToken,
          expiration: expiration.toString()
        }
      });

      log.info('Google Calendar push notifications set up:', {
        doctorId,
        channelId,
        resourceId: watchResponse.data.resourceId,
        expiration: new Date(parseInt(watchResponse.data.expiration))
      });

      // Store channel information in database
      await supa
        .from('doctors')
        .update({
          google_calendar_channel_id: channelId,
          google_calendar_resource_id: watchResponse.data.resourceId,
          google_calendar_channel_expiration: new Date(parseInt(watchResponse.data.expiration)).toISOString(),
          google_calendar_channel_token: channelToken
        })
        .eq('id', doctorId);

      return {
        channelId,
        resourceId: watchResponse.data.resourceId,
        expiration: new Date(parseInt(watchResponse.data.expiration))
      };

    } catch (error) {
      log.error('Error setting up push notifications:', error);
      throw error;
    }
  }

  /**
   * Stop push notifications for a doctor's calendar
   */
  async stopPushNotifications(doctorId) {
    try {
      const calendar = await this.getCalendarClient(doctorId);

      const { data: doctor } = await supa
        .from('doctors')
        .select('google_calendar_channel_id, google_calendar_resource_id')
        .eq('id', doctorId)
        .single();

      if (!doctor.google_calendar_channel_id || !doctor.google_calendar_resource_id) {
        log.warn('No active push notification channel found for doctor', doctorId);
        return;
      }

      // Stop the watch
      await calendar.channels.stop({
        requestBody: {
          id: doctor.google_calendar_channel_id,
          resourceId: doctor.google_calendar_resource_id
        }
      });

      log.info('Google Calendar push notifications stopped:', {
        doctorId,
        channelId: doctor.google_calendar_channel_id
      });

      // Clear channel information from database
      await supa
        .from('doctors')
        .update({
          google_calendar_channel_id: null,
          google_calendar_resource_id: null,
          google_calendar_channel_expiration: null,
          google_calendar_channel_token: null
        })
        .eq('id', doctorId);

    } catch (error) {
      log.error('Error stopping push notifications:', error);
      throw error;
    }
  }

  /**
   * Renew push notifications before they expire
   * Should be called periodically (e.g., every 6 days)
   */
  async renewPushNotifications(doctorId) {
    try {
      // Stop existing channel
      await this.stopPushNotifications(doctorId);
      
      // Set up new channel
      return await this.setupPushNotifications(doctorId);

    } catch (error) {
      log.error('Error renewing push notifications:', error);
      throw error;
    }
  }
}

export const googleCalendarService = new GoogleCalendarService();

