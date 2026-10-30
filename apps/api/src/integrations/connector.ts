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
  // Статус Cliniccards без преобразования (PLANNED, VISITED, DID_NOT_COME, ...)
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

export interface ExternalCabinet {
  externalId: string;
  name: string;
}

export interface ExternalPlan {
  externalId: string;
  // Итог плана и выполненная часть, с учётом скидки, в основной валюте клиники
  total: number;
  totalDone: number;
  createdAt: Date;
}

export interface ExternalReminder {
  externalId: string;
  patientExternalId?: string;
  // День напоминания (дата без времени)
  dueDate: Date;
  note?: string;
  // NEW, DONE, CANCELLED, MOVED
  status: string;
}

export interface ExternalProfile {
  // data-URI изображения (jpeg, png, webp, gif)
  logo?: string;
}

// Booking in the clinic's system. Times are the clinic's local time (Europe/Kyiv), multiples of 5 minutes.
export interface CreateVisitRequest {
  patientExternalId: string;
  cabinetId: string;
  // Whether a doctor is required is to be verified on a live clinic (112 dental has doctor profiles for only some doctors)
  doctorId?: string;
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
  // The inquiry source (Cliniccards `source`), for example Instagram
  source?: string;
}

// Единый интерфейс источника данных. Остальной код не знает про Cliniccards напрямую.
export interface ClinicConnector {
  fetchPatients(): Promise<ExternalPatient[]>;
  fetchVisits(window: SyncWindow): Promise<ExternalVisit[]>;
  fetchTreatment(window: SyncWindow): Promise<ExternalPlanItem[]>;
  fetchFinance(window: SyncWindow): Promise<{ payments: ExternalPayment[]; invoices: ExternalInvoice[] }>;
  // Необязательно: список кабинетов
  fetchCabinets?(): Promise<ExternalCabinet[]>;
  // Необязательно: итоги планов лечения за период
  fetchPlans?(window: SyncWindow): Promise<ExternalPlan[]>;
  // Необязательно: напоминания сотрудникам за период
  fetchReminders?(window: SyncWindow): Promise<ExternalReminder[]>;
  // Необязательно: сведения о клинике (логотип). Их сбой не должен ломать основную загрузку.
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
