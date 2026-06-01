// Shared error type for the canonical package (Epic E1).

/** Thrown when a value cannot be canonicalized deterministically per CCE §12.7. */
export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalError';
  }
}
