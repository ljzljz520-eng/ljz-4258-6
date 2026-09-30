import crypto from 'node:crypto';
import {
  AuthContext, BatchState, Command, ConfirmationFact, DomainEvent, initialState,
  Reading, Reconciliation, RootState, StoredEvent, eventChangesPlan, type EvidenceRequirement,
} from './types.js';

export class DomainError extends Error {
  statusCode: number;
  code: string;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const nowIso = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const hasRole = (actor: AuthContext, role: string) => actor.roles.includes(role as never);
const assertRole = (actor: AuthContext, ...roles: string[]) => {
  if (!roles.some((r) => hasRole(actor, r))) throw new DomainError('FORBIDDEN', `需要角色: ${roles.join(' 或 ')}`, 403);
};
const assertOpen = (r: Reconciliation[]) => {
  if (r.some((x) => x.status === 'open')) throw new DomainError('PENDING_RECONCILIATION', '该批次存在待协调冲突，必须由主管处理。', 409);
};

export function nextRevision(state: RootState, streamType: 'batch' | 'culture' | 'milk', streamId: string) {
  if (streamType === 'culture') return (state.cultures[streamId]?.revision ?? 0) + 1;
  if (streamType === 'milk') return (state.milks[streamId]?.revision ?? 0) + 1;
  return (state.batches[streamId]?.revision ?? 0) + 1;
}
export function nextPlanVersion(state: RootState, streamType: 'batch' | 'culture' | 'milk', streamId: string) {
  if (streamType === 'culture') return (state.cultures[streamId]?.planVersion ?? 0) + 1;
  if (streamType === 'milk') return (state.milks[streamId]?.planVersion ?? 0) + 1;
  return (state.batches[streamId]?.planVersion ?? 0) + 1;
}

export function reduce(root: RootState, stored: StoredEvent): RootState {
  const { streamType, streamId, revision, planVersion, event } = stored;
  if (streamType === 'culture' && root.cultures[streamId]) {
    const c = { ...root.cultures[streamId], revision, planVersion };
    if (event.type === 'culture.quarantined') c.status = 'quarantined';
    if (event.type === 'culture.released') c.status = 'released';
    if (event.type === 'culture.sign_changed') c.signVersion = event.signVersion;
    if (event.type === 'culture.voided') c.status = 'voided';
    return { ...root, cultures: { ...root.cultures, [streamId]: c } };
  }
  if (streamType === 'milk' && root.milks[streamId]) {
    const m = { ...root.milks[streamId], revision, planVersion };
    if (event.type === 'milk.released') m.status = 'released';
    if (event.type === 'milk.consumed') m.status = 'consumed';
    return { ...root, milks: { ...root.milks, [streamId]: m } };
  }

  if (event.type === 'culture.registered') {
    root.cultures[event.cultureId] = { id: event.cultureId, code: event.code, signVersion: 1, status: 'received', revision, planVersion };
    return { ...root };
  }
  if (event.type === 'milk.registered') {
    root.milks[event.milkId] = { id: event.milkId, code: event.code, supplier: event.supplier, status: 'received', revision, planVersion };
    return { ...root };
  }
  if (event.type === 'batch.created') {
    root.batches[event.batchId] = {
      id: event.batchId, label: event.label, cultureId: event.cultureId,
      culturePlanVersionAtCreation: event.culturePlanVersion, milkId: event.milkId,
      status: 'created', inoculation: 'not_authorized', cooling: 'not_started', filling: 'not_started',
      evidenceRequirements: event.evidenceRequirements, revision, planVersion, createdAt: event.at,
      confirmations: [], reconciliation: [],
    };
    return { ...root };
  }

  const batch = root.batches[streamId];
  if (!batch || streamType !== 'batch') return root;
  const b: BatchState = { ...batch, revision, planVersion: eventChangesPlan(event) ? planVersion : batch.planVersion };

  switch (event.type) {
    case 'inoculation.confirmed': {
      const exists = b.confirmations.some((c) => c.confirmationId === event.confirmation.confirmationId);
      const fact: ConfirmationFact = { ...event.confirmation, receivedAt: event.at, valid: true };
      b.confirmations = exists ? b.confirmations : [...b.confirmations, fact];
      const uniquePeople = new Set(b.confirmations.filter((c) => c.valid).map((c) => c.userId));
      if (uniquePeople.size === 1) b.inoculation = 'one_person';
      if (uniquePeople.size >= 2) b.inoculation = 'confirmed';
      break;
    }
    case 'inoculation.issued':
      b.inoculation = 'inoculated'; b.status = 'inoculated'; b.inoculatedAt = event.observedAt; b.lastIssueBlock = undefined; break;
    case 'inoculation.issue_rejected':
      b.lastIssueBlock = { at: event.at, reasons: event.reasons }; break;
    case 'cooling.started':
      b.cooling = 'started'; b.status = 'cooling'; break;
    case 'cooling.completed':
      b.cooling = 'completed'; b.status = 'cooled'; break;
    case 'filling.started':
      b.filling = 'not_started'; break;
    case 'filling.completed':
      b.filling = 'completed'; b.status = 'filled'; break;
    case 'batch.aborted':
      b.status = 'aborted'; b.inoculation = b.inoculation === 'inoculated' ? b.inoculation : 'aborted';
      b.cooling = b.cooling === 'completed' ? b.cooling : 'aborted';
      b.filling = b.filling === 'completed' ? b.filling : 'aborted'; break;
    case 'reconciliation.opened': {
      const r = event.reconciliation;
      if (!b.reconciliation.some((x) => x.id === r.id)) {
        b.reconciliation = [...b.reconciliation, { id: r.id, kind: r.kind, status: 'open', summary: r.summary, evidence: r.evidence, openedAt: r.openedAt ?? event.at }];
      }
      if (r.kind === 'confirmation_mismatch' && !b.confirmations.some((c) => c.confirmationId === (r.evidence as { command?: { confirmationId?: string } }).command?.confirmationId)) {
        const cmd = r.evidence.command as { confirmationId: string; userId?: string; observedAt: string; ticketId: string; cultureId: string; culturePlanVersion: number; batchPlanVersion: number };
        b.confirmations = [...b.confirmations, {
          confirmationId: cmd.confirmationId,
          userId: cmd.userId ?? 'unknown',
          userName: cmd.userId ?? '离线人员',
          roles: [],
          cultureId: cmd.cultureId,
          culturePlanVersion: cmd.culturePlanVersion,
          batchPlanVersion: cmd.batchPlanVersion,
          observedAt: cmd.observedAt,
          receivedAt: event.at,
          ticketId: cmd.ticketId,
          valid: false,
          invalidReason: r.summary,
        }];
        b.inoculation = recalculateInoculationStatus(b.inoculation, b.confirmations);
      }
      break;
    }
    case 'reconciliation.resolved':
      b.reconciliation = b.reconciliation.map((r) => r.id === event.reconciliationId
        ? { ...r, status: 'resolved', resolvedAt: event.at, resolvedBy: event.actor.userId, resolution: event.resolution } : r);
      if (event.resolution === 'rejected_and_rerecorded') {
        const ids = new Set(b.reconciliation.flatMap((r) => r.id === event.reconciliationId ? [((r.evidence as {command?:{confirmationId?:string}}).command?.confirmationId ?? '')] : []));
        b.confirmations = b.confirmations.filter((c) => !ids.has(c.confirmationId));
      }
      b.inoculation = recalculateInoculationStatus(b.inoculation, b.confirmations);
      break;
  }
  return { ...root, batches: { ...root.batches, [b.id]: b } };
}

export function replay(events: StoredEvent[]): RootState {
  return events.reduce((state, e) => reduce(state, e), initialState());
}


function recalculateInoculationStatus(current: BatchState['inoculation'], confirmations: ConfirmationFact[]): BatchState['inoculation'] {
  if (current === 'inoculated' || current === 'aborted') return current;
  const validPeople = new Set(confirmations.filter((c) => c.valid).map((c) => c.userId));
  if (validPeople.size >= 2) return 'confirmed';
  if (validPeople.size === 1) return 'one_person';
  return 'not_authorized';
}

function wrap<T extends DomainEvent>(streamType: 'batch' | 'culture' | 'milk', streamId: string, evt: T, state: RootState): StoredEvent[] {
  const revision = nextRevision(state, streamType, streamId);
  const planVersion = eventChangesPlan(evt) ? nextPlanVersion(state, streamType, streamId) : (state.batches[streamId]?.planVersion ?? state.cultures[streamId]?.planVersion ?? state.milks[streamId]?.planVersion ?? 0);
  return [{ eventId: newId('evt'), streamType, streamId, revision, planVersion, event: evt }];
}

function markInvalidConfirmation(b: BatchState, confirmationId: string, reason: string, at: string): ConfirmationFact[] {
  return b.confirmations.map((c) => c.confirmationId === confirmationId ? { ...c, valid: false, invalidReason: reason } : c);
}

function openReconciliation(b: BatchState, kind: Reconciliation['kind'], summary: string, evidence: Record<string, unknown>, actor: AuthContext, at: string): StoredEvent[] {
  const id = newId('rec');
  const recEvent: DomainEvent = { type: 'reconciliation.opened', batchId: b.id, reconciliation: { id, kind, summary, evidence, openedAt: at }, actor, at };
  return [{ eventId: newId('evt'), streamType: 'batch', streamId: b.id, revision: b.revision + 1, planVersion: b.planVersion, event: recEvent }];
}

export function planVersionOkay(current: number | undefined, expected: number | undefined) {
  return expected === undefined || current === expected;
}

export function watermark(readings: Reading[], sourceId: string): number {
  const seqs = readings.filter((r) => r.sourceId === sourceId).map((r) => r.seq).sort((a, z) => a - z);
  let expected = 1;
  for (const seq of seqs) {
    if (seq === expected) expected += 1;
    else if (seq > expected) break;
  }
  return expected - 1;
}

export function evidenceCount(readings: Reading[], sourceId: string, startSeq: number): number {
  const seqs = new Set(readings.filter((r) => r.sourceId === sourceId).map((r) => r.seq));
  let count = 0;
  while (seqs.has(startSeq + count)) count += 1;
  return count;
}
export function missingEvidence(b: BatchState, readings: Reading[]): string[] {
  return b.evidenceRequirements.flatMap((req: EvidenceRequirement) => {
    const count = evidenceCount(readings, req.sourceId, req.startSeq);
    return count >= req.minCount ? [] : [`来源 ${req.sourceId} 证据水位 ${count}/${req.minCount}（从 #${req.startSeq} 起连续）`];
  });
}

function eligibleConfirmation(c: ConfirmationFact) {
  return c.valid && c.roles.some((r) => r === 'operator' || r === 'quality');
}

export function issueReasons(root: RootState, b: BatchState, readings: Reading[], includeEvidence = true): string[] {
  const reasons: string[] = [];
  if (b.status !== 'created') reasons.push(`批次状态 ${b.status} 不能签发接种`);
  if (b.reconciliation.some((r) => r.status === 'open')) reasons.push('存在待协调冲突');
  const valid = b.confirmations.filter(eligibleConfirmation);
  const people = new Map(valid.map((c) => [c.userId, c]));
  if (people.size < 2) reasons.push(`只有 ${people.size} 名合格人员，需要两名不同账号`);
  const roles = new Set(valid.flatMap((c) => c.roles));
  if (!roles.has('operator') || !roles.has('quality')) reasons.push('必须分别具备 operator 与 quality 资格');
  if (valid.some((c) => c.cultureId !== b.cultureId)) reasons.push('确认绑定了不同菌种');
  if (valid.some((c) => c.batchPlanVersion !== b.planVersion)) reasons.push('确认基于旧批次版本');
  const culture = root.cultures[b.cultureId];
  if (!culture || culture.status !== 'released') reasons.push('菌种未处于 released 状态');
  if (valid.some((c) => c.culturePlanVersion !== culture?.planVersion)) reasons.push('确认绑定的菌种版本与当前版本不同');
  if (includeEvidence) reasons.push(...missingEvidence(b, readings));
  return reasons;
}

export function decide(root: RootState, command: Command, actor: AuthContext, readings: Reading[] = [], at = nowIso()): { events: StoredEvent[]; state: RootState } {
  const events: StoredEvent[] = [];
  let state = root;
  const emit = (streamType: 'batch' | 'culture' | 'milk', streamId: string, event: DomainEvent) => {
    const stored = wrap(streamType, streamId, event, state)[0]!;
    events.push(stored); state = reduce(state, stored);
  };

  switch (command.type) {
    case 'culture.register': {
      assertRole(actor, 'supervisor', 'quality');
      if (state.cultures[command.cultureId]) throw new DomainError('EXISTS', '菌种已存在', 409);
      emit('culture', command.cultureId, { type: 'culture.registered', cultureId: command.cultureId, code: command.code, actor, at });
      break;
    }
    case 'culture.quarantine':
      assertRole(actor, 'quality', 'supervisor');
      { const c = state.cultures[command.cultureId]; if (!c) throw new DomainError('NOT_FOUND', '菌种不存在', 404); if (!planVersionOkay(c.planVersion, command.expectedPlanVersion)) throw new DomainError('VERSION_CONFLICT', '菌种已换签或被修改', 409); if (!['received', 'released'].includes(c.status)) throw new DomainError('INVALID_STATE', `状态 ${c.status} 不能隔离`); emit('culture', command.cultureId, { type: 'culture.quarantined', cultureId: command.cultureId, actor, at }); }
      break;
    case 'culture.release':
      assertRole(actor, 'quality');
      { const c = state.cultures[command.cultureId]; if (!c) throw new DomainError('NOT_FOUND', '菌种不存在', 404); if (!planVersionOkay(c.planVersion, command.expectedPlanVersion)) throw new DomainError('VERSION_CONFLICT', '菌种版本已变化', 409); if (!['received', 'quarantined'].includes(c.status)) throw new DomainError('INVALID_STATE', `状态 ${c.status} 不能放行`); emit('culture', command.cultureId, { type: 'culture.released', cultureId: command.cultureId, actor, at }); }
      break;
    case 'culture.change_sign': {
      assertRole(actor, 'quality');
      const c = state.cultures[command.cultureId];
      if (!c) throw new DomainError('NOT_FOUND', '菌种不存在', 404);
      if (!planVersionOkay(c.planVersion, command.expectedPlanVersion)) throw new DomainError('VERSION_CONFLICT', '菌种版本已变化', 409);
      if (c.status === 'voided') throw new DomainError('INVALID_STATE', '作废菌种不能换签');
      if (command.signVersion <= c.signVersion) throw new DomainError('INVALID_VERSION', '新签版本必须递增');
      emit('culture', command.cultureId, { type: 'culture.sign_changed', cultureId: command.cultureId, signVersion: command.signVersion, actor, at });
      break;
    }
    case 'culture.void':
      assertRole(actor, 'quality', 'supervisor');
      { const c = state.cultures[command.cultureId]; if (!c) throw new DomainError('NOT_FOUND', '菌种不存在', 404); if (!planVersionOkay(c.planVersion, command.expectedPlanVersion)) throw new DomainError('VERSION_CONFLICT', '菌种版本已变化', 409); if (c.status === 'voided') throw new DomainError('INVALID_STATE', '菌种已作废'); emit('culture', command.cultureId, { type: 'culture.voided', cultureId: command.cultureId, reason: command.reason, actor, at }); }
      break;

    case 'milk.register':
      assertRole(actor, 'operator', 'supervisor');
      if (state.milks[command.milkId]) throw new DomainError('EXISTS', '奶基已存在', 409);
      emit('milk', command.milkId, { type: 'milk.registered', milkId: command.milkId, code: command.code, supplier: command.supplier, actor, at });
      break;
    case 'milk.release':
      assertRole(actor, 'quality', 'supervisor');
      { const m = state.milks[command.milkId]; if (!m) throw new DomainError('NOT_FOUND', '奶基不存在', 404); if (!planVersionOkay(m.planVersion, command.expectedPlanVersion)) throw new DomainError('VERSION_CONFLICT', '奶基版本已变化', 409); if (m.status !== 'received') throw new DomainError('INVALID_STATE', `状态 ${m.status} 不能放行`); emit('milk', command.milkId, { type: 'milk.released', milkId: command.milkId, actor, at }); }
      break;

    case 'batch.create': {
      assertRole(actor, 'operator', 'supervisor');
      const c = state.cultures[command.cultureId], m = state.milks[command.milkId];
      if (!c) throw new DomainError('NOT_FOUND', '菌种不存在', 404);
      if (!m) throw new DomainError('NOT_FOUND', '奶基不存在', 404);
      if (c.status !== 'released') throw new DomainError('CULTURE_NOT_RELEASED', '只能用 released 菌种建批', 409);
      if (m.status !== 'released') throw new DomainError('MILK_NOT_RELEASED', '只能用 released 奶基建批', 409);
      if (state.batches[command.batchId]) throw new DomainError('EXISTS', '批次已存在', 409);
      if (command.evidenceRequirements.some((r) => r.startSeq < 1 || r.minCount < 1)) throw new DomainError('BAD_EVIDENCE_WINDOW', '证据起始序号和最少数量必须为正整数');
      const reqs = new Map(command.evidenceRequirements.map((r) => [r.sourceId, { startSeq: r.startSeq, minCount: r.minCount }]));
      emit('batch', command.batchId, { type: 'batch.created', batchId: command.batchId, label: command.label, cultureId: command.cultureId, culturePlanVersion: c.planVersion, milkId: command.milkId, evidenceRequirements: [...reqs].map(([sourceId, window]) => ({ sourceId, ...window })), actor, at });
      emit('milk', command.milkId, { type: 'milk.consumed', milkId: command.milkId, batchId: command.batchId, actor, at });
      break;
    }

    case 'inoculation.confirm': {
      assertRole(actor, 'operator', 'quality');
      const b = state.batches[command.batchId];
      if (!b) throw new DomainError('NOT_FOUND', '批次不存在', 404);
      if (b.status !== 'created') throw new DomainError('INVALID_STATE', `批次 ${b.status}，不能补充接种确认`);
      if (b.confirmations.some((c) => c.confirmationId === command.confirmationId)) throw new DomainError('DUPLICATE_CONFIRMATION', '确认事实已同步', 409);
      if (b.confirmations.some((c) => c.valid && c.confirmationId !== command.confirmationId && c.userId === actor.userId)) {
        const recEvents = openReconciliation(b, 'confirmation_mismatch', '同一账号连续点击不能作为第二人接种确认；必须切换到另一个合格账号。', { command: { type: command.type, confirmationId: command.confirmationId, userId: actor.userId, cultureId: command.cultureId, culturePlanVersion: command.culturePlanVersion, batchPlanVersion: command.batchPlanVersion, observedAt: command.observedAt, ticketId: command.ticketId }, reason: 'same_account' }, actor, at);
        for (const e of recEvents) { events.push(e); state = reduce(state, e); }
        const conflict = new DomainError('PENDING_RECONCILIATION', '同一账号重复点击已进入待协调，不能冒充双签。', 409);
        (conflict as DomainError & { blockEvents?: StoredEvent[] }).blockEvents = recEvents;
        throw conflict;
      }

      const mismatches: string[] = [];
      if (command.cultureId !== b.cultureId) mismatches.push('culture_id');
      if (command.batchPlanVersion !== b.planVersion) mismatches.push('batch_version');
      const culture = state.cultures[command.cultureId] ?? state.cultures[b.cultureId];
      if (!culture || command.culturePlanVersion !== culture.planVersion) mismatches.push('culture_version');
      if (mismatches.length) {
        const recEvents = openReconciliation(b, 'confirmation_mismatch', `接种确认与当前批次/菌种不一致: ${mismatches.join(', ')}`, { command: { type: command.type, confirmationId: command.confirmationId, userId: actor.userId, cultureId: command.cultureId, culturePlanVersion: command.culturePlanVersion, batchPlanVersion: command.batchPlanVersion, observedAt: command.observedAt, ticketId: command.ticketId }, current: { cultureId: b.cultureId, batchPlanVersion: b.planVersion, culturePlanVersion: culture?.planVersion } }, actor, at);
        for (const e of recEvents) { events.push(e); state = reduce(state, e); }
        const conflict = new DomainError('PENDING_RECONCILIATION', '确认与当前版本冲突，已进入待协调。', 409);
        (conflict as DomainError & { blockEvents?: StoredEvent[] }).blockEvents = recEvents;
        throw conflict;
      }

      emit('batch', command.batchId, {
        type: 'inoculation.confirmed', actor, at, batchId: command.batchId,
        confirmation: {
          confirmationId: command.confirmationId, userId: actor.userId, userName: actor.name, roles: actor.roles,
          cultureId: command.cultureId, culturePlanVersion: command.culturePlanVersion, batchPlanVersion: command.batchPlanVersion,
          observedAt: command.observedAt, ticketId: command.ticketId,
        },
      });
      break;
    }

    case 'inoculation.issue': {
      assertRole(actor, 'quality', 'supervisor');
      const b = state.batches[command.batchId];
      if (!b) throw new DomainError('NOT_FOUND', '批次不存在', 404);
      assertOpen(b.reconciliation);
      const reasons = issueReasons(state, b, readings, true);
      if (reasons.length) {
        const stored = wrap('batch', command.batchId, { type: 'inoculation.issue_rejected', batchId: command.batchId, reasons, actor, at }, state)[0]!;
        const blocked = new DomainError('INOCULATION_BLOCKED', reasons.join('；'), 409);
        (blocked as DomainError & { blockEvents?: StoredEvent[] }).blockEvents = [stored];
        throw blocked;
      }
      emit('batch', command.batchId, { type: 'inoculation.issued', batchId: command.batchId, actor, at, observedAt: command.observedAt ?? at });
      break;
    }

    case 'cooling.start': {
      assertRole(actor, 'operator');
      const b = state.batches[command.batchId];
      if (!b) throw new DomainError('NOT_FOUND', '批次不存在', 404);
      assertOpen(b.reconciliation);
      if (command.expectedPlanVersion !== undefined && command.expectedPlanVersion !== b.planVersion) throw new DomainError('VERSION_CONFLICT', '批次版本已变化', 409);
      if (b.status !== 'inoculated' || b.cooling !== 'not_started') throw new DomainError('INVALID_STATE', `接种已签发且未冷却时才能启动冷却，当前 ${b.status}/${b.cooling}`);
      emit('batch', command.batchId, { type: 'cooling.started', batchId: command.batchId, actor, at, observedAt: command.observedAt ?? at });
      break;
    }
    case 'cooling.complete': {
      assertRole(actor, 'operator', 'quality');
      const b = state.batches[command.batchId];
      if (!b) throw new DomainError('NOT_FOUND', '批次不存在', 404);
      assertOpen(b.reconciliation);
      if (!planVersionOkay(b.planVersion, command.expectedPlanVersion)) throw new DomainError('VERSION_CONFLICT', '批次版本已变化', 409);
      if (b.cooling !== 'started') throw new DomainError('INVALID_STATE', '冷却进行中才能完成');
      if (!Number.isFinite(command.actualTemperatureC)) throw new DomainError('BAD_READING', '终温必须是数字');
      emit('batch', command.batchId, { type: 'cooling.completed', batchId: command.batchId, actualTemperatureC: command.actualTemperatureC, actor, at, observedAt: command.observedAt ?? at });
      break;
    }
    case 'filling.start': {
      assertRole(actor, 'operator');
      const b = state.batches[command.batchId];
      if (!b) throw new DomainError('NOT_FOUND', '批次不存在', 404);
      assertOpen(b.reconciliation);
      if (!planVersionOkay(b.planVersion, command.expectedPlanVersion)) throw new DomainError('VERSION_CONFLICT', '批次版本已变化', 409);
      if (b.status !== 'cooled' || b.filling !== 'not_started') throw new DomainError('INVALID_STATE', '冷却完成后才能开始灌装');
      emit('batch', command.batchId, { type: 'filling.started', batchId: command.batchId, actor, at, observedAt: command.observedAt ?? at });
      break;
    }
    case 'filling.complete': {
      assertRole(actor, 'operator', 'quality');
      const b = state.batches[command.batchId];
      if (!b) throw new DomainError('NOT_FOUND', '批次不存在', 404);
      assertOpen(b.reconciliation);
      if (!planVersionOkay(b.planVersion, command.expectedPlanVersion)) throw new DomainError('VERSION_CONFLICT', '批次版本已变化', 409);
      if (b.status !== 'cooled' || !['not_started'].includes(b.filling)) throw new DomainError('INVALID_STATE', '未进入灌装或已完成');
      if (!Number.isInteger(command.packages) || command.packages < 0) throw new DomainError('BAD_VALUE', '灌装件数必须是非负整数');
      emit('batch', command.batchId, { type: 'filling.completed', batchId: command.batchId, packages: command.packages, actor, at, observedAt: command.observedAt ?? at });
      break;
    }
    case 'batch.abort': {
      assertRole(actor, 'quality', 'supervisor');
      const b = state.batches[command.batchId];
      if (!b) throw new DomainError('NOT_FOUND', '批次不存在', 404);
      if (b.status === 'filled' || b.status === 'aborted') throw new DomainError('INVALID_STATE', '终态批次不能中止');
      emit('batch', command.batchId, { type: 'batch.aborted', batchId: command.batchId, reason: command.reason, actor, at, observedAt: command.observedAt ?? at });
      break;
    }
    case 'reconciliation.resolve': {
      assertRole(actor, 'supervisor');
      const b = state.batches[command.batchId];
      if (!b) throw new DomainError('NOT_FOUND', '批次不存在', 404);
      const r = b.reconciliation.find((x) => x.id === command.reconciliationId);
      if (!r) throw new DomainError('NOT_FOUND', '待协调项不存在', 404);
      if (r.status !== 'open') throw new DomainError('ALREADY_RESOLVED', '该冲突已解决');
      emit('batch', command.batchId, { type: 'reconciliation.resolved', batchId: command.batchId, reconciliationId: command.reconciliationId, resolution: command.resolution, actor, at, observedAt: command.observedAt ?? at });
      break;
    }
  }
  return { events, state };
}


export function decideOrReject(root: RootState, command: Command, actor: AuthContext, readings: Reading[] = [], at = nowIso()) {
  try {
    return decide(root, command, actor, readings, at);
  } catch (error) {
    const blockEvents = (error as DomainError & { blockEvents?: StoredEvent[] }).blockEvents;
    if (blockEvents) {
      const state = blockEvents.reduce((current, e) => reduce(current, e), root);
      return { events: blockEvents, state, rejection: error as DomainError };
    }
    throw error;
  }
}
