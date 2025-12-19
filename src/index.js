import express from 'express';
import bodyParser from 'body-parser';
import { env } from './config/env.js';
import { log } from './config/logger.js';
import health from './routes/health.js';
import leads from './routes/leads.js';
import doctors from './routes/doctors.js';
import agents from './routes/agents.js';
import retell from './routes/retell.js';
import functions from './routes/functions.js';
import auth from './routes/auth.js';
import users from './routes/users.js';
import googleCalendar from './routes/google-calendar.js';
import googleCalendarWebhook from './routes/google-calendar-webhook.js';
import appointments from './routes/appointments.js';
import whatsapp from './routes/whatsapp.js';
import beautyTreatments from './routes/beauty/treatments.js';
import beautyCalendar from './routes/beauty/calendar.js';
import './scheduler.js';
import { rawBodySaver } from './middleware/rawBody.js';

const app = express();
app.use(bodyParser.urlencoded({ extended: false, limit: '1mb' }));
app.use(bodyParser.json({ type: '*/*', verify: rawBodySaver, limit: '1mb' }));

app.use(health);
app.use(auth);
app.use(users);
app.use(leads);
app.use(doctors);
app.use('/agents', agents);
app.use(retell);
app.use(functions);
app.use('/google-calendar', googleCalendar);
app.use('/google-calendar', googleCalendarWebhook); // Webhook for push notifications
app.use('/appointments', appointments);
app.use('/whatsapp', whatsapp);
app.use('/beauty/treatments', beautyTreatments);
app.use('/beauty/calendar', beautyCalendar);

app.use((err, _req, res, _next) => {
  log.error(err);
  res.status(500).json({ error: err?.message || 'server error' });
});

app.listen(env.PORT, () => log.info(`API listening on :${env.PORT}`));
