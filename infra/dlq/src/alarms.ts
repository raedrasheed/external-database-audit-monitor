// DLQ alarms (Epic E5 / EDAM-T038, EDAM-T040). Self-contained; callers adapt
// their own alarm sinks to this interface.

export type DlqAlarmKind = 'DLQ_ENQUEUE' | 'DLQ_QUARANTINE' | 'DLQ_DEPTH';
export type DlqAlarmSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface DlqAlarm {
  kind: DlqAlarmKind;
  severity: DlqAlarmSeverity;
  message: string;
  at: string;
  details?: Record<string, unknown>;
}

export interface DlqAlarmSink {
  raise(alarm: DlqAlarm): void;
}

export class InMemoryDlqAlarmSink implements DlqAlarmSink {
  readonly alarms: DlqAlarm[] = [];
  raise(alarm: DlqAlarm): void {
    this.alarms.push(alarm);
  }
  byKind(kind: DlqAlarmKind): DlqAlarm[] {
    return this.alarms.filter((a) => a.kind === kind);
  }
}

export class ConsoleDlqAlarmSink implements DlqAlarmSink {
  raise(alarm: DlqAlarm): void {
    // eslint-disable-next-line no-console
    console.warn(`[dlq:${alarm.kind}:${alarm.severity}] ${alarm.message}`, alarm.details ?? {});
  }
}
