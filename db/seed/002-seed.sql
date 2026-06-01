-- Baseline seed data for the EDAM dev stack (Epic E7 / EDAM-T049).
-- The fixed ids below are referenced by the conformance fixtures (EDAM-T050)
-- and mutated by the traffic generator's scenario transactions, so the dev
-- environment, fixtures, and generated traffic all line up.

INSERT INTO users (id, email, display_name, national_id, status) VALUES
  (778, 'sara@example.org',  'Sara Ahmad',  '1099887766', 'active'),
  (779, 'omar@example.org',  'Omar Khalid', '1088776655', 'active'),
  (780, 'layla@example.org', 'Layla Noor',  '1077665544', 'active');

INSERT INTO roles (id, code, name) VALUES
  (1, 'ADMIN',   'Administrator'),
  (2, 'ANALYST', 'Analyst'),
  (3, 'VIEWER',  'Viewer');

INSERT INTO permissions (id, code, description) VALUES
  (10, 'reversal.approve', 'Approve reversals'),
  (11, 'rule.manage',      'Manage risk rules'),
  (12, 'data.reveal',      'Reveal sensitive data');

INSERT INTO user_roles (user_id, role_id) VALUES
  (778, 2),
  (779, 1),
  (780, 3);

INSERT INTO beneficiaries (id, name, national_id, balance, status) VALUES
  (5567, 'Aid Recipient A', '2011223344', 1320.00, 'active'),
  (5568, 'Aid Recipient B', '2022334455',    0.00, 'active');

INSERT INTO wallets (id, user_id, balance) VALUES
  (4412, 778, 250.00),
  (4413, 779, 980.00);

INSERT INTO campaigns (id, title, status, total_raised) VALUES
  (88, 'Winter Relief', 'active', 45200.00),
  (89, 'Food Drive',    'active',  3100.00);

INSERT INTO donations (id, campaign_id, user_id, amount, status, approved_at) VALUES
  (90211, 88, 778, 100.00, 'approved', '2026-05-30 09:00:00.000'),
  (90212, 88, 779, 250.00, 'approved', '2026-05-30 10:00:00.000'),
  (90213, 89, 780,  75.00, 'pending',  NULL);

INSERT INTO ledger_entries (id, wallet_id, amount, direction) VALUES
  (700001, 4412, 250.00, 'credit'),
  (700002, 4413, 980.00, 'credit');

INSERT INTO audit_scratch (id, note) VALUES
  (1, 'scratch row a'),
  (2, 'scratch row b');
