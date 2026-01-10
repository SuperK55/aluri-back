import { Router } from 'express';
import { google } from 'googleapis';
import { supa } from '../lib/supabase.js';
import { log } from '../config/logger.js';
import { env } from '../config/env.js';
import { googleCalendarService } from '../services/googleCalendar.js';
import { updateAgentVariablesForLead } from './retell.js';

const router = Router();

/**
 * Google Calendar Push Notification Webhook
 * POST /api/google-calendar/webhook
 * 
 * This endpoint receives notifications when calendar events are created, updated, or deleted
 * https://developers.google.com/calendar/api/guides/push
 */
router.post('/webhook', async (req, res) => {
  try {
    // Google Calendar sends notifications with specific headers
    const channelId = req.headers['x-goog-channel-id'];
    const resourceId = req.headers['x-goog-resource-id'];
    const resourceState = req.headers['x-goog-resource-state']; // 'sync', 'exists', 'not_exists'
    const resourceUri = req.headers['x-goog-resource-uri'];
    const channelToken = req.headers['x-goog-channel-token']; // For verification

    log.info('📅 Google Calendar webhook received:', {
      channelId,
      resourceId,
      resourceState,
      channelToken
    });

    // Acknowledge receipt immediately (Google expects 200-299 response within seconds)
    res.status(200).send('OK');

    // Process notification asynchronously (don't block response)
    processCalendarNotification({
      channelId,
      resourceId,
      resourceState,
      resourceUri,
      channelToken
    }).catch(error => {
      log.error('Error processing calendar notification:', error);
    });

  } catch (error) {
    log.error('Google Calendar webhook error:', error);
    // Still return 200 to prevent Google from retrying
    res.status(200).send('OK');
  }
});

/**
 * Process calendar notification asynchronously
 */
async function processCalendarNotification({ channelId, resourceId, resourceState, resourceUri, channelToken }) {
  try {
    // If resourceState is 'sync', it's just a confirmation from Google
    // This can arrive before the channel is stored in the database due to race conditions
    // So we handle it more gracefully
    if (resourceState === 'sync') {
      // Try to find the doctor or owner, but don't warn if not found (likely timing issue)
      const { data: doctor } = await supa
        .from('doctors')
        .select('id')
        .eq('google_calendar_channel_id', channelId)
        .single();
      
      const { data: owner } = await supa
        .from('users')
        .select('id')
        .eq('google_calendar_channel_id', channelId)
        .single();
      
      if (doctor) {
        log.info(`Sync notification received for doctor ${doctor.id}`);
      } else if (owner) {
        log.info(`Sync notification received for owner ${owner.id}`);
      } else {
        // This is expected during initial setup - Google sends sync before DB update completes
        log.debug(`Sync notification received for channel ${channelId} (not yet in database, this is normal)`);
      }
      return;
    }

    // For actual change notifications, we need to find the doctor or owner
    let doctor = null;
    let owner = null;
    let calendarType = null; // 'doctor' or 'owner'
    let calendar = null;
    let calendarId = null;
    let resourceName = null;

    // Try to find in doctors table first (medical clinics)
    const { data: doctorData, error: doctorError } = await supa
      .from('doctors')
      .select('id, google_calendar_id, google_refresh_token, google_access_token, google_token_expires_at, name')
      .eq('google_calendar_channel_id', channelId)
      .single();

    if (!doctorError && doctorData) {
      doctor = doctorData;
      calendarType = 'doctor';
      calendar = await googleCalendarService.getCalendarClient(doctor.id);
      calendarId = doctor.google_calendar_id;
      resourceName = doctor.name;
    } else {
      // Try to find in users table (beauty clinics - treatments)
      const { data: ownerData, error: ownerError } = await supa
        .from('users')
        .select('id, google_calendar_id, google_refresh_token, google_access_token, google_token_expires_at, name')
        .eq('google_calendar_channel_id', channelId)
        .single();

      if (!ownerError && ownerData) {
        owner = ownerData;
        calendarType = 'owner';
        calendar = await googleCalendarService.getCalendarClientForOwner(owner.id);
        calendarId = owner.google_calendar_id;
        resourceName = owner.name;
      }
    }

    if (!doctor && !owner) {
      log.warn('Channel not found in database (checked both doctors and users):', channelId);
      return;
    }

    const calendarResourceId = doctor?.id || owner?.id;
    log.info(`Processing calendar change for ${calendarType} ${calendarResourceId} (${resourceName})`);

    // Fetch recent events from Google Calendar (last 7 days to 30 days ahead)
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const thirtyDaysAhead = new Date(now);
    thirtyDaysAhead.setDate(thirtyDaysAhead.getDate() + 30);

    const eventsResponse = await calendar.events.list({
      calendarId: calendarId || 'primary',
      timeMin: sevenDaysAgo.toISOString(),
      timeMax: thirtyDaysAhead.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    const googleEvents = eventsResponse.data.items || [];
    
    // Get all appointments from our database based on calendar type
    let dbAppointmentsQuery = supa
      .from('appointments')
      .select('id, gcal_event_id, start_at, end_at, status, resource_type, resource_id')
      .gte('start_at', sevenDaysAgo.toISOString())
      .lte('start_at', thirtyDaysAhead.toISOString());

    if (calendarType === 'doctor') {
      // For doctors, filter by resource_id where resource_type is 'doctor'
      dbAppointmentsQuery = dbAppointmentsQuery
        .eq('resource_type', 'doctor')
        .eq('resource_id', calendarResourceId);
    } else {
      // For owners (treatments), filter by resource_type='treatment' and resource_id (treatment id)
      // But we need to find treatments owned by this owner
      // Actually, appointments table has resource_type and resource_id for treatments
      // We need to find appointments where resource_type='treatment' and the treatment's owner_id matches
      dbAppointmentsQuery = dbAppointmentsQuery
        .eq('resource_type', 'treatment')
        .not('resource_id', 'is', null);
      
      // Get treatment IDs owned by this owner
      const { data: treatments } = await supa
        .from('treatments')
        .select('id')
        .eq('owner_id', calendarResourceId);
      
      const treatmentIds = treatments?.map(t => t.id) || [];
      if (treatmentIds.length > 0) {
        dbAppointmentsQuery = dbAppointmentsQuery.in('resource_id', treatmentIds);
      } else {
        // No treatments for this owner, skip processing
        log.info(`No treatments found for owner ${calendarResourceId}, skipping appointment sync`);
        return;
      }
    }

    const { data: dbAppointments, error: dbError } = await dbAppointmentsQuery;

    if (dbError) {
      log.error('Error fetching appointments from database:', dbError);
      return;
    }

    // Create a map of Google event IDs to Google events
    const googleEventMap = new Map();
    googleEvents.forEach(event => {
      if (event.id && event.status !== 'cancelled') {
        googleEventMap.set(event.id, event);
      }
    });

    // Find appointments that exist in database but NOT in Google Calendar (deleted events)
    const deletedAppointments = (dbAppointments || []).filter(appointment => {
      if (!appointment.gcal_event_id) return false; // Skip appointments without Google event ID
      if (appointment.status === 'cancelled') return false; // Already cancelled
      return !googleEventMap.has(appointment.gcal_event_id);
    });

    // Cancel deleted appointments in database
    for (const appointment of deletedAppointments) {
      log.info(`Appointment ${appointment.id} deleted from Google Calendar, cancelling in database`);
      
      await supa
        .from('appointments')
        .update({
          status: 'cancelled',
          updated_at: new Date().toISOString()
        })
        .eq('id', appointment.id);

      log.info(`✅ Appointment ${appointment.id} marked as cancelled due to Google Calendar deletion`);

      // Update agent_variables in active whatsapp_chats and Retell chats
      if (appointment.lead_id) {
        updateAgentVariablesForLead(appointment.lead_id, 'google-calendar-cancel')
          .catch(err => log.warn('Failed to update agent_variables after Google Calendar cancellation:', err.message));
      }
    }

    // Check for updated appointments (time changed)
    for (const appointment of (dbAppointments || [])) {
      if (!appointment.gcal_event_id || appointment.status === 'cancelled') continue;
      
      const googleEvent = googleEventMap.get(appointment.gcal_event_id);
      if (!googleEvent) continue; // Already handled in deletion above

      const dbStart = new Date(appointment.start_at);
      const googleStart = new Date(googleEvent.start.dateTime || googleEvent.start.date);
      const dbEnd = new Date(appointment.end_at);
      const googleEnd = new Date(googleEvent.end.dateTime || googleEvent.end.date);

      // Check if times differ (allow 1 minute tolerance for timezone/rounding)
      const startDiff = Math.abs(dbStart - googleStart);
      const endDiff = Math.abs(dbEnd - googleEnd);

      if (startDiff > 60000 || endDiff > 60000) {
        log.info(`Appointment ${appointment.id} time changed in Google Calendar, updating database`);
        
        await supa
          .from('appointments')
          .update({
            start_at: googleStart.toISOString(),
            end_at: googleEnd.toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', appointment.id);

        log.info(`✅ Appointment ${appointment.id} time updated from Google Calendar`);

        // Update agent_variables in active whatsapp_chats and Retell chats
        if (appointment.lead_id) {
          updateAgentVariablesForLead(appointment.lead_id, 'google-calendar-update')
            .catch(err => log.warn('Failed to update agent_variables after Google Calendar update:', err.message));
        }
      }
    }

    // Update last sync time in the appropriate table
    if (calendarType === 'doctor') {
    await supa
      .from('doctors')
      .update({ last_calendar_sync: new Date().toISOString() })
        .eq('id', calendarResourceId);
    } else {
      await supa
        .from('users')
        .update({ last_calendar_sync: new Date().toISOString() })
        .eq('id', calendarResourceId);
    }

    log.info(`✅ Processed calendar changes for ${calendarType} ${calendarResourceId}`);

  } catch (error) {
    log.error('Error in processCalendarNotification:', error);
  }
}

export default router;

