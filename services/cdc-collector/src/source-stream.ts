// Source stream reader (Epic E2 / EDAM-T014).
// Reads Debezium change events from the Redis sink stream(s) and decodes them
// into RawSourceEvents for the adapters.

import type { RawSourceEvent } from './adapters/types.js';

export interface SourceStream {
  /** Return the next raw event, or null when momentarily idle. */
  next(): Promise<RawSourceEvent | null>;
  close?(): Promise<void>;
}

/** In-memory source for tests: replays a fixed list of events. */
export class InMemorySourceStream implements SourceStream {
  private i = 0;
  constructor(private readonly events: RawSourceEvent[]) {}

  async next(): Promise<RawSourceEvent | null> {
    return this.i < this.events.length ? this.events[this.i++]! : null;
  }
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * Decode one Redis stream entry (fields are a flat [name, value, ...] array)
 * into a RawSourceEvent. Tolerant of both Debezium layouts: an explicit
 * `value`/`key` field pair, or key-as-field-name with the value as the field
 * value.
 */
export function decodeRedisEntry(streamKey: string, id: string, fields: string[]): RawSourceEvent {
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    map.set(fields[i]!, fields[i + 1]!);
  }

  let keyRaw: string | undefined;
  let valueRaw: string | undefined;

  if (map.has('value')) {
    valueRaw = map.get('value');
    keyRaw = map.get('key');
  } else {
    // Debezium key-as-field-name layout: the single entry is {key: value}.
    const first = [...map.entries()][0];
    if (first) {
      keyRaw = first[0];
      valueRaw = first[1];
    }
  }

  return {
    topic: streamKey,
    key: keyRaw !== undefined ? tryParse(keyRaw) : undefined,
    value: valueRaw !== undefined ? tryParse(valueRaw) : null,
    streamId: id,
  };
}

/** Redis XREAD reader surface (satisfied by ioredis). */
export interface XReader {
  xread(...args: Array<string | number>): Promise<Array<[string, Array<[string, string[]]>]> | null>;
}

/**
 * Redis Streams source. Reads (blocking) from one or more Debezium sink streams,
 * resuming after the last seen id per stream. Decoding is delegated to
 * decodeRedisEntry (unit-tested); live reads run in the compose env.
 */
export class RedisSourceStream implements SourceStream {
  private readonly lastId = new Map<string, string>();
  private buffer: RawSourceEvent[] = [];

  constructor(
    private readonly reader: XReader,
    private readonly streamKeys: string[],
    private readonly blockMs = 2000,
    private readonly count = 100,
  ) {
    for (const k of streamKeys) this.lastId.set(k, '0-0');
  }

  async next(): Promise<RawSourceEvent | null> {
    if (this.buffer.length === 0) await this.fill();
    return this.buffer.shift() ?? null;
  }

  private async fill(): Promise<void> {
    const ids = this.streamKeys.map((k) => this.lastId.get(k) ?? '0-0');
    const res = await this.reader.xread(
      'COUNT', this.count, 'BLOCK', this.blockMs, 'STREAMS', ...this.streamKeys, ...ids,
    );
    if (!res) return;
    for (const [streamKey, entries] of res) {
      for (const [id, fields] of entries) {
        this.buffer.push(decodeRedisEntry(streamKey, id, fields));
        this.lastId.set(streamKey, id);
      }
    }
  }
}
