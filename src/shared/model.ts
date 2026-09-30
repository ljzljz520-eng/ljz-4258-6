export type CultureState = 'staged' | 'released' | 'quarantined' | 'consumed';
export type MilkBaseState = 'prepared' | 'verified' | 'consumed' | 'rejected';
export type InoculationState = 'not_started' | 'awaiting_signatures' | 'issued' | 'cancelled';
export type CoolingState = 'warm' | 'cooling' | 'cooled';
export type FillingState = 'not_filled' | 'filling' | 'filled';
export type BatchPhase =
  | 'draft'
  | 'ready'
  | 'inoculated'
  | 'cooling'
  | 'cooled'
  | 'filling'
  | 'filled'
  | 'reconcile_required'
  | 'completed';

export interface Batch {
  id: string;
  version: number;
  tank_id: string;
  product_name: string;
  culture_version_id: string | null;
  milk_base_id: string | null;
  culture_state: CultureState;
  milk_state: MilkBaseState;
  inoculation_state: InoculationState;
  cooling_state: CoolingState;
  filling_state: FillingState;
  phase: BatchPhase;
  inoculated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Reading {
  id: number;
  batch_id: string;
  source_id: string;
  source_seq: number | null;
  kind: 'temperature' | 'ph';
  value: number;
  collected_at: string;
  client_created_at: string;
  received_at: string;
  calibration_anchor_id: number | null;
  clock_offset_ms: number;
  raw_hash: string;
  author_id: string;
  out_of_order: boolean;
}

export interface CoordinationItem {
  id: number;
  kind: 'offline_conflict' | 'sequence_conflict' | 'evidence_gap' | 'qualification' | 'duplicate_mismatch';
  batch_id: string | null;
  source_id: string | null;
  reason: string;
  payload: unknown;
  status: 'open' | 'resolved' | 'rejected';
  created_at: string;
}

export interface ConfirmationContext {
  batchVersion: number;
  cultureVersionId: string;
  evidence: {
    temperatureSource: boolean;
    phSource: boolean;
    watermarkSeq: number | null;
  };
}

export type BlockReason =
  | 'OFFLINE_CANNOT_ISSUE'
  | 'SAME_ACCOUNT'
  | 'UNQUALIFIED'
  | 'CULTURE_VERSION_MISMATCH'
  | 'BATCH_VERSION_CONFLICT'
  | 'INSUFFICIENT_EVIDENCE'
  | 'READING_SEQUENCE_GAP'
  | 'INVALID_TRANSITION'
  | 'NOT_READY'
  | 'BACKFILL_AFTER_ISSUANCE';
