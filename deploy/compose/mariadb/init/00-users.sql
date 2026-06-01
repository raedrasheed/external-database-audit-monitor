-- EDAM read-only access provisioning for MariaDB (Epic E7 / EDAM-T048).
-- INV-1: read-only CDC user; no write grants.
CREATE USER IF NOT EXISTS 'cdc'@'%' IDENTIFIED BY 'cdc_pw';
GRANT SELECT, RELOAD, SHOW DATABASES, REPLICATION SLAVE, REPLICATION CLIENT, BINLOG MONITOR
  ON *.* TO 'cdc'@'%';
FLUSH PRIVILEGES;
