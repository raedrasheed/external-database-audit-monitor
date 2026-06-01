// Sample Debezium MySQL/MariaDB sink events for adapter/collector tests (E2).
import type { RawSourceEvent } from '../../src/adapters/types.js';

/** MySQL streaming UPDATE on kafel.donations. */
export const mysqlUpdate: RawSourceEvent = {
  topic: 'kafel.kafel.donations',
  streamId: '1700000000000-0',
  value: {
    op: 'u',
    ts_ms: 1748773351114,
    before: { id: 90211, amount: '100.00', status: 'approved' },
    after: { id: 90211, amount: '100000.00', status: 'approved' },
    source: {
      version: '2.7.3.Final',
      connector: 'mysql',
      name: 'kafel',
      ts_ms: 1748773351000,
      snapshot: 'false',
      db: 'kafel',
      table: 'donations',
      server_id: 223344,
      gtid: '3E11FA47-71CA-11E1-9E33-C80AA9429562:152',
      file: 'mysql-bin.000042',
      pos: 99812,
      row: 0,
      thread: 338217,
    },
  },
};

/** MySQL snapshot READ event (op = 'r', snapshot = true). */
export const mysqlSnapshotRead: RawSourceEvent = {
  topic: 'kafel.kafel.donations',
  streamId: '1700000000001-0',
  value: {
    op: 'r',
    ts_ms: 1748773300000,
    before: null,
    after: { id: 90212, amount: '250.00', status: 'approved' },
    source: {
      connector: 'mysql',
      db: 'kafel',
      table: 'donations',
      snapshot: 'true',
      server_id: 223344,
      file: 'mysql-bin.000042',
      pos: 4,
    },
  },
};

/** MySQL last snapshot event (snapshot = 'last') -> handoff. */
export const mysqlSnapshotLast: RawSourceEvent = {
  ...mysqlSnapshotRead,
  streamId: '1700000000002-0',
  value: {
    ...(mysqlSnapshotRead.value as any),
    source: { ...(mysqlSnapshotRead.value as any).source, snapshot: 'last' },
  },
};

/** Debezium heartbeat event. */
export const heartbeat: RawSourceEvent = {
  topic: '__debezium-heartbeat.kafel',
  streamId: '1700000000003-0',
  value: { ts_ms: 1748773360000 },
};

/** Schema-wrapped value (schemas.enable=true) to test unwrapping. */
export const mysqlWrapped: RawSourceEvent = {
  topic: 'kafel.kafel.wallets',
  streamId: '1700000000004-0',
  value: {
    schema: { type: 'struct', fields: [] },
    payload: {
      op: 'u',
      ts_ms: 1748800000000,
      before: { id: 4412, balance: '250.00' },
      after: { id: 4412, balance: '9250.00' },
      source: {
        connector: 'mysql',
        db: 'kafel',
        table: 'wallets',
        snapshot: 'false',
        gtid: '3E11FA47-71CA-11E1-9E33-C80AA9429562:153',
        file: 'mysql-bin.000042',
        pos: 101244,
      },
    },
  },
};

/** MariaDB streaming UPDATE (MariaDB-format GTID domain-server-seq). */
export const mariadbUpdate: RawSourceEvent = {
  topic: 'kafel.kafel.donations',
  streamId: '1700000000005-0',
  value: {
    op: 'u',
    ts_ms: 1748773351114,
    before: { id: 90211, amount: '100.00', status: 'approved' },
    after: { id: 90211, amount: '100000.00', status: 'approved' },
    source: {
      connector: 'mariadb',
      db: 'kafel',
      table: 'donations',
      snapshot: 'false',
      server_id: 223355,
      gtid: '0-223355-1052',
      file: 'maria-bin.000007',
      pos: 4120,
    },
  },
};
