export interface ExternalPatient {
  externalId: string;
  fullName: string;
  phone?: string;
  source?: string;
  preferredContact?: string;
  lastVisitAt?: Date;
  createdAt?: Date;
  firstVisitAt?: Date;
  birthday?: Date;
  balanceIssued?: number;
  balancePaid?: number;
  // more of the card (2026-11-24); notes, stages and files are deliberately not read (medical records)
  phone2?: string;
  email?: string;
  gender?: string;
  tags?: string[];
  subclinic?: string;
  curator?: string;
}

export interface ExternalVisit {
  externalId: string;
  patientExternalId: string;
  doctorId?: string;
  doctorName?: string;
  cabinetId?: string;
  serviceName?: string;
  startsAt: Date;
  endsAt?: Date;
  bookedAt?: Date;
  // Cliniccards status without conversion (PLANNED, VISITED, DID_NOT_COME, ...)
  status: string;
  amount?: number;
}

export interface ExternalPlanItem {
  externalId: string;
  patientExternalId: string;
  planId: string;
  name: string;
  price?: number;
  // NEW, PLANNED_TO_DO, DONE, INVOICED
  status: string;
  groupName?: string;
  createdAt: Date;
  markedDoneAt?: Date;
  doneByDoctorId?: string;
}

export interface ExternalPayment {
  externalId: string;
  patientExternalId?: string;
  paidAt: Date;
  amount: number;
  type?: string;
}

export interface ExternalInvoice {
  externalId: string;
  patientExternalId?: string;
  issuedAt: Date;
  amount: number;
  issuerName?: string;
}

export interface ExternalShift {
  externalId: string;
  doctorId: string;
  doctorName?: string;
  cabinetId: string;
  cabinetName?: string;
  startsAt: Date;
  endsAt: Date;
}

export interface ExternalBlock {
  externalId: string;
  cabinetId: string;
  startsAt: Date;
  endsAt: Date;
  note?: string;
}

export interface SyncWindow {
  from: Date;
  to: Date;
}

// A doctor of the clinic (GET /staff, role DOCTOR). The phone of a staff member is deliberately not read.
export interface ExternalDoctor {
  externalId: string;
  lastName: string;
  firstName: string;
}

// The working hours of the clinic as Cliniccards keeps them (GET /schedule-settings): per weekday '1' Monday ... '7' Sunday, null for a
// non-working day, and the holidays (dates). Cliniccards has no hours of its own for a cabinet or a doctor in this method.
export interface ExternalWorkingHours {
  week: Record<string, { from: string; to: string } | null>;
  holidays: string[];
}

export interface ExternalCabinet {
  externalId: string;
  name: string;
}

export interface ExternalPlan {
  externalId: string;
  // Plan total and the completed part, with discount, in the clinic's main currency
  total: number;
  totalDone: number;
  createdAt: Date;
}

export interface ExternalReminder {
  externalId: string;
  patientExternalId?: string;
  // Reminder day (a date without time)
  dueDate: Date;
  note?: string;
  // NEW, DONE, CANCELLED, MOVED
  status: string;
}

export interface ExternalProfile {
  // image data URI (jpeg, png, webp, gif)
  logo?: string;
  // The name of the clinic as Cliniccards has it (GET /clinic-profile)
  name?: string;
}

// Booking in the clinic's system. Times are the clinic's local time (Europe/Kyiv), multiples of 5 minutes.
export interface CreateVisitRequest {
  patientExternalId: string;
  cabinetId: string;
  // Required by the official documentation of POST /visits (doctor_id REQUIRED); a booking without a known doctor is not sent
  doctorId: string;
  startsAt: Date;
  endsAt: Date;
  // Cliniccards requires a note of 1-400 characters
  note: string;
}

export interface UpdateVisitRequest {
  // Where the visit currently is (its day is read to get the fields that PUT must repeat)
  currentStartsAt: Date;
  status?: string;
  startsAt?: Date;
  endsAt?: Date;
  doctorId?: string;
  cabinetId?: string;
}

export interface CreatePatientRequest {
  lastName: string;
  firstName: string;
  phone: string;
  // The channel the person wrote from (TELEGRAM, INSTAGRAM, MESSENGER, WHATSAPP, VIBER); sent as preferred_contact, which has a documented list of
  // values. The `source` field of Cliniccards is NOT sent: it takes only sources the clinic has configured, and which names they are is unknown.
  channel?: string;
}

// One interface of a data source. The rest of the code does not know about Cliniccards directly.
export interface ClinicConnector {
  fetchPatients(): Promise<ExternalPatient[]>;
  fetchVisits(window: SyncWindow): Promise<ExternalVisit[]>;
  fetchTreatment(window: SyncWindow): Promise<ExternalPlanItem[]>;
  fetchFinance(window: SyncWindow): Promise<{ payments: ExternalPayment[]; invoices: ExternalInvoice[] }>;
  // Optional: the list of cabinets
  fetchCabinets?(): Promise<ExternalCabinet[]>;
  // Optional: the clinic's doctors (for choosing a doctor when booking)
  fetchDoctors?(): Promise<ExternalDoctor[]>;
  // Optional: the clinic's working hours; null if the method did not return them or the answer was not understood (the hours are then not guessed)
  fetchWorkingHours?(): Promise<ExternalWorkingHours | null>;
  // Optional: totals of treatment plans for a period
  fetchPlans?(window: SyncWindow): Promise<ExternalPlan[]>;
  // Optional: reminders for staff for a period
  fetchReminders?(window: SyncWindow): Promise<ExternalReminder[]>;
  // Optional: information about the clinic (logo). Its failure must not break the main load.
  fetchProfile?(): Promise<ExternalProfile>;
  // Optional write methods (only on an explicit staff action; disabled for real clinics until the manual verification stage)
  createVisit?(req: CreateVisitRequest): Promise<{ externalId: string }>;
  updateVisit?(externalId: string, req: UpdateVisitRequest): Promise<void>;
  createPatient?(req: CreatePatientRequest): Promise<{ externalId: string }>;
  // Used to check whether a patient was created when the answer to the write was lost
  findPatientIdsByPhone?(phone: string): Promise<string[]>;
  // Optional: the clinic's price list, used only to prepare drafts of the knowledge base (a person checks every price)
  fetchServiceList?(): Promise<{ externalId: string; name: string; groupName?: string; description?: string; priceUah?: number }[]>;
  fetchSchedule(window: SyncWindow): Promise<{ shifts: ExternalShift[]; blocks: ExternalBlock[] }>;
}
