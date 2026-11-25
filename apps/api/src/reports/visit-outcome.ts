// How a visit's Cliniccards status counts in the share of cancellations and no-shows (2026-11-25): ONE list for the signal "Cancellations and
// no-shows" (InsightsService) and the weekly and monthly reports (ReportsService.periodSummary), so the two never differ.
// Cliniccards has ten statuses: PLANNED, CONFIRMED, NOT_CONFIRMED, BOOKING, VISITED, IN_CLINIC, IN_CHAIR, DID_NOT_COME, CANCELLED, MOVED.

// The numerator: cancelled or missed
export const MISSED_STATUSES = ['CANCELLED', 'DID_NOT_COME'];
// The denominator: visits whose result is known: came (visited, in the clinic, in the chair), did not come, cancelled, moved
export const KNOWN_RESULT_STATUSES = ['VISITED', 'IN_CLINIC', 'IN_CHAIR', 'DID_NOT_COME', 'CANCELLED', 'MOVED'];
// Neither: no mark whether the patient came (planned, confirmed, not confirmed, a booking); shown apart, never in the share
export const NO_RESULT_STATUSES = ['PLANNED', 'CONFIRMED', 'NOT_CONFIRMED', 'BOOKING'];
