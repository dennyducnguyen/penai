-- Keep the owner's contact alias separate from the public Zalo name.
ALTER TABLE inbox_threads ADD COLUMN contact_alias text DEFAULT '';
