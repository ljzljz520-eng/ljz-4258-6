import { ClockAnchor, Device, DomainEvent, OfflineTicket, Reading, RootState, StoredEvent, StreamType, User } from './types.js';
import { replay } from './domain.js';

export interface CommitResult { events: StoredEvent[]; state: RootState; result?: unknown }
export interface Store {
  getState(): RootState | Promise<RootState>;
  commit(events: StoredEvent[]): Promise<StoredEvent[]>;
  transact<T = unknown>(fn: (state: RootState) => { events: StoredEvent[]; result?: T; rejection?: unknown }): Promise<{ events: StoredEvent[]; state: RootState; result?: T; rejection?: unknown }>;
  addReading(input: Omit<Reading, 'receivedAt'>): Promise<{ reading?: Reading; duplicate: boolean }>;
  addAnchor(input: Omit<ClockAnchor, 'receivedAt'>): Promise<{ anchor?: ClockAnchor; duplicate: boolean }>;
  getReadings(batchId?: string): Promise<Reading[]>;
  getAnchors(sourceId?: string): Promise<ClockAnchor[]>;
  issueTicket(input: Omit<OfflineTicket, 'issuedAt' | 'revoked'>): Promise<OfflineTicket>;
  getTicket(ticketId: string): Promise<OfflineTicket | undefined>;
  revokeTicket(ticketId: string): Promise<void>;
  close?(): Promise<void>;
}

export class MemoryStore implements Store {
  events: StoredEvent[] = [];
  readings: Reading[] = [];
  anchors: ClockAnchor[] = [];
  tickets: OfflineTicket[] = [];
  users: User[];
  devices: Device[];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(users: User[] = [], devices: Device[] = []) {
    this.users = users;
    this.devices = devices;
  }
  getState() { return replay(this.events); }
  async commit(events: StoredEvent[]) {
    for (const e of events) {
      if (this.events.some((x) => x.streamType === e.streamType && x.streamId === e.streamId && x.revision === e.revision)) {
        throw Object.assign(new Error('STREAM_REVISION_CONFLICT'), { code: 'VERSION_CONFLICT', statusCode: 409 });
      }
      this.events.push(e);
    }
    return events;
  }
  async transact<T = unknown>(fn: (state: RootState) => { events: StoredEvent[]; result?: T; rejection?: unknown }) {
    const run = this.chain.then(async () => {
      const state = this.getState();
      const produced = fn(state);
      await this.commit(produced.events);
      return { events: produced.events, state: this.getState(), result: produced.result, rejection: produced.rejection };
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
  async addReading(input: Omit<Reading, 'receivedAt'>) {
    const duplicate = this.readings.some((r) => r.sourceId === input.sourceId && r.seq === input.seq);
    if (duplicate) return { duplicate: true };
    const reading: Reading = { ...input, receivedAt: new Date().toISOString() };
    this.readings.push(reading);
    return { reading, duplicate: false };
  }
  async addAnchor(input: Omit<ClockAnchor, 'receivedAt'>) {
    const duplicate = this.anchors.some((a) => a.sourceId === input.sourceId && a.seq === input.seq);
    if (duplicate) return { duplicate: true };
    const anchor: ClockAnchor = { ...input, receivedAt: new Date().toISOString() };
    this.anchors.push(anchor);
    return { anchor, duplicate: false };
  }
  async getReadings(batchId?: string) { return this.readings.filter((r) => !batchId || r.batchId === batchId); }
  async getAnchors(sourceId?: string) { return this.anchors.filter((a) => !sourceId || a.sourceId === sourceId); }
  async issueTicket(input: Omit<OfflineTicket, 'issuedAt' | 'revoked'>) {
    const t: OfflineTicket = { ...input, issuedAt: new Date().toISOString(), revoked: false };
    this.tickets.push(t);
    return t;
  }
  async getTicket(ticketId: string) { return this.tickets.find((t) => t.ticketId === ticketId); }
  async revokeTicket(ticketId: string) { const t = await this.getTicket(ticketId); if (t) t.revoked = true; }
}

export function eventUnique(streamType: StreamType, streamId: string, revision: number, events: StoredEvent[]) {
  return !events.some((e) => e.streamType === streamType && e.streamId === streamId && e.revision === revision);
}
export type { DomainEvent };
