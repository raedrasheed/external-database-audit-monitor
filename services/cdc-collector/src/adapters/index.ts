// Adapter registry (Epic E2 / EDAM-T016). One interface, distinct adapters.

import type { Engine, EngineAdapter } from './types.js';
import { mysqlAdapter } from './mysql.js';
import { mariadbAdapter } from './mariadb.js';

const REGISTRY: Record<Engine, EngineAdapter> = {
  mysql: mysqlAdapter,
  mariadb: mariadbAdapter,
};

export function getAdapter(engine: Engine): EngineAdapter {
  const adapter = REGISTRY[engine];
  if (!adapter) throw new Error(`no CDC adapter registered for engine: ${engine}`);
  return adapter;
}

export { mysqlAdapter } from './mysql.js';
export { mariadbAdapter } from './mariadb.js';
export type {
  EngineAdapter,
  Engine,
  RawSourceEvent,
  SourceMeta,
  OffsetMeta,
  SnapshotPhase,
  DebeziumConfigOptions,
} from './types.js';
