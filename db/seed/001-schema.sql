-- Kafel-like schema for the EDAM dev stack (Epic E7 / EDAM-T049).
-- A representative donation/charity financial domain used by the traffic
-- generator and conformance fixtures. Monetary columns are DECIMAL (never
-- float) to match CCE exact-decimal handling. Engine-portable DDL (MySQL +
-- MariaDB). All tables live in the `kafel` database created by the container.

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS ledger_entries;
DROP TABLE IF EXISTS donations;
DROP TABLE IF EXISTS campaigns;
DROP TABLE IF EXISTS wallets;
DROP TABLE IF EXISTS beneficiaries;
DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS audit_scratch;

CREATE TABLE users (
  id           BIGINT PRIMARY KEY,
  email        VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  national_id  VARCHAR(64)  NULL,
  status       VARCHAR(32)  NOT NULL DEFAULT 'active',
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE roles (
  id   BIGINT PRIMARY KEY,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE permissions (
  id   BIGINT PRIMARY KEY,
  code VARCHAR(64) NOT NULL,
  description VARCHAR(255) NULL
) ENGINE=InnoDB;

CREATE TABLE user_roles (
  user_id BIGINT NOT NULL,
  role_id BIGINT NOT NULL,
  PRIMARY KEY (user_id, role_id)
) ENGINE=InnoDB;

CREATE TABLE beneficiaries (
  id          BIGINT PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  national_id VARCHAR(64)  NULL,
  balance     DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  status      VARCHAR(32)  NOT NULL DEFAULT 'active',
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE wallets (
  id        BIGINT PRIMARY KEY,
  user_id   BIGINT NOT NULL,
  balance   DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE campaigns (
  id          BIGINT PRIMARY KEY,
  title       VARCHAR(255) NOT NULL,
  status      VARCHAR(32)  NOT NULL DEFAULT 'active',
  total_raised DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE donations (
  id          BIGINT PRIMARY KEY,
  campaign_id BIGINT NULL,
  user_id     BIGINT NULL,
  amount      DECIMAL(18,2) NOT NULL,
  status      VARCHAR(32)  NOT NULL DEFAULT 'pending',
  approved_at DATETIME(3)  NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE ledger_entries (
  id          BIGINT PRIMARY KEY,
  wallet_id   BIGINT NOT NULL,
  amount      DECIMAL(18,2) NOT NULL,
  direction   VARCHAR(8) NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

-- Disposable table used by the TRUNCATE traffic scenario.
CREATE TABLE audit_scratch (
  id    BIGINT PRIMARY KEY,
  note  VARCHAR(255) NULL
) ENGINE=InnoDB;

SET FOREIGN_KEY_CHECKS = 1;
