// Attestation Monitor (Epic E3 / EDAM-T019).
// Periodically: read source config (read-only) -> assess fidelity -> emit a
// config_snapshot + any downgrade alarms. On read failure it emits DEGRADED
// (never fabricates HEALTHY; INV-2).

import type { Engine } from '../engine.js';
import type { AlarmSink } from '../alarms.js';
import type { Clock } from '../clock.js';
import type { AttestationOptions, SourceConfig, SourceConfigReader } from './types.js';
import { assessFidelity } from './assess.js';
import {
  buildConfigSnapshot,
  type ConfigSnapshot,
  type ConfigSnapshotSink,
  type FidelityAssessment,
} from './snapshot.js';

export interface AttestationMonitorDeps {
  engine: Engine;
  dbId: string;
  reader: SourceConfigReader;
  sink: ConfigSnapshotSink;
  alarms: AlarmSink;
  clock: Clock;
  options: AttestationOptions;
}

function nullConfig(engine: Engine): SourceConfig {
  return {
    engine,
    log_bin: null,
    binlog_format: null,
    binlog_row_image: null,
    gtid_mode: null,
    gtid_strict_mode: null,
    binlog_expire_logs_seconds: null,
    server_uuid: null,
  };
}

export class AttestationMonitor {
  constructor(private readonly deps: AttestationMonitorDeps) {}

  /** Take one sample; returns the emitted snapshot. */
  async sample(): Promise<ConfigSnapshot> {
    const sampledAt = this.deps.clock.now();

    let config: SourceConfig;
    try {
      config = await this.deps.reader.read();
    } catch (err) {
      // INV-2: cannot read config => DEGRADED, never HEALTHY.
      const reason = `source configuration could not be read: ${String((err as Error).message ?? err)}`;
      const assessment: FidelityAssessment = { state: 'DEGRADED', degraded_reason: reason, notes: [reason] };
      this.deps.alarms.raise({
        kind: 'FIDELITY_DEGRADED',
        severity: 'high',
        message: reason,
        at: sampledAt,
        details: { db_id: this.deps.dbId },
      });
      const snap = buildConfigSnapshot(this.deps.dbId, nullConfig(this.deps.engine), assessment, sampledAt);
      await this.deps.sink.emit(snap);
      return snap;
    }

    const { assessment, alarms } = assessFidelity(config, this.deps.options);
    for (const a of alarms) {
      this.deps.alarms.raise({ ...a, at: sampledAt, details: { ...a.details, db_id: this.deps.dbId } });
    }
    const snap = buildConfigSnapshot(this.deps.dbId, config, assessment, sampledAt);
    await this.deps.sink.emit(snap);
    return snap;
  }
}
