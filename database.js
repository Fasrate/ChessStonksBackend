const { Pool } = require('pg');

// Setup PostgreSQL connection pool
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'chessstonks',
  password: 'Aman@123',
  port: 5432,
  max: 10,  // Maximum number of clients in the pool
  idleTimeoutMillis: 30000,  // How long a client is allowed to remain idle before being closed
});

// Function to execute a query
const query = async (text, params) => {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } catch (err) {
    console.error('Query error', err.stack);
    throw err; // Rethrow the error for handling at a higher level
  } finally {
    client.release(); // Ensure the client is released back to the pool
  }
};

// Export the pool and query function
module.exports = {
  pool,
  query,
};
