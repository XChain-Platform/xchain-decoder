DROP TABLE IF EXISTS pubkeys;
CREATE TABLE pubkeys (
  address_id INTEGER UNSIGNED NOT NULL PRIMARY KEY,
  pubkey     VARCHAR(66) NOT NULL,
  FOREIGN KEY (address_id) REFERENCES index_addresses(id)
);
