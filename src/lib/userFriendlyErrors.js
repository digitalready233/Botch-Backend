/**
 * Map technical or internal error messages to user-friendly messages.
 * Used so API responses never expose jargon like "jwt", "token", "ECONNREFUSED", etc.
 */
const USER_FRIENDLY_MAP = [
  [/jwt\s*(expired|malformed|invalid|must be)/i, 'Your session has expired or is invalid. Please sign in again.'],
  [/token\s*(expired|invalid|malformed)/i, 'Your session has expired or is invalid. Please sign in again.'],
  [/invalid\s*(or\s*)?expired\s*token/i, 'Your session has expired or is invalid. Please sign in again.'],
  [/authentication\s*required/i, 'Please sign in to continue.'],
  [/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND/i, 'We could not complete your request. Please check your connection and try again.'],
  [/failed to fetch|network\s*error/i, 'We could not reach the server. Please check your connection and try again.'],
  [/Unexpected token|JSON/i, 'Something went wrong with your request. Please try again.'],
  [/validation failed|invalid.*body/i, 'Please check the information you entered and try again.'],
  [/not found/i, 'The requested item could not be found.'],
  [/forbidden/i, "You don't have permission to do that."],
  [/LIMIT_FILE_SIZE/i, 'The file is too large. Please choose a smaller file.'],
  [/only allowed file types/i, 'This file type is not allowed. Please use an accepted format (e.g. image or PDF).'],
];

const DEFAULT_USER_MESSAGE = 'Something went wrong. Please try again in a moment.';

/**
 * Returns a user-friendly error message. Never returns technical strings.
 * @param {string} [technicalMessage] - Raw error message (e.g. from err.message)
 * @param {number} [status] - HTTP status (500 gets generic message in production)
 * @param {boolean} [isProduction] - If true, prefer generic message for server errors
 */
export function toUserFriendlyMessage(technicalMessage, status = 500, isProduction = false) {
  const raw = (technicalMessage && String(technicalMessage).trim()) || '';
  if (isProduction && status >= 500) return DEFAULT_USER_MESSAGE;
  for (const [pattern, friendly] of USER_FRIENDLY_MAP) {
    if (pattern.test(raw)) return friendly;
  }
  // If it looks like technical jargon, don't expose it
  if (/^[A-Z_]+$/.test(raw) || /undefined|null|\[object\]/.test(raw) || (raw.includes('at ') && raw.includes('.js:'))) {
    return DEFAULT_USER_MESSAGE;
  }
  // Short, readable messages can pass through (e.g. "Invalid email or password")
  if (raw.length > 0 && raw.length < 120 && !raw.includes('Bearer') && !raw.includes('Authorization')) {
    return raw;
  }
  return DEFAULT_USER_MESSAGE;
}
