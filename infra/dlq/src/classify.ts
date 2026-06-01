// Failure classification (Epic E5 / EDAM-T038).
//
// Maps a failure to a category + default retryability. When the category is
// uncertain it is UNCLASSIFIED (which the retry policy routes to quarantine +
// alarm — never silently dropped).

import type { FailureCategory, FailureContext } from './types.js';

/** Data-defect categories are non-retryable; only unexpected errors may retry. */
export const DEFAULT_RETRYABLE: Record<FailureCategory, boolean> = {
  MALFORMED_CDC_EVENT: false,
  UNSUPPORTED_ENGINE: false,
  SCHEMA_VALIDATION_FAILURE: false,
  OFFSET_CORRUPTION: false,
  SERIALIZATION_FAILURE: false,
  UNEXPECTED_EXCEPTION: true,
  UNCLASSIFIED: false,
};

function inferCategory(ctx: FailureContext): FailureCategory {
  const err = ctx.error;
  const msg = (err instanceof Error ? err.message : typeof err === 'string' ? err : '').toLowerCase();
  if (err instanceof SyntaxError || /json|parse|malformed|unexpected token/.test(msg)) return 'MALFORMED_CDC_EVENT';
  if (/unsupported engine|unknown engine|no adapter/.test(msg)) return 'UNSUPPORTED_ENGINE';
  if (/schema|validation|invalid cce|rule v\d/.test(msg)) return 'SCHEMA_VALIDATION_FAILURE';
  if (/offset|gtid corrupt|corrupt offset/.test(msg)) return 'OFFSET_CORRUPTION';
  if (/serializ/.test(msg)) return 'SERIALIZATION_FAILURE';
  if (err !== undefined) return 'UNEXPECTED_EXCEPTION';
  return 'UNCLASSIFIED'; // uncertain -> quarantine + alarm
}

export interface Classification {
  category: FailureCategory;
  retryable: boolean;
}

export function classifyFailure(ctx: FailureContext): Classification {
  const category = ctx.category ?? inferCategory(ctx);
  const retryable = ctx.retryable ?? DEFAULT_RETRYABLE[category];
  return { category, retryable };
}
