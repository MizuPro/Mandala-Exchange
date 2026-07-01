const { Client } = require('pg');
const client = new Client({ connectionString: 'postgres://postgres:postgres@localhost:5432/mandala_sekuritas' });
client.connect().then(() => {
  return client.query(`
    DO $$ DECLARE
      r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);
}).then(() => {
  console.log('Dropped all tables in public schema');
  client.end();
}).catch(e => {
  console.error(e);
  client.end();
});
