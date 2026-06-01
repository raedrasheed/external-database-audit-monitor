// Internal bus publisher for CAPTURED records (Epic E2 / EDAM-T014).
// Redis Streams transport; the collector publishes here before advancing the
// offset (durable handoff, T012).

import type { CapturedRecord } from './captured.js';

export interface Bus {
  /** Publish a CAPTURED record; resolves to the bus message id once durable. */
  publish(record: CapturedRecord): Promise<string>;
}

/** In-memory bus for tests and dry runs. */
export class InMemoryBus implements Bus {
  readonly records: CapturedRecord[] = [];

  async publish(record: CapturedRecord): Promise<string> {
    this.records.push(record);
    return String(this.records.length - 1);
  }
}

/** Minimal Redis Streams writer surface (satisfied by ioredis). */
export interface RedisStreamWriter {
  xadd(key: string, id: string, field: string, value: string): Promise<string | null>;
}

/** Redis Streams bus. The record is XADDed as a single JSON field. */
export class RedisBus implements Bus {
  constructor(
    private readonly redis: RedisStreamWriter,
    private readonly streamKey: string,
  ) {}

  async publish(record: CapturedRecord): Promise<string> {
    const id = await this.redis.xadd(this.streamKey, '*', 'record', JSON.stringify(record));
    return id ?? '';
  }
}
