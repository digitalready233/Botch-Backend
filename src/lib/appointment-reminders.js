/**
 * Reminder hooks for property viewings. Wire to cron / job queue when ready.
 * createNotificationForUser can be called from a scheduled job using reminder_at.
 */

/**
 * Called after create/update when status or schedule changes.
 * Placeholder: compute default reminder 24h before scheduled slot if possible.
 */
export function computeDefaultReminderAt({ scheduled_date, scheduled_time, preferred_date, preferred_time }) {
  const dateStr = scheduled_date || preferred_date;
  if (!dateStr) return null;
  const timeStr = scheduled_time || preferred_time || '09:00';
  try {
    const iso = `${dateStr}T${String(timeStr).slice(0, 5)}:00`;
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return null;
    const reminder = new Date(t.getTime() - 24 * 60 * 60 * 1000);
    return reminder.toISOString();
  } catch {
    return null;
  }
}

/**
 * No-op placeholder for a future worker that sends reminder notifications.
 */
export function scheduleReminderJob(_appointmentId, _reminderAtIso) {
  // e.g. enqueue { type: 'appointment_reminder', id, at: reminderAtIso }
}

/**
 * Mark reminder as sent (call from worker after notify).
 */
export function placeholderMarkReminderSent(_appointmentId) {
  // UPDATE appointments SET reminder_sent_at = CURRENT_TIMESTAMP WHERE id = ?
}
