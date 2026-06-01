-- EDAM collector state database scaffolding (Epic E7 / EDAM-T048).
-- The offset / dead-letter / config-snapshot tables are introduced in later
-- epics (E2 CDC offsets, E3 attestation, E5 DLQ). Per E7 scope discipline,
-- this only provisions the schema; NO projection/audit tables are created here.
CREATE SCHEMA IF NOT EXISTS edam_state;
COMMENT ON SCHEMA edam_state IS
  'EDAM collector state (CDC offsets, DLQ, config snapshots). Tables added in Epics E2/E3/E5.';
