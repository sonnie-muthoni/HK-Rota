const { Pool } = require('pg');
// Set DATABASE_URL, e.g. postgres://user:pass@localhost:5432/roster
module.exports = new Pool({ connectionString: process.env.DATABASE_URL });
