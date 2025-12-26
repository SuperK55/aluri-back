/**
 * Timezone Utilities
 * Centralized timezone handling for São Paulo (GMT-3)
 */

/**
 * Get current time in São Paulo timezone
 */
export function getNowInSaoPaulo() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

/**
 * Convert a date to São Paulo timezone
 */
export function toSaoPauloTime(date) {
  return new Date(new Date(date).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

/**
 * Check if current time is within business hours (8 AM - 8 PM, Monday - Saturday)
 * @returns {boolean}
 */
export function isWithinBusinessHours() {
  const now = getNowInSaoPaulo();
  const currentDay = now.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const currentHour = now.getHours();
  
  // Business hours: Monday to Saturday, 8 AM to 8 PM (São Paulo time)
  return currentDay >= 1 && currentDay <= 6 && currentHour >= 8 && currentHour < 20;
}

/**
 * Get the start of day in São Paulo timezone
 * @param {Date} date - Date to get start of day for (defaults to today)
 * @returns {Date}
 */
export function getStartOfDaySaoPaulo(date = null) {
  const d = date ? toSaoPauloTime(date) : getNowInSaoPaulo();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Get the end of day in São Paulo timezone
 * @param {Date} date - Date to get end of day for (defaults to today)
 * @returns {Date}
 */
export function getEndOfDaySaoPaulo(date = null) {
  const d = date ? toSaoPauloTime(date) : getNowInSaoPaulo();
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * Format date in São Paulo timezone as ISO string with timezone offset
 * This preserves the São Paulo local time when saving to TIMESTAMPTZ columns
 * The date parameter should represent a time calculated in São Paulo timezone context
 * @param {Date} date - Date object representing a time in São Paulo timezone context
 * @returns {string} - ISO string with São Paulo timezone offset (e.g., "2025-12-25T09:34:00-03:00")
 */
export function toIsoStringSaoPaulo(date) {
  // Format the date components as they appear in São Paulo timezone
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
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
  
  // Calculate São Paulo timezone offset for this specific date
  // Create a date in UTC and in São Paulo timezone, then calculate the difference
  const utcTime = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const saoPauloTime = new Date(date.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const offsetMs = saoPauloTime.getTime() - utcTime.getTime();
  const offsetHours = Math.floor(Math.abs(offsetMs) / (1000 * 60 * 60));
  const offsetMinutes = Math.floor((Math.abs(offsetMs) % (1000 * 60 * 60)) / (1000 * 60));
  const offsetSign = offsetMs >= 0 ? '+' : '-';
  const offset = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;
  
  // Return ISO string with São Paulo timezone offset
  // This tells PostgreSQL: "This timestamp represents 09:34:00 in São Paulo timezone"
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
}

/**
 * Get current ISO string in São Paulo timezone with offset
 * @returns {string} - ISO string with São Paulo timezone offset
 */
export function getIsoStringNow() {
  return toIsoStringSaoPaulo(getNowInSaoPaulo());
}

/**
 * Normalize date string to YYYY-MM-DD format
 * Handles various input formats: DD/MM/YYYY, YYYY-MM-DD, etc.
 * @param {string} dateStr - Date string to normalize
 * @returns {string} - Date string in YYYY-MM-DD format
 */
export function normalizeDateString(dateStr) {
  if (!dateStr) return dateStr;
  // If already in YYYY-MM-DD format, return as is
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }
  
  // Handle DD/MM/YYYY format
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
    const [day, month, year] = dateStr.split('/');
    return `${year}-${month}-${day}`;
  }
  
  // Handle ISO format with time
  if (dateStr.includes('T')) {
    return dateStr.split('T')[0];
  }
  
  return dateStr;
}

/**
 * Get date string in YYYY-MM-DD format for a specific timezone
 * @param {Date} date - Date object
 * @param {string} timezone - Timezone string (e.g., 'America/Sao_Paulo')
 * @returns {string} - Date string in YYYY-MM-DD format
 */
export function getDateStringInTimezone(date, timezone = 'America/Sao_Paulo') {
  // Use Intl.DateTimeFormat to get date components in the specified timezone
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  
  // en-CA locale gives us YYYY-MM-DD format
  return formatter.format(date);
}

/**
 * Get day of week in a specific timezone
 * @param {Date} date - Date object
 * @param {string} timezone - Timezone string (e.g., 'America/Sao_Paulo')
 * @returns {number} - Day of the week (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
 */
export function getDayOfWeekInTimezone(date, timezone = 'America/Sao_Paulo') {
  // Use Intl.DateTimeFormat to get the day of the week in the specified timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short'
  });
  
  const dayName = formatter.format(date);
  const dayMap = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
  
  return dayMap[dayName] ?? new Date(date.toLocaleString('en-US', { timeZone: timezone })).getDay();
}

