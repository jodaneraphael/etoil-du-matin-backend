import "dotenv/config";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

const u = new URL(String(process.env.DATABASE_URL));
const name = decodeURIComponent(u.pathname.replace(/^\//, ""));

const { protocol, hostname, port, username, password } = {
  protocol: u.protocol,
  hostname: u.hostname,
  port: Number(u.port),
  username: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
};

if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unsafe db name: ${name}`);

const conn = await mysql.createConnection({
  host: hostname,
  port,
  user: username,
  password,
  ssl: {
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
    ca: readFileSync(String(process.env.DATABASE_SSL_CA_FILE), "utf8"),
  },
});

const [existing] = await conn.query(
  "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
  [name],
);
if ((existing as unknown[]).length > 0) {
  console.log(`database ${name} already exists; leaving it untouched`);
} else {
  await conn.query(
    `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  );
  console.log(`created database ${name}`);
}
await conn.end();