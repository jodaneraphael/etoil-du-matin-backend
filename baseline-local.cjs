const mysql = require('mysql2/promise');
async function main() {
  try {
    const c = await mysql.createConnection({host:'localhost',user:'uukqqubtwn_etoil_du',password:'rh^Dt533',database:'uukqqubtwn_etoiledumatin_db'});
    await c.query('CREATE TABLE IF NOT EXISTS __drizzle_migrations (id VARCHAR(128) PRIMARY KEY, hash VARCHAR(128) NOT NULL, created_at BIGINT)');
    const [rows] = await c.query("SELECT * FROM __drizzle_migrations WHERE id='0000_init'");
    if (rows.length === 0) {
      await c.query("INSERT INTO __drizzle_migrations (id,hash,created_at) VALUES ('0000_init','64b4b380-306f-45e3-8ee8-3149722c462f',1790777958006)");
      console.log('baselined');
    } else {
      console.log('already baselined');
    }
    await c.end();
  } catch (e) { console.error(e.code); process.exit(1); }
}
main();
