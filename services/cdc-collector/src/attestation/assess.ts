// Fidelity assessment from sampled source config (Epic E3 / EDAM-T019).
//
// Detects downgrade conditions and produces the fidelity state + alarms.
// INV-2: HEALTHY is returned ONLY when every audit-critical setting is read AND
// correct. Unreadable settings -> DEGRADED (cannot confirm), never HEALTHY.
// Fidelity state machine (CCE §6.4 / EDAM v2 §4.3): HEALTHY -> DEGRADED ->
// COMPROMISED (confirmed capture loss, e.g. binary logging disabled).

import type { Alarm, AlarmKind, AlarmSeverity } from '../alarms.js';
import type { AttestationOptions, FidelityState, SourceConfig } from './types.js';
import type { FidelityAssessment } from './snapshot.js';

export type AlarmDescriptor = Omit<Alarm, 'at'>;

export interface AssessResult {
  assessment: FidelityAssessment;
  alarms: AlarmDescriptor[];
}

const RANK: Record<FidelityState, number> = { HEALTHY: 0, DEGRADED: 1, COMPROMISED: 2 };

export function assessFidelity(config: SourceConfig, opts: AttestationOptions): AssessResult {
  let state: FidelityState = 'HEALTHY';
  const notes: string[] = [];
  const alarms: AlarmDescriptor[] = [];

  const worsen = (to: FidelityState): void => {
    if (RANK[to] > RANK[state]) state = to;
  };
  const flag = (
    to: FidelityState,
    severity: AlarmSeverity,
    kind: AlarmKind,
    reason: string,
    details?: Record<string, unknown>,
  ): void => {
    worsen(to);
    notes.push(reason);
    alarms.push({ kind, severity, message: reason, details: { ...details, db: config.engine } });
  };

  // log_bin: OFF => no capture at all (confirmed loss). null => cannot confirm.
  if (config.log_bin === 'OFF') {
    flag('COMPROMISED', 'critical', 'CONFIG_DOWNGRADE', 'log_bin is OFF: binary logging disabled — no change capture');
  } else if (config.log_bin === null) {
    flag('DEGRADED', 'high', 'FIDELITY_DEGRADED', 'log_bin could not be read: capture cannot be confirmed');
  }

  // binlog_format must be ROW.
  if (config.binlog_format !== null && config.binlog_format !== 'ROW') {
    flag('DEGRADED', 'critical', 'CONFIG_DOWNGRADE',
      `binlog_format is ${config.binlog_format} (expected ROW): field-level capture lost`,
      { binlog_format: config.binlog_format });
  } else if (config.binlog_format === null) {
    flag('DEGRADED', 'high', 'FIDELITY_DEGRADED', 'binlog_format could not be read');
  }

  // binlog_row_image must be FULL (the silent-downgrade attack — review C4).
  if (config.binlog_row_image !== null && config.binlog_row_image !== 'FULL') {
    flag('DEGRADED', 'critical', 'CONFIG_DOWNGRADE',
      `binlog_row_image is ${config.binlog_row_image} (expected FULL): before-image lost`,
      { binlog_row_image: config.binlog_row_image });
  } else if (config.binlog_row_image === null) {
    flag('DEGRADED', 'high', 'FIDELITY_DEGRADED', 'binlog_row_image could not be read');
  }

  // GTID: MySQL requires gtid_mode=ON; MariaDB uses inherent GTID + strict mode.
  if (config.engine === 'mysql') {
    if (config.gtid_mode !== null && config.gtid_mode !== 'ON') {
      flag('DEGRADED', 'critical', 'CONFIG_DOWNGRADE',
        `gtid_mode is ${config.gtid_mode} (expected ON): completeness proof impossible`,
        { gtid_mode: config.gtid_mode });
    } else if (config.gtid_mode === null) {
      flag('DEGRADED', 'high', 'FIDELITY_DEGRADED', 'gtid_mode could not be read');
    }
  } else {
    // MariaDB: GTID is inherent when log_bin is ON; recommend gtid_strict_mode.
    if (config.gtid_strict_mode !== null && config.gtid_strict_mode !== 'ON') {
      notes.push('gtid_strict_mode is not ON (recommended for MariaDB GTID continuity)');
    }
  }

  // Binlog retention below threshold risks purge-before-read gaps.
  if (config.binlog_expire_logs_seconds !== null) {
    if (config.binlog_expire_logs_seconds < opts.minBinlogRetentionSeconds) {
      flag('DEGRADED', 'high', 'CONFIG_DOWNGRADE',
        `binlog retention ${config.binlog_expire_logs_seconds}s is below the ${opts.minBinlogRetentionSeconds}s threshold (gap risk)`,
        { retention: config.binlog_expire_logs_seconds, threshold: opts.minBinlogRetentionSeconds });
    }
  } else {
    flag('DEGRADED', 'medium', 'FIDELITY_DEGRADED', 'binlog retention could not be read: sufficiency cannot be confirmed');
  }

  const degraded_reason = state === 'HEALTHY' ? null : notes[0] ?? 'fidelity degraded';
  return { assessment: { state, degraded_reason, notes }, alarms };
}
