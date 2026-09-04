-- Runs once, on first boot of the docker-compose Postgres volume.
-- The application database (ottodot_trial) is created by POSTGRES_DB; this adds the
-- separate database the test suite resets and hammers, so `npm test` never touches
-- the data you are demoing in the browser.
CREATE DATABASE ottodot_trial_test OWNER ottodot;
