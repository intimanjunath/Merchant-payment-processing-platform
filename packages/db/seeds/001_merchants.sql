-- Two development merchants, used for local login and for checking that one
-- merchant can never see another's payments. Development only.
--
--   merchant1@example.test / acme-coffee-dev
--   merchant2@example.test / blue-bicycle-dev
--
-- The hashes are Argon2id (m=65536, t=3, p=4), generated with the argon2 package.
INSERT INTO merchants (email, name, password_hash)
VALUES
  ('merchant1@example.test', 'Acme Coffee',
   '$argon2id$v=19$m=65536,p=4,t=3$IIDfZVXbt78SP15CubtWQQ$51SfmeNbHIcl+0nYITHoFHV5ogNaF9AUzTmcKXe2zL0'),
  ('merchant2@example.test', 'Blue Bicycle Shop',
   '$argon2id$v=19$m=65536,p=4,t=3$I3yr97GVZjHbKmkr5I14ew$E+dORWp/QUz9bIM6heSygcdHGg+ZSh0RsK9pioIOY6k')
ON CONFLICT ((lower(email))) DO NOTHING;
