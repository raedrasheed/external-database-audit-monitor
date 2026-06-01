// Traffic-generator types (Epic E7 / EDAM-T049).

export type Operation = 'INSERT' | 'UPDATE' | 'DELETE' | 'DDL' | 'TRUNCATE';

/** A single SQL statement with metadata used for logging/inspection. */
export interface SqlOp {
  readonly op: Operation;
  readonly table: string;
  readonly sql: string;
  readonly description: string;
}

/**
 * A planned transaction: an ordered list of operations applied as one unit
 * where the engine allows (DDL/TRUNCATE implicitly commit and therefore run on
 * their own). `label` ties scenario transactions to conformance fixtures.
 */
export interface TxPlan {
  readonly seq: number;
  readonly label: string;
  readonly ops: readonly SqlOp[];
}
