export type Role = 'operator' | 'quality' | 'supervisor';
export type StreamType = 'batch' | 'culture' | 'milk';
export type SourceKind = 'temperature' | 'ph';

export type CultureStatus = 'received' | 'quarantined' | 'released' | 'voided';
export type MilkStatus = 'received' | 'released' | 'consumed';
export type InoculationStatus = 'not_authorized' | 'one_person' | 'confirmed' | 'inoculated' | 'aborted';
export type CoolingStatus = 'not_started' | 'started' | 'completed' | 'aborted';
export type FillingStatus = 'not_started' | 'completed' | 'aborted';
export type BatchStatus = 'created' | 'inoculated' | 'cooling' | 'cooled' | 'filled' | 'aborted';

export interface User {
  id: string;
  name: string;
  roles: Role[];
  token: string;
}

export interface Device {
  id: string;
  name: string;
  kind: SourceKind;
  ingestToken: string;
  active: boolean;
}

export interface EvidenceRequirement { sourceId: string; startSeq: number; minCount: number }

export interface CultureState {
  id: string;
  code: string;
  signVersion: number;
  status: CultureStatus;
  revision: number;
  planVersion: number;
}

export interface MilkState {
  id: string;
  code: string;
  supplier?: string;
  status: MilkStatus;
  revision: number;
  planVersion: number;
}

export interface ConfirmationFact {
  confirmationId: string;
  userId: string;
  userName: string;
  roles: Role[];
  cultureId: string;
  culturePlanVersion: number;
  batchPlanVersion: number;
  observedAt: string;
  receivedAt: string;
  ticketId: string;
  valid: boolean;
  invalidReason?: string;
}

export interface Reconciliation {
  id: string;
  kind: 'confirmation_mismatch' | 'stale_command';
  status: 'open' | 'resolved';
  summary: string;
  evidence: Record<string, unknown>;
  openedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolution?: 'accepted_after_review' | 'rejected_and_rerecorded';
}

export interface BatchState {
  id: string;
  label: string;
  cultureId: string;
  culturePlanVersionAtCreation: number;
  milkId: string;
  status: BatchStatus;
  inoculation: InoculationStatus;
  cooling: CoolingStatus;
  filling: FillingStatus;
  evidenceRequirements: EvidenceRequirement[];
  revision: number;
  planVersion: number;
  createdAt: string;
  inoculatedAt?: string;
  confirmations: ConfirmationFact[];
  reconciliation: Reconciliation[];
  lastIssueBlock?: { at: string; reasons: string[] };
}

export interface RootState {
  cultures: Record<string, CultureState>;
  milks: Record<string, MilkState>;
  batches: Record<string, BatchState>;
}

export interface AuthContext { userId: string; name: string; roles: Role[]; }

interface BaseCommand { expectedPlanVersion?: number; observedAt?: string; }
export type Command =
  | ({ type: 'culture.register'; cultureId: string; code: string })
  | ({ type: 'culture.quarantine'; cultureId: string } & BaseCommand)
  | ({ type: 'culture.release'; cultureId: string } & BaseCommand)
  | ({ type: 'culture.change_sign'; cultureId: string; signVersion: number } & BaseCommand)
  | ({ type: 'culture.void'; cultureId: string; reason: string } & BaseCommand)
  | ({ type: 'milk.register'; milkId: string; code: string; supplier?: string })
  | ({ type: 'milk.release'; milkId: string } & BaseCommand)
  | ({ type: 'batch.create'; batchId: string; label: string; cultureId: string; milkId: string; evidenceRequirements: EvidenceRequirement[] })
  | ({ type: 'inoculation.confirm'; batchId: string; confirmationId: string; cultureId: string; culturePlanVersion: number; batchPlanVersion: number; observedAt: string; ticketId: string })
  | ({ type: 'inoculation.issue'; batchId: string } & BaseCommand)
  | ({ type: 'cooling.start'; batchId: string } & BaseCommand)
  | ({ type: 'cooling.complete'; batchId: string; actualTemperatureC: number } & BaseCommand)
  | ({ type: 'filling.start'; batchId: string } & BaseCommand)
  | ({ type: 'filling.complete'; batchId: string; packages: number } & BaseCommand)
  | ({ type: 'batch.abort'; batchId: string; reason: string } & BaseCommand)
  | ({ type: 'reconciliation.resolve'; batchId: string; reconciliationId: string; resolution: 'accepted_after_review' | 'rejected_and_rerecorded' } & BaseCommand);

export type DomainEvent =
  | { type: 'culture.registered'; cultureId: string; code: string; actor: AuthContext; at: string }
  | { type: 'culture.quarantined'; cultureId: string; actor: AuthContext; at: string }
  | { type: 'culture.released'; cultureId: string; actor: AuthContext; at: string }
  | { type: 'culture.sign_changed'; cultureId: string; signVersion: number; actor: AuthContext; at: string }
  | { type: 'culture.voided'; cultureId: string; reason: string; actor: AuthContext; at: string }
  | { type: 'milk.registered'; milkId: string; code: string; supplier?: string; actor: AuthContext; at: string }
  | { type: 'milk.consumed'; milkId: string; batchId: string; actor: AuthContext; at: string }
  | { type: 'milk.released'; milkId: string; actor: AuthContext; at: string }
  | { type: 'batch.created'; batchId: string; label: string; cultureId: string; culturePlanVersion: number; milkId: string; evidenceRequirements: EvidenceRequirement[]; actor: AuthContext; at: string }
  | { type: 'inoculation.confirmed'; batchId: string; confirmation: Omit<ConfirmationFact, 'valid' | 'invalidReason' | 'receivedAt'>; actor: AuthContext; at: string }
  | { type: 'inoculation.issued'; batchId: string; actor: AuthContext; at: string; observedAt: string }
  | { type: 'inoculation.issue_rejected'; batchId: string; reasons: string[]; actor: AuthContext; at: string }
  | { type: 'cooling.started'; batchId: string; actor: AuthContext; at: string; observedAt: string }
  | { type: 'cooling.completed'; batchId: string; actualTemperatureC: number; actor: AuthContext; at: string; observedAt: string }
  | { type: 'filling.started'; batchId: string; actor: AuthContext; at: string; observedAt: string }
  | { type: 'filling.completed'; batchId: string; packages: number; actor: AuthContext; at: string; observedAt: string }
  | { type: 'batch.aborted'; batchId: string; reason: string; actor: AuthContext; at: string; observedAt: string }
  | { type: 'reconciliation.opened'; batchId: string; reconciliation: Omit<Reconciliation, 'status' | 'openedAt'> & { openedAt?: string }; actor: AuthContext; at: string }
  | { type: 'reconciliation.resolved'; batchId: string; reconciliationId: string; resolution: Reconciliation['resolution']; actor: AuthContext; at: string; observedAt: string };

export interface StoredEvent {
  eventId: string;
  streamType: StreamType;
  streamId: string;
  revision: number;
  planVersion: number;
  event: DomainEvent;
}

export interface Reading {
  readingId: string;
  sourceId: string;
  sourceKind: SourceKind;
  batchId: string;
  seq: number;
  value: number;
  observedAt: string; // device clock, never rewritten
  receivedAt: string; // server receive clock
  calibrationAnchorId?: string;
}

export interface ClockAnchor {
  anchorId: string;
  sourceId: string;
  seq: number;
  deviceTime: string;
  referenceTime: string;
  driftMs: number;
  receivedAt: string;
}

export interface OfflineTicket {
  ticketId: string;
  userId: string;
  secret: string;
  issuedAt: string;
  expiresAt: string;
  revoked: boolean;
}

export const initialState = (): RootState => ({ cultures: {}, milks: {}, batches: {} });

export function eventChangesPlan(event: DomainEvent): boolean {
  return !['inoculation.confirmed', 'inoculation.issue_rejected', 'reconciliation.opened', 'culture.quarantined', 'culture.released', 'culture.voided'].includes(event.type);
}
