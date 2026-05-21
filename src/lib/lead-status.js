/** Canonical lead pipeline for property listing inquiries (matches DB CHECK). */

export const LEAD_STATUS_VALUES = [
  'new',
  'contacted',
  'interested',
  'inspection_booked',
  'negotiating',
  'closed_won',
  'closed_lost',
];

export const LEAD_STATUS_LABELS = {
  new: 'New',
  contacted: 'Contacted',
  interested: 'Interested',
  inspection_booked: 'Inspection booked',
  negotiating: 'Negotiating',
  closed_won: 'Closed won',
  closed_lost: 'Closed lost',
};

export function labelLeadStatus(status) {
  return LEAD_STATUS_LABELS[status] || status;
}
