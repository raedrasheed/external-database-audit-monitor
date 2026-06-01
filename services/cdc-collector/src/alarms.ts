// Operational alarms (Epic E2 / EDAM-T015).
// Distinct from risk alerts (E4); these are collector-health signals.

export type AlarmKind = 'LAG' | 'STALL' | 'RECONNECT' | 'SOURCE_ERROR';
export type AlarmSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface Alarm {
  kind: AlarmKind;
  severity: AlarmSeverity;
  message: string;
  at: string;
  details?: Record<string, unknown>;
}

export interface AlarmSink {
  raise(alarm: Alarm): void;
}

export class InMemoryAlarmSink implements AlarmSink {
  readonly alarms: Alarm[] = [];
  raise(alarm: Alarm): void {
    this.alarms.push(alarm);
  }
  byKind(kind: AlarmKind): Alarm[] {
    return this.alarms.filter((a) => a.kind === kind);
  }
}

export class ConsoleAlarmSink implements AlarmSink {
  raise(alarm: Alarm): void {
    // eslint-disable-next-line no-console
    console.warn(`[alarm:${alarm.kind}:${alarm.severity}] ${alarm.message}`, alarm.details ?? {});
  }
}
