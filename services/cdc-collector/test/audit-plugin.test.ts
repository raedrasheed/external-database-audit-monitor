// Tests for the native audit-plugin watcher (Epic E3 / EDAM-T020).
import { describe, it, expect } from 'vitest';
import { AuditPluginWatcher } from '../src/attestation/audit.js';
import { InMemoryAlarmSink } from '../src/alarms.js';
import { FakeClock } from '../src/clock.js';
import type { SqlReader } from '../src/attestation/types.js';

function sqlWith(vars: Record<string, string>, plugins: Array<{ name: string; status: string }>): SqlReader {
  return {
    async query(sql: string) {
      if (/information_schema\.plugins/i.test(sql)) {
        return plugins.map((p) => ({ PLUGIN_NAME: p.name, PLUGIN_STATUS: p.status }));
      }
      return Object.entries(vars).map(([Variable_name, Value]) => ({ Variable_name, Value }));
    },
  };
}

function watcher(sql: SqlReader, engine: 'mysql' | 'mariadb' = 'mysql') {
  const alarms = new InMemoryAlarmSink();
  const w = new AuditPluginWatcher({ engine, dbId: 'kafel-dev-mysql', sql, alarms, clock: new FakeClock(0) });
  return { w, alarms };
}

describe('AuditPluginWatcher', () => {
  it('reports active logging via the dev general_log stand-in (no alarm)', async () => {
    const { w, alarms } = watcher(sqlWith({ general_log: 'ON' }, []));
    const state = await w.check();
    expect(state.readable).toBe(true);
    expect(state.logging_active).toBe(true);
    expect(state.source).toBe('general_log');
    expect(state.tamper_indicators).toEqual([]);
    expect(alarms.alarms).toHaveLength(0);
  });

  it('reports active logging via an audit plugin', async () => {
    const { w } = watcher(sqlWith({ general_log: 'OFF' }, [{ name: 'server_audit', status: 'ACTIVE' }]), 'mariadb');
    const state = await w.check();
    expect(state.logging_active).toBe(true);
    expect(state.source).toBe('plugin');
    expect(state.plugin_name).toBe('server_audit');
  });

  it('flags AUDIT_PLUGIN_DISABLED + AUDIT_TAMPER when nothing is logging', async () => {
    const { w, alarms } = watcher(sqlWith({ general_log: 'OFF' }, [{ name: 'server_audit', status: 'DISABLED' }]));
    const state = await w.check();
    expect(state.logging_active).toBe(false);
    expect(state.tamper_indicators).toContain('AUDIT_PLUGIN_DISABLED');
    expect(alarms.byKind('AUDIT_TAMPER').some((a) => a.severity === 'high')).toBe(true);
  });

  it('does NOT claim disabled when state is unreadable (INV-2), but alarms', async () => {
    const failing: SqlReader = { async query() { throw new Error('no access'); } };
    const { w, alarms } = watcher(failing);
    const state = await w.check();
    expect(state.readable).toBe(false);
    expect(state.tamper_indicators).toEqual([]); // no fabricated AUDIT_PLUGIN_DISABLED
    expect(alarms.byKind('AUDIT_TAMPER')).toHaveLength(1);
  });
});
