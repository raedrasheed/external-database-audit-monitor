// Native audit-plugin state watch (Epic E3 / EDAM-T020).
//
// Watches whether the native DB audit feed is loaded and actively logging.
// CDC tells us WHAT changed; the audit feed enables WHO/HOW attribution (CCE
// §7). If audit logging is disabled, attribution must later be capped to
// `unattributed` (E4) — here we positively detect it, emit an AUDIT_TAMPER
// alarm, and record the AUDIT_PLUGIN_DISABLED tamper indicator (DB-Audit Event
// contract vocabulary). INV-2: when state is unreadable we do NOT claim the
// plugin is disabled — we mark it unreadable and alarm.
//
// Dev stand-in: MySQL general_log; production uses MySQL Enterprise Audit /
// MariaDB Audit Plugin (server_audit) / Percona / cloud audit logs.

import type { Engine } from '../engine.js';
import type { AlarmSink } from '../alarms.js';
import type { Clock } from '../clock.js';
import type { SqlReader } from './types.js';

export interface AuditPluginState {
  engine: Engine;
  checked_at: string;
  /** false when the state could not be read (state unknown, not "off"). */
  readable: boolean;
  loaded: boolean;
  logging_active: boolean;
  source: 'plugin' | 'general_log' | 'unknown';
  plugin_name: string | null;
  /** Subset of the DB-Audit Event tamper-indicator vocabulary. */
  tamper_indicators: string[];
}

export interface AuditPluginWatcherDeps {
  engine: Engine;
  dbId: string;
  sql: SqlReader;
  alarms: AlarmSink;
  clock: Clock;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

export class AuditPluginWatcher {
  constructor(private readonly deps: AuditPluginWatcherDeps) {}

  async check(): Promise<AuditPluginState> {
    const checked_at = this.deps.clock.now();
    try {
      const vars = await this.deps.sql.query(
        "SHOW GLOBAL VARIABLES WHERE Variable_name IN ('general_log','server_audit_logging')",
      );
      const plugins = await this.deps.sql.query(
        "SELECT PLUGIN_NAME, PLUGIN_STATUS FROM information_schema.plugins WHERE PLUGIN_NAME LIKE '%AUDIT%'",
      );

      const varMap = new Map<string, string>();
      for (const r of vars) varMap.set(str(r.Variable_name ?? r.variable_name).toLowerCase(), str(r.Value ?? r.value).toUpperCase());

      const activePlugin = plugins.find(
        (p) => /AUDIT/i.test(str(p.PLUGIN_NAME ?? p.plugin_name)) &&
          str(p.PLUGIN_STATUS ?? p.plugin_status).toUpperCase() === 'ACTIVE',
      );
      const pluginActive = !!activePlugin;
      const varActive = varMap.get('general_log') === 'ON' || varMap.get('server_audit_logging') === 'ON';
      const logging_active = pluginActive || varActive;

      const source: AuditPluginState['source'] = pluginActive ? 'plugin' : varActive ? 'general_log' : 'unknown';
      const plugin_name = activePlugin ? str(activePlugin.PLUGIN_NAME ?? activePlugin.plugin_name) : null;

      const tamper_indicators: string[] = [];
      if (!logging_active) {
        tamper_indicators.push('AUDIT_PLUGIN_DISABLED');
        this.deps.alarms.raise({
          kind: 'AUDIT_TAMPER',
          severity: 'high',
          message: 'native audit logging is not active: attribution will be capped to unattributed',
          at: checked_at,
          details: { db_id: this.deps.dbId, engine: this.deps.engine },
        });
      }

      return {
        engine: this.deps.engine,
        checked_at,
        readable: true,
        loaded: pluginActive || varActive,
        logging_active,
        source,
        plugin_name,
        tamper_indicators,
      };
    } catch (err) {
      // INV-2: unreadable => unknown, NOT a positive "disabled" claim.
      this.deps.alarms.raise({
        kind: 'AUDIT_TAMPER',
        severity: 'medium',
        message: `native audit state could not be read: ${String((err as Error).message ?? err)}`,
        at: checked_at,
        details: { db_id: this.deps.dbId, engine: this.deps.engine },
      });
      return {
        engine: this.deps.engine,
        checked_at,
        readable: false,
        loaded: false,
        logging_active: false,
        source: 'unknown',
        plugin_name: null,
        tamper_indicators: [],
      };
    }
  }
}
