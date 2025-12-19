[ERROR] Error getting calendar client: GaxiosError: invalid_grant
    at Gaxios._request (/root/Geniumed/geniumed.ai_backend/node_modules/gaxios/build/src/gaxios.js:142:23)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
    at async OAuth2Client.refreshTokenNoCache (/root/Geniumed/geniumed.ai_backend/node_modules/google-auth-library/build/src/auth/oauth2client.js:212:19)
    at async OAuth2Client.refreshAccessTokenAsync (/root/Geniumed/geniumed.ai_backend/node_modules/google-auth-library/build/src/auth/oauth2client.js:247:19)
    at async GoogleCalendarService.getCalendarClient (file:///root/Geniumed/geniumed.ai_backend/src/services/googleCalendar.js:47:33)
    at async GoogleCalendarService.createAppointment (file:///root/Geniumed/geniumed.ai_backend/src/services/googleCalendar.js:75:24)
    at async file:///root/Geniumed/geniumed.ai_backend/src/routes/retell.js:535:31 {
  config: {
    retry: true,
    retryConfig: {
      httpMethodsToRetry: [Array],
      currentRetryAttempt: 0,
      retry: 3,
      noResponseRetries: 2,
      retryDelayMultiplier: 2,
      timeOfFirstRequest: 1765475802699,
      totalTimeout: 9007199254740991,
      maxRetryDelay: 9007199254740991,
      statusCodesToRetry: [Array]
    },
    method: 'POST',
    url: 'https://oauth2.googleapis.com/token',
    data: '<<REDACTED> - See `errorRedactor` option in `gaxios` for configuration>.',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'google-api-nodejs-client/9.15.1',
      'x-goog-api-client': 'gl-node/24.6.0'
    },
    paramsSerializer: [Function: paramsSerializer],
    body: '<<REDACTED> - See `errorRedactor` option in `gaxios` for configuration>.',
    validateStatus: [Function: validateStatus],
    responseType: 'unknown',
    errorRedactor: [Function: defaultErrorRedactor]
  },
  response: {
    config: {
      retry: true,
      retryConfig: [Object],
      method: 'POST',
      url: 'https://oauth2.googleapis.com/token',
      data: '<<REDACTED> - See `errorRedactor` option in `gaxios` for configuration>.',
      headers: [Object],
      paramsSerializer: [Function: paramsSerializer],
      body: '<<REDACTED> - See `errorRedactor` option in `gaxios` for configuration>.',
      validateStatus: [Function: validateStatus],
      responseType: 'unknown',
      errorRedactor: [Function: defaultErrorRedactor]
    },
    data: { error: 'invalid_grant', error_description: 'Bad Request' },
    headers: {
      'alt-svc': 'h3=":443"; ma=2592000,h3-29=":443"; ma=2592000',
      'cache-control': 'no-cache, no-store, max-age=0, must-revalidate',
      'content-encoding': 'gzip',
      'content-type': 'application/json; charset=utf-8',
      date: 'Thu, 11 Dec 2025 17:56:42 GMT',
      expires: 'Mon, 01 Jan 1990 00:00:00 GMT',
      pragma: 'no-cache',
      server: 'scaffolding on HTTPServer2',
      'transfer-encoding': 'chunked',
      vary: 'Origin, X-Origin, Referer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
      'x-xss-protection': '0'
    },
    status: 400,
    statusText: 'Bad Request',
    request: { responseURL: 'https://oauth2.googleapis.com/token' }
  },
  error: undefined,
  status: 400,
  Symbol(gaxios-gaxios-error): '6.7.1'
}
[ERROR] Error creating appointment in Google Calendar: GaxiosError: invalid_grant
    at Gaxios._request (/root/Geniumed/geniumed.ai_backend/node_modules/gaxios/build/src/gaxios.js:142:23)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
    at async OAuth2Client.refreshTokenNoCache (/root/Geniumed/geniumed.ai_backend/node_modules/google-auth-library/build/src/auth/oauth2client.js:212:19)
    at async OAuth2Client.refreshAccessTokenAsync (/root/Geniumed/geniumed.ai_backend/node_modules/google-auth-library/build/src/auth/oauth2client.js:247:19)
    at async GoogleCalendarService.getCalendarClient (file:///root/Geniumed/geniumed.ai_backend/src/services/googleCalendar.js:47:33)
    at async GoogleCalendarService.createAppointment (file:///root/Geniumed/geniumed.ai_backend/src/services/googleCalendar.js:75:24)
    at async file:///root/Geniumed/geniumed.ai_backend/src/routes/retell.js:535:31 {
  config: {
    retry: true,
    retryConfig: {
      httpMethodsToRetry: [Array],
      currentRetryAttempt: 0,
      retry: 3,
      noResponseRetries: 2,
      retryDelayMultiplier: 2,
      timeOfFirstRequest: 1765475802699,
      totalTimeout: 9007199254740991,
      maxRetryDelay: 9007199254740991,
      statusCodesToRetry: [Array]
    },
    method: 'POST',
    url: 'https://oauth2.googleapis.com/token',
    data: '<<REDACTED> - See `errorRedactor` option in `gaxios` for configuration>.',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'google-api-nodejs-client/9.15.1',
      'x-goog-api-client': 'gl-node/24.6.0'
    },
    paramsSerializer: [Function: paramsSerializer],
    body: '<<REDACTED> - See `errorRedactor` option in `gaxios` for configuration>.',
    validateStatus: [Function: validateStatus],
    responseType: 'unknown',
    errorRedactor: [Function: defaultErrorRedactor]
  },
  response: {
    config: {
      retry: true,
      retryConfig: [Object],
      method: 'POST',
      url: 'https://oauth2.googleapis.com/token',
      data: '<<REDACTED> - See `errorRedactor` option in `gaxios` for configuration>.',
      headers: [Object],
      paramsSerializer: [Function: paramsSerializer],
      body: '<<REDACTED> - See `errorRedactor` option in `gaxios` for configuration>.',
      validateStatus: [Function: validateStatus],
      responseType: 'unknown',
      errorRedactor: [Function: defaultErrorRedactor]
    },
    data: { error: 'invalid_grant', error_description: 'Bad Request' },
    headers: {
      'alt-svc': 'h3=":443"; ma=2592000,h3-29=":443"; ma=2592000',
      'cache-control': 'no-cache, no-store, max-age=0, must-revalidate',
      'content-encoding': 'gzip',
      'content-type': 'application/json; charset=utf-8',
      date: 'Thu, 11 Dec 2025 17:56:42 GMT',
      expires: 'Mon, 01 Jan 1990 00:00:00 GMT',
      pragma: 'no-cache',
      server: 'scaffolding on HTTPServer2',
      'transfer-encoding': 'chunked',
      vary: 'Origin, X-Origin, Referer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
      'x-xss-protection': '0'
    },
    status: 400,
    statusText: 'Bad Request',
    request: { responseURL: 'https://oauth2.googleapis.com/token' }
  },
  error: undefined,
  status: 400,
  Symbol(gaxios-gaxios-error): '6.7.1'
}
[WARN] Failed to create Google Calendar event from Retell flow: {
  error: 'invalid_grant',
  leadId: 'd2a3cb0a-005a-4fe5-8c8c-a4157ba4515c',
  resourceType: 'doctor',
  resourceId: '8650df2d-ad1e-40c8-a954-348ffbbf20b9'
}
Retell chat creation error: <!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Error</title>
</head>
<body>
<pre>Cannot POST /v2/create-chat</pre>
</body>
</html>

[WARN] Failed to create Retell chat: {
  error: 'Failed to create Retell chat: Request failed with status code 404',
  leadId: 'd2a3cb0a-005a-4fe5-8c8c-a4157ba4515c'
}
[INFO] Sending WhatsApp confirmation template: {
  leadId: 'd2a3cb0a-005a-4fe5-8c8c-a4157ba4515c',
  templateName: 'appointment_confirmation_doctor',
  resourceType: 'doctor',
  patientPhone: '+5511965539584',
  appointmentDate: '2026-01-19',
  appointmentTime: '13:00'
}
[INFO] WhatsApp template message sent successfully to +5511965539584 {
  messageId: 'wamid.HBgNNTUxMTk2NTUzOTU4NBUCABEYEjkwQjlEMTQ4RjQ2Q0E5NjNERQA=',
  template: 'appointment_confirmation_doctor',
  userId: 'd9c6312b-bacc-4db0-b448-45ba3defad59'
}