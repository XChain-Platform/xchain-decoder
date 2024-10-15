DROP TABLE IF EXISTS events;
CREATE TABLE events (
    time               DATETIME PRIMARY KEY,
	code               VARCHAR(32),
    data               TEXT
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;

