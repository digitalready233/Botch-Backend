/** Property viewing appointment statuses (matches DB CHECK on appointments.status). */

export const BOOKING_STATUS_VALUES = [
  'pending',
  'confirmed',
  'rescheduled',
  'cancelled',
  'completed',
];

export const BOOKING_STATUS_LABELS = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  rescheduled: 'Rescheduled',
  cancelled: 'Cancelled',
  completed: 'Completed',
};
