import pg from 'pg';
import { ClockAnchor, Device, OfflineTicket, Reading, RootState, StoredEvent, User } from './types.js';
import { replay } from './domain.js';
import { Store } from './store.js';

type EventRow = { event_id: string; stream_type: 'batch'|'culture'|'milk'; stream_id: string; revision: number; plan_version: number; payload: any };

export class PgStore implements Store {
  pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }
  async close() { await this.pool.end(); }

  private mapEvent(r: EventRow): StoredEvent {
    return { eventId: r.event_id, streamType: r.stream_type, streamId: r.stream_id, revision: Number(r.revision), planVersion: Number(r.plan_version), event: r.payload };
  }
  async getState(): Promise<RootState> {
    const { rows } = await this.pool.query<EventRow>('select * from domain_events order by server_recorded_at, event_id');
    return replay(rows.map((r) => this.mapEvent(r)));
  }
  async commit(events: StoredEvent[]) {
    if (!events.length) return events;
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (const e of events) {
        await client.query(
          `insert into domain_events(event_id,stream_type,stream_id,revision,plan_version,payload)
           values ($1,$2,$3,$4,$5,$6)`,
          [e.eventId, e.streamType, e.streamId, e.revision, e.planVersion, JSON.stringify(e.event)]
        ).catch((err: any & { code?: string }) => {
          if (err.code === '23505') { err.code = 'VERSION_CONFLICT'; err.statusCode = 409; err.message = '事件流版本冲突'; }
          throw err;
        });
      }
      await client.query('commit');
      return events;
    } catch (err) { await client.query('rollback').catch(() => undefined); throw err; }
    finally { client.release(); }
  }
  async transact<T = unknown>(fn: (state: RootState) => { events: StoredEvent[]; result?: T; rejection?: unknown }) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query<EventRow>('select * from domain_events for update of domain_events');
      const state = replay(rows.map((r) => this.mapEvent(r)).sort((a, b) => a.revision - b.revision || a.eventId.localeCompare(b.eventId)));
      const produced = fn(state);
      for (const e of produced.events) {
        await client.query(
          `insert into domain_events(event_id,stream_type,stream_id,revision,plan_version,payload)
           values ($1,$2,$3,$4,$5,$6)`,
          [e.eventId, e.streamType, e.streamId, e.revision, e.planVersion, JSON.stringify(e.event)]
        ).catch((err: any & { code?: string }) => {
          if (err.code === '23505') { err.code = 'VERSION_CONFLICT'; err.statusCode = 409; err.message = '事件流版本冲突'; }
          throw err;
        });
      }
      await client.query('commit');
      return { events: produced.events, state: await this.getState(), result: produced.result, rejection: produced.rejection };
    } catch (err) { await client.query('rollback').catch(() => undefined); throw err; }
    finally { client.release(); }
  }
  async addReading(input: Omit<Reading, 'receivedAt'>) {
    try {
      const { rows } = await this.pool.query<Reading & { received_at: string }>(
        `insert into readings(reading_id,source_id,source_kind,batch_id,seq,value,observed_at,calibration_anchor_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         returning *`,
        [input.readingId, input.sourceId, input.sourceKind, input.batchId, input.seq, input.value, input.observedAt, input.calibrationAnchorId ?? null]
      );
      return { reading: { ...input, receivedAt: mapDate(rows[0].received_at) }, duplicate: false };
    } catch (err: any) {
      if (err.code === '23505') return { duplicate: true };
      throw err;
    }
  }
  async addAnchor(input: Omit<ClockAnchor, 'receivedAt'>) {
    try {
      await this.pool.query(
        `insert into clock_anchors(anchor_id,source_id,seq,device_time,reference_time,drift_ms)
         values ($1,$2,$3,$4,$5,$6)`,
        [input.anchorId, input.sourceId, input.seq, input.deviceTime, input.referenceTime, input.driftMs]
      );
      return { anchor: { ...input, receivedAt: mapDate((await this.pool.query('select received_at from clock_anchors where anchor_id=$1',[input.anchorId])).rows[0].received_at) }, duplicate: false };
    } catch (err: any) {
      if (err.code === '23505') return { duplicate: true };
      throw err;
    }
  }
  async getReadings(batchId?: string) {
    const { rows } = await this.pool.query<any>(`select * from readings ${batchId ? 'where batch_id=$1' : ''} order by source_id,seq`, [batchId].filter(Boolean));
    return rows.map((r: unknown) => mapReading(r));
  }
  async getAnchors(sourceId?: string) {
    const { rows } = await this.pool.query<any>(`select * from clock_anchors ${sourceId ? 'where source_id=$1' : ''} order by source_id,seq`, [sourceId].filter(Boolean));
    return rows.map((r: unknown) => mapAnchor(r));
  }
  async issueTicket(input: Omit<OfflineTicket, 'issuedAt'|'revoked'>) {
    const t: OfflineTicket = { ...input, issuedAt: new Date().toISOString(), revoked: false };
    await this.pool.query(`insert into offline_tickets(ticket_id,user_id,secret,expires_at,revoked) values ($1,$2,$3,$4,false)`,
      [t.ticketId, t.userId, t.secret, t.expiresAt]);
    return t;
  }
  async getTicket(ticketId: string) {
    const { rows } = await this.pool.query<any>('select * from offline_tickets where ticket_id=$1', [ticketId]);
    return rows[0] ? { ticketId: rows[0].ticket_id, userId: rows[0].user_id, secret: rows[0].secret, issuedAt: iso(rows[0].issued_at), expiresAt: iso(rows[0].expires_at), revoked: rows[0].revoked } : undefined;
  }
  async revokeTicket(ticketId: string) { await this.pool.query('update offline_tickets set revoked=true where ticket_id=$1', [ticketId]); }
}

function iso(x: unknown) { return x instanceof Date ? x.toISOString() : String(x); }
function mapDate(x: unknown) { return iso(x); }
export function mapReading(r: any): Reading {
  return { readingId: r.reading_id, sourceId: r.source_id, sourceKind: r.source_kind, batchId: r.batch_id, seq: Number(r.seq), value: Number(r.value), observedAt: iso(r.observed_at), receivedAt: iso(r.received_at), calibrationAnchorId: r.calibration_anchor_id ?? undefined };
}
export function mapAnchor(r: any): ClockAnchor {
  return { anchorId: r.anchor_id, sourceId: r.source_id, seq: Number(r.seq), deviceTime: iso(r.device_time), referenceTime: iso(r.reference_time), driftMs: Number(r.drift_ms), receivedAt: iso(r.received_at) };
}

export async function loadUsersAndDevices(pool: pg.Pool): Promise<{ users: User[]; devices: Device[] }> {
  const [u, d] = await Promise.all([pool.query<any>('select * from users'), pool.query<any>('select * from devices')]);
  return {
    users: u.rows.map((r:any) => ({ id: r.id, name: r.name, roles: r.roles, token: r.token })),
    devices: d.rows.map((r:any) => ({ id: r.id, name: r.name, kind: r.source_kind, ingestToken: r.ingest_token, active: r.active })),
  };
}
