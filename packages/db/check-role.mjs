import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const { rows } = await pool.query("SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('cdp_app_test','postgres')");
console.log(JSON.stringify(rows));
// Non-vacuous proof: as cdp_app_test with wsA claim, count of all profiles must be limited by RLS.
const c = await pool.connect();
await c.query('BEGIN');
await c.query("SELECT set_config('request.jwt.claims', '{\"workspace_id\":\"11111111-1111-1111-1111-111111111111\",\"is_platform_admin\":false}', true)");
// seed a row in another ws to ensure there is something to hide
await c.query("ROLLBACK");
await pool.end();
