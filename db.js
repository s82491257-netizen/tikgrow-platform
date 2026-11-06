

require("dotenv").config();

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.warn("DATABASE_URL is not configured yet.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true"
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on("error", (error) => {
  console.error("Database connection error:", error.message);
});

async function testDatabase() {
  const result = await pool.query("SELECT NOW() AS current_time");
  return result.rows[0];
}

module.exports = {
  pool,
  testDatabase
};
