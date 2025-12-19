import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { google } from 'googleapis';
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

    if (user.is_active === false) {
      return res.status(401).json({
        ok: false,
        error: 'User account is inactive'
      });
    }

    // Verify user has beauty_clinic specialty
    if (user.service_type !== 'beauty_clinic') {
      return res.status(403).json({
        ok: false,
        error: 'Access denied. This endpoint is only for beauty clinic users.'
      });
    }

    req.ownerId = user.id;
    req.ownerRole = user.role;
    req.owner = user;
    next();

  } catch (error) {
    return res.status(401).json({
      ok: false,
      error: 'Invalid token'
    });
  }
};

// Initialize OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  env.GOOGLE_CLIENT_ID,
  env.GOOGLE_CLIENT_SECRET,
  `${env.APP_BASE_URL}/api/beauty/calendar/callback`
);

// GET /api/beauty/calendar/status - Get calendar connection status
router.get('/status', authenticateOwner, async (req, res) => {
  try {
    const { data: user, error } = await supa
      .from('users')
      .select('google_calendar_id, calendar_sync_enabled, last_calendar_sync')
      .eq('id', req.ownerId)
      .single();

    if (error) {
      log.error('Error fetching calendar status:', error);
      return res.status(500).json({
        ok: false,
        error: 'Failed to fetch calendar status'
      });
    }

    res.json({
      ok: true,
      connected: !!user.google_calendar_id && user.calendar_sync_enabled,
      calendarId: user.google_calendar_id,
      lastSync: user.last_calendar_sync
    });

  } catch (error) {
    log.error('Get calendar status error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to get calendar status'
    });
  }
});

// GET /api/beauty/calendar/auth-url - Get Google OAuth URL
router.get('/auth-url', authenticateOwner, async (req, res) => {
  try {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/calendar.events'
      ],
      state: req.ownerId, // Pass owner ID in state to identify user after OAuth
      prompt: 'consent' // Force consent screen to get refresh token
    });

    res.json({
      ok: true,
      authUrl
    });

  } catch (error) {
    log.error('Generate auth URL error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to generate authentication URL'
    });
  }
});

// GET /api/beauty/calendar/callback - OAuth callback handler
router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code || !state) {
      return res.status(400).send('Missing authorization code or state');
    }

    const ownerId = state;

    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get calendar list to find primary calendar
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const calendarListResponse = await calendar.calendarList.list();
    const primaryCalendar = calendarListResponse.data.items.find(cal => cal.primary);

    if (!primaryCalendar) {
      return res.status(400).send('No primary calendar found');
    }

    // Save tokens to database
    const { error } = await supa
      .from('users')
      .update({
        google_calendar_id: primaryCalendar.id,
        google_refresh_token: tokens.refresh_token,
        google_access_token: tokens.access_token,
        google_token_expires_at: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
        calendar_sync_enabled: true,
        last_calendar_sync: new Date().toISOString()
      })
      .eq('id', ownerId);

    if (error) {
      log.error('Error saving calendar credentials:', error);
      return res.status(500).send('Failed to save calendar credentials');
    }

    log.info(`Google Calendar connected successfully for owner ${ownerId}`);

    // Redirect to calendar settings page with success message
    res.redirect(`${env.FRONTEND_URL}/beauty/settings/calendar?connected=true`);

  } catch (error) {
    log.error('Calendar callback error:', error);
    res.status(500).send('Failed to connect Google Calendar');
  }
});

// POST /api/beauty/calendar/disconnect - Disconnect Google Calendar
router.post('/disconnect', authenticateOwner, async (req, res) => {
  try {
    const { error } = await supa
      .from('users')
      .update({
        google_calendar_id: null,
        google_refresh_token: null,
        google_access_token: null,
        google_token_expires_at: null,
        calendar_sync_enabled: false,
        last_calendar_sync: null
      })
      .eq('id', req.ownerId);

    if (error) {
      log.error('Error disconnecting calendar:', error);
      return res.status(500).json({
        ok: false,
        error: 'Failed to disconnect calendar'
      });
    }

    log.info(`Google Calendar disconnected for owner ${req.ownerId}`);

    res.json({
      ok: true,
      message: 'Google Calendar disconnected successfully'
    });

  } catch (error) {
    log.error('Disconnect calendar error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to disconnect calendar'
    });
  }
});

// POST /api/beauty/calendar/create-event - Create calendar event for treatment booking
router.post('/create-event', authenticateOwner, async (req, res) => {
  try {
    const {
      treatmentName,
      clientName,
      clientPhone,
      clientEmail,
      startTime,
      endTime,
      notes
    } = req.body;

    if (!treatmentName || !startTime || !endTime) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: treatmentName, startTime, endTime'
      });
    }

    // Get owner's calendar credentials
    const { data: user, error: userError } = await supa
      .from('users')
      .select('google_calendar_id, google_refresh_token, google_access_token, google_token_expires_at, name')
      .eq('id', req.ownerId)
      .single();

    if (userError || !user) {
      return res.status(404).json({
        ok: false,
        error: 'User not found'
      });
    }

    if (!user.google_refresh_token) {
      return res.status(400).json({
        ok: false,
        error: 'Google Calendar not connected'
      });
    }

    // Set credentials and refresh if needed
    oauth2Client.setCredentials({
      refresh_token: user.google_refresh_token,
      access_token: user.google_access_token
    });

    const now = new Date();
    const expiresAt = user.google_token_expires_at ? new Date(user.google_token_expires_at) : null;

    if (!expiresAt || now >= expiresAt) {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);

      await supa
        .from('users')
        .update({
          google_access_token: credentials.access_token,
          google_token_expires_at: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null
        })
        .eq('id', req.ownerId);
    }

    // Create calendar event
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const eventDescription = [
      `Treatment: ${treatmentName}`,
      clientName ? `Client: ${clientName}` : '',
      clientPhone ? `Phone: ${clientPhone}` : '',
      clientEmail ? `Email: ${clientEmail}` : '',
      notes ? `Notes: ${notes}` : ''
    ].filter(Boolean).join('\n');

    const event = {
      summary: `${treatmentName}${clientName ? ' - ' + clientName : ''}`,
      description: eventDescription,
      start: {
        dateTime: startTime,
        timeZone: 'America/Sao_Paulo'
      },
      end: {
        dateTime: endTime,
        timeZone: 'America/Sao_Paulo'
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 24 * 60 }, // 1 day before
          { method: 'popup', minutes: 30 }  // 30 minutes before
        ]
      }
    };

    const response = await calendar.events.insert({
      calendarId: user.google_calendar_id,
      resource: event
    });

    log.info(`Calendar event created: ${response.data.id} for owner ${req.ownerId}`);

    res.json({
      ok: true,
      eventId: response.data.id,
      eventLink: response.data.htmlLink,
      message: 'Calendar event created successfully'
    });

  } catch (error) {
    log.error('Create calendar event error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to create calendar event'
    });
  }
});

// PUT /api/beauty/calendar/update-event/:eventId - Update calendar event
router.put('/update-event/:eventId', authenticateOwner, async (req, res) => {
  try {
    const { eventId } = req.params;
    const {
      treatmentName,
      clientName,
      clientPhone,
      clientEmail,
      startTime,
      endTime,
      notes
    } = req.body;

    // Get owner's calendar credentials
    const { data: user } = await supa
      .from('users')
      .select('google_calendar_id, google_refresh_token, google_access_token, google_token_expires_at')
      .eq('id', req.ownerId)
      .single();

    if (!user || !user.google_refresh_token) {
      return res.status(400).json({
        ok: false,
        error: 'Google Calendar not connected'
      });
    }

    // Set and refresh credentials
    oauth2Client.setCredentials({
      refresh_token: user.google_refresh_token,
      access_token: user.google_access_token
    });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const eventDescription = [
      `Treatment: ${treatmentName}`,
      clientName ? `Client: ${clientName}` : '',
      clientPhone ? `Phone: ${clientPhone}` : '',
      clientEmail ? `Email: ${clientEmail}` : '',
      notes ? `Notes: ${notes}` : ''
    ].filter(Boolean).join('\n');

    const event = {
      summary: `${treatmentName}${clientName ? ' - ' + clientName : ''}`,
      description: eventDescription,
      start: {
        dateTime: startTime,
        timeZone: 'America/Sao_Paulo'
      },
      end: {
        dateTime: endTime,
        timeZone: 'America/Sao_Paulo'
      }
    };

    const response = await calendar.events.update({
      calendarId: user.google_calendar_id,
      eventId: eventId,
      resource: event
    });

    log.info(`Calendar event updated: ${eventId} for owner ${req.ownerId}`);

    res.json({
      ok: true,
      eventId: response.data.id,
      eventLink: response.data.htmlLink,
      message: 'Calendar event updated successfully'
    });

  } catch (error) {
    log.error('Update calendar event error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to update calendar event'
    });
  }
});

// DELETE /api/beauty/calendar/delete-event/:eventId - Delete calendar event
router.delete('/delete-event/:eventId', authenticateOwner, async (req, res) => {
  try {
    const { eventId } = req.params;

    // Get owner's calendar credentials
    const { data: user } = await supa
      .from('users')
      .select('google_calendar_id, google_refresh_token, google_access_token')
      .eq('id', req.ownerId)
      .single();

    if (!user || !user.google_refresh_token) {
      return res.status(400).json({
        ok: false,
        error: 'Google Calendar not connected'
      });
    }

    oauth2Client.setCredentials({
      refresh_token: user.google_refresh_token,
      access_token: user.google_access_token
    });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    await calendar.events.delete({
      calendarId: user.google_calendar_id,
      eventId: eventId
    });

    log.info(`Calendar event deleted: ${eventId} for owner ${req.ownerId}`);

    res.json({
      ok: true,
      message: 'Calendar event deleted successfully'
    });

  } catch (error) {
    log.error('Delete calendar event error:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to delete calendar event'
    });
  }
});

export default router;

