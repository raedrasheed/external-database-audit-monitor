-- EDAM read-only access provisioning (Epic E7 / EDAM-T048).
-- INV-1: EDAM never writes to the monitored database. The CDC user is granted
-- only replication + SELECT; it has NO INSERT/UPDATE/DELETE/DDL/GRANT.

-- Read-only CDC user (used by Debezium Server).
CREATE USER IF NOT EXISTS 'cdc'@'%' IDENTIFIED WITH mysql_native_password BY 'cdc_pw';
GRANT SELECT, RELOAD, SHOW DATABASES, REPLICATION SLAVE, REPLICATION CLIENT
  ON *.* TO 'cdc'@'%';

-- Read-only native-audit reader (reads the dev audit stand-in table only).
CREATE USER IF NOT EXISTS 'audit_reader'@'%' IDENTIFIED WITH mysql_native_password BY 'audit_pw';
GRANT SELECT ON mysql.general_log TO 'audit_reader'@'%';

FLUSH PRIVILEGES;
