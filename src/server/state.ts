import type { Batch, BatchPhase, CoolingState, CultureState, FillingState, MilkBaseState } from '../shared/model';

export class StateError extends Error {
  constructor(public reason: string, message: string) {
    super(message);
  }
}

export function cultureTransition(state: CultureState, target: CultureState) {
  const allowed: Record<CultureState, CultureState[]> = {
    staged: ['released', 'quarantined'],
    released: ['quarantined', 'consumed'],
    quarantined: ['released', 'consumed'],
    consumed: []
  };
  if (!allowed[state].includes(target)) {
    throw new StateError('INVALID_TRANSITION', `菌种不能从 ${state} 转为 ${target}`);
  }
}

export function milkTransition(state: MilkBaseState, target: MilkBaseState) {
  const allowed: Record<MilkBaseState, MilkBaseState[]> = {
    prepared: ['verified', 'rejected'],
    verified: ['consumed', 'rejected'],
    rejected: [],
    consumed: []
  };
  if (!allowed[state].includes(target)) {
    throw new StateError('INVALID_TRANSITION', `奶基不能从 ${state} 转为 ${target}`);
  }
}

export type BatchCommand =
  | 'ready'
  | 'start_cooling'
  | 'complete_cooling'
  | 'start_filling'
  | 'complete_filling';

export function applyBatchCommand(
  batch: Pick<Batch, 'phase' | 'cooling_state' | 'filling_state' | 'inoculation_state'>,
  command: BatchCommand
): Partial<Batch> {
  if (batch.phase === 'reconcile_required') {
    throw new StateError('INVALID_TRANSITION', '批次处于待协调状态，冲突解决前不能授权状态推进');
  }
  switch (command) {
    case 'ready':
      if (batch.phase !== 'draft') throw new StateError('INVALID_TRANSITION', '只有 draft 批次可以准备完成');
      return { phase: 'ready' };
    case 'start_cooling':
      if (batch.phase !== 'inoculated' || batch.cooling_state !== 'warm')
        throw new StateError('INVALID_TRANSITION', '接种签发后才能开始冷却记录');
      return { phase: 'cooling', cooling_state: 'cooling' };
    case 'complete_cooling':
      if (batch.phase !== 'cooling' || batch.cooling_state !== 'cooling')
        throw new StateError('INVALID_TRANSITION', '冷却中才能确认冷却完成');
      return { phase: 'cooled', cooling_state: 'cooled' };
    case 'start_filling':
      if (batch.phase !== 'cooled' || batch.filling_state !== 'not_filled')
        throw new StateError('INVALID_TRANSITION', '冷却完成后才能开始灌装');
      return { phase: 'filling', filling_state: 'filling' };
    case 'complete_filling':
      if (batch.phase !== 'filling' || batch.filling_state !== 'filling')
        throw new StateError('INVALID_TRANSITION', '灌装中才能确认灌装完成');
      return { phase: 'completed', filling_state: 'filled' };
  }
}

export function phaseLabel(phase: BatchPhase) {
  return {
    draft: '草稿',
    ready: '待接种',
    inoculated: '已接种',
    cooling: '冷却中',
    cooled: '冷却完成',
    filling: '灌装中',
    filled: '已灌装',
    reconcile_required: '待协调',
    completed: '已完成'
  }[phase];
}

export function coolingLabel(s: CoolingState) {
  return { warm: '未冷却', cooling: '冷却中', cooled: '冷却完成' }[s];
}

export function fillingLabel(s: FillingState) {
  return { not_filled: '未灌装', filling: '灌装中', filled: '已灌装' }[s];
}
