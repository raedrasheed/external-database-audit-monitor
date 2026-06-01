// Attribution correlation (Epic E4 / EDAM-T034).
//
// CDC tells us WHAT changed; native DB-audit events tell us WHO/HOW (CCE §7).
// We correlate a transaction with candidate audit events by hard key
// (connection_id / thread / gtid) -> exact, else time-window + table -> probable,
// else -> unattributed. INV-2: NO match, ambiguity, or a disabled-audit tamper
// indicator yields `unattributed` — identity is never fabricated.

import type { NormalizedActor } from '@edam/cce-model';

export interface DbAuditEventLike {
  audit_event_id: string;
  db_user?: string | null;
  client_host?: string | null;
  connection_id?: string | null;
  thread_id?: string | null;
  application_name?: string | null;
  event_ts: string;
  objects?: Array<{ schema: string; name: string }>;
  gtid?: string | null;
  tamper_indicators?: string[];
}

export interface CorrelationQuery {
  dbId: string;
  commitTs: string;
  tables: string[];
  windowMs?: number;
  connectionId?: string | null;
  threadId?: string | null;
  gtid?: string | null;
}

/** Audit source the normalizer queries for candidates near a transaction. */
export interface AuditEventSource {
  candidates(query: CorrelationQuery): DbAuditEventLike[];
}

const UNATTRIBUTED: NormalizedActor = { attribution_confidence: 'unattributed' };

function actorFrom(c: DbAuditEventLike, confidence: 'exact' | 'probable', basis: string[]): NormalizedActor {
  return {
    db_user: c.db_user ?? null,
    client_host: c.client_host ?? null,
    connection_id: c.connection_id ?? null,
    application_name: c.application_name ?? null,
    attribution_confidence: confidence,
    audit_event_ref: c.audit_event_id,
    correlation_basis: basis,
  };
}

export function correlateActor(query: CorrelationQuery, candidates: DbAuditEventLike[]): NormalizedActor {
  // A disabled/tampered audit feed means we cannot attribute (INV-2).
  if (candidates.some((c) => (c.tamper_indicators ?? []).includes('AUDIT_PLUGIN_DISABLED'))) {
    return UNATTRIBUTED;
  }

  const windowMs = query.windowMs ?? 5000;
  const commitMs = Date.parse(query.commitTs);
  const tables = new Set(query.tables);

  const inWindow = candidates.filter((c) => {
    const ts = Date.parse(c.event_ts);
    if (!Number.isFinite(ts) || Math.abs(ts - commitMs) > windowMs) return false;
    if (c.objects && c.objects.length > 0) {
      return c.objects.some((o) => tables.has(o.name));
    }
    return true;
  });

  // Hard-key match (connection_id / thread / gtid) with a single candidate -> exact.
  if (query.connectionId || query.threadId || query.gtid) {
    const keyed = inWindow.filter(
      (c) =>
        (query.connectionId != null && c.connection_id === query.connectionId) ||
        (query.threadId != null && c.thread_id === query.threadId) ||
        (query.gtid != null && c.gtid === query.gtid),
    );
    if (keyed.length === 1) {
      return actorFrom(keyed[0]!, 'exact', ['connection_id', 'gtid', 'time_window'].filter(Boolean));
    }
  }

  // Single time-window + table candidate -> probable. Anything else -> unattributed.
  if (inWindow.length === 1) {
    return actorFrom(inWindow[0]!, 'probable', ['time_window', 'table']);
  }
  return UNATTRIBUTED;
}
