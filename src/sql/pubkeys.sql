CREATE TABLE IF NOT EXISTS pubkeys (
  address_id INTEGER UNSIGNED NOT NULL PRIMARY KEY,
  pubkey     VARCHAR(66) NOT NULL,
  FOREIGN KEY (address_id) REFERENCES index_addresses(id)
);
