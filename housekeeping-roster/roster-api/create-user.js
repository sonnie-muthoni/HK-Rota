// Usage: DATABASE_URL=... node create-user.js <username> <password> <admin|manager|supervisor|staff> [staff_code]
const bcrypt = require('bcryptjs');
const db = require('./db');
(async () => {
  const [username, password, role, staffCode] = process.argv.slice(2);
  if (!username || !password || !role) { console.error('Usage: node create-user.js <username> <password> <role> [staff_code]'); process.exit(1); }
  const staff = staffCode ? (await db.query('SELECT id FROM staff WHERE staff_code=$1', [staffCode])).rows[0] : null;
  await db.query('INSERT INTO users (username,password_hash,role,staff_id) VALUES ($1,$2,$3,$4)',
    [username, await bcrypt.hash(password, 10), role, staff ? staff.id : null]);
  console.log('User created:', username, role);
  await db.end();
})().catch(e => { console.error(e.message); process.exit(1); });
