// Stage 1 API: login, roles, staff and residences (with audit trail)
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { toXlsx, toPdf } = require('./exporters');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) { console.error('Set JWT_SECRET before starting.'); process.exit(1); }

const app = express();
app.use(express.json());
app.use(express.static(__dirname + '/public'));

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  if (e.code === '23505') return res.status(409).json({ error: 'That value is already used.' });
  console.error(e); res.status(500).json({ error: 'Something went wrong.' });
});

function auth(...roles) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    try {
      req.user = jwt.verify(h.replace('Bearer ', ''), SECRET);
    } catch { return res.status(401).json({ error: 'Please log in.' }); }
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have access to this.' });
    next();
  };
}
const audit = (user, entity, oldV, newV, reason) =>
  db.query('INSERT INTO audit_logs (user_id,entity,old_value,new_value,reason) VALUES ($1,$2,$3,$4,$5)',
    [user.id, entity, oldV ? JSON.stringify(oldV) : null, newV ? JSON.stringify(newV) : null, reason || null]);

// ---- Login ----
app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body;
  const u = (await db.query('SELECT * FROM users WHERE username=$1 AND active', [username])).rows[0];
  if (!u || !(await bcrypt.compare(password || '', u.password_hash))) return res.status(401).json({ error: 'Wrong username or password.' });
  const token = jwt.sign({ id: u.id, role: u.role, staff_id: u.staff_id }, SECRET, { expiresIn: '12h' });
  res.json({ token, role: u.role });
}));

app.get('/api/shift-codes', auth(), wrap(async (req, res) => {
  res.json((await db.query('SELECT id,code,label,category,shift_id,color FROM shift_codes ORDER BY id')).rows);
}));

// ---- Staff (manager and admin edit; supervisor can view) ----
const STAFF_COLS = ['staff_code', 'full_name', 'position', 'phone', 'employment_status', 'normal_shift_code_id', 'availability', 'leave_balance_annual'];

app.get('/api/staff', auth('admin', 'manager', 'supervisor'), wrap(async (req, res) => {
  res.json((await db.query('SELECT * FROM staff ORDER BY full_name')).rows);
}));

app.post('/api/staff', auth('admin', 'manager'), wrap(async (req, res) => {
  const b = req.body;
  if (!b.staff_code || !b.full_name) return res.status(400).json({ error: 'Staff ID and full name are required.' });
  const vals = STAFF_COLS.map(c => b[c] ?? null);
  const r = await db.query(
    `INSERT INTO staff (${STAFF_COLS.join(',')}) VALUES ($1,$2,$3,$4,COALESCE($5::text,'active'),$6::int,COALESCE($7::jsonb,'{}'::jsonb),COALESCE($8::numeric,0)) RETURNING *`, vals);
  await audit(req.user, 'staff:create', null, r.rows[0]);
  res.status(201).json(r.rows[0]);
}));

app.put('/api/staff/:id', auth('admin', 'manager'), wrap(async (req, res) => {
  const old = (await db.query('SELECT * FROM staff WHERE id=$1', [req.params.id])).rows[0];
  if (!old) return res.status(404).json({ error: 'Staff member not found.' });
  const merged = STAFF_COLS.map(c => (req.body[c] !== undefined ? req.body[c] : old[c]));
  const r = await db.query(
    `UPDATE staff SET ${STAFF_COLS.map((c, i) => `${c}=$${i + 1}`).join(',')} WHERE id=$${STAFF_COLS.length + 1} RETURNING *`,
    [...merged, req.params.id]);
  await audit(req.user, 'staff:update', old, r.rows[0], req.body.reason);
  res.json(r.rows[0]);
}));

// Staff with roster history are deactivated, not deleted.
app.delete('/api/staff/:id', auth('admin', 'manager'), wrap(async (req, res) => {
  const used = (await db.query('SELECT 1 FROM roster_assignments WHERE staff_id=$1 LIMIT 1', [req.params.id])).rowCount;
  if (used) {
    await db.query("UPDATE staff SET employment_status='inactive' WHERE id=$1", [req.params.id]);
    await audit(req.user, 'staff:deactivate', { id: req.params.id }, null);
    return res.json({ deactivated: true, message: 'This person has roster history, so they were deactivated instead of removed.' });
  }
  await db.query('DELETE FROM staff WHERE id=$1', [req.params.id]);
  await audit(req.user, 'staff:delete', { id: req.params.id }, null);
  res.json({ deleted: true });
}));

// ---- Residences ----
const RES_COLS = ['name', 'location', 'cleaning_areas', 'room_count', 'cleaning_frequency', 'special_requirements', 'notes'];

app.get('/api/residences', auth(), wrap(async (req, res) => {
  const r = await db.query(
    `SELECT r.*, COALESCE(json_agg(json_build_object('id',s.id,'full_name',s.full_name)) FILTER (WHERE s.id IS NOT NULL),'[]') AS staff
     FROM residences r LEFT JOIN residence_staff rs ON rs.residence_id=r.id LEFT JOIN staff s ON s.id=rs.staff_id
     GROUP BY r.id ORDER BY r.name`);
  res.json(r.rows);
}));

app.post('/api/residences', auth('admin', 'manager'), wrap(async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Residence name is required.' });
  const r = await db.query(`INSERT INTO residences (${RES_COLS.join(',')}) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, RES_COLS.map(c => req.body[c] ?? null));
  await audit(req.user, 'residence:create', null, r.rows[0]);
  res.status(201).json(r.rows[0]);
}));

app.put('/api/residences/:id', auth('admin', 'manager'), wrap(async (req, res) => {
  const old = (await db.query('SELECT * FROM residences WHERE id=$1', [req.params.id])).rows[0];
  if (!old) return res.status(404).json({ error: 'Residence not found.' });
  const merged = RES_COLS.map(c => (req.body[c] !== undefined ? req.body[c] : old[c]));
  const r = await db.query(`UPDATE residences SET ${RES_COLS.map((c, i) => `${c}=$${i + 1}`).join(',')} WHERE id=$${RES_COLS.length + 1} RETURNING *`, [...merged, req.params.id]);
  await audit(req.user, 'residence:update', old, r.rows[0]);
  res.json(r.rows[0]);
}));

// Replace the list of staff assigned to a residence
app.put('/api/residences/:id/staff', auth('admin', 'manager'), wrap(async (req, res) => {
  const ids = Array.isArray(req.body.staff_ids) ? req.body.staff_ids : [];
  await db.query('DELETE FROM residence_staff WHERE residence_id=$1', [req.params.id]);
  for (const sid of ids) await db.query('INSERT INTO residence_staff VALUES ($1,$2)', [req.params.id, sid]);
  await audit(req.user, 'residence:staff', null, { residence_id: req.params.id, staff_ids: ids });
  res.json({ ok: true });
}));

// ---- Settings (admin) ----
app.get('/api/settings', auth('admin', 'manager', 'supervisor'), wrap(async (req, res) => {
  res.json(Object.fromEntries((await db.query('SELECT key,value FROM system_settings')).rows.map(r => [r.key, r.value])));
}));
app.put('/api/settings/:key', auth('admin'), wrap(async (req, res) => {
  await db.query(`INSERT INTO system_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2`, [req.params.key, JSON.stringify(req.body.value)]);
  await audit(req.user, 'settings:' + req.params.key, null, req.body.value);
  res.json({ ok: true });
}));

// ---- Shifts (Stage 3): times are settings, not code ----
const SHIFT_TIMES = ['start_time', 'end_time', 'report_time', 'opening_start', 'opening_end', 'handover_start', 'handover_end', 'closing_start'];
app.get('/api/shifts', auth(), wrap(async (req, res) => {
  res.json((await db.query(
    `SELECT id,name,${SHIFT_TIMES.map(c => `to_char(${c},'HH24:MI') AS ${c}`).join(',')} FROM shifts ORDER BY name`)).rows);
}));
app.put('/api/shifts/:id', auth('admin'), wrap(async (req, res) => {
  const vals = [];
  for (const c of SHIFT_TIMES) {
    const v = req.body[c] || null;
    if (v && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return res.status(400).json({ error: 'Times must look like 07:00.' });
    vals.push(v);
  }
  if (!vals[0] || !vals[1]) return res.status(400).json({ error: 'Shift start and end are required.' });
  const r = await db.query(`UPDATE shifts SET ${SHIFT_TIMES.map((c, i) => `${c}=$${i + 1}`).join(',')} WHERE id=$${SHIFT_TIMES.length + 1} RETURNING id,name`, [...vals, req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Shift not found.' });
  await audit(req.user, 'shift:' + r.rows[0].name, null, req.body);
  res.json({ ok: true });
}));

// ---- Monthly roster (Stage 2) ----
const ROSTER_ROLES = ['admin', 'manager', 'supervisor'];
app.get('/api/rosters/:year(\\d{4})/:month(\\d{1,2})', auth(...ROSTER_ROLES), wrap(async (req, res) => {
  const y = +req.params.year, m = +req.params.month;
  if (!(m >= 1 && m <= 12 && y > 2000 && y < 2100)) return res.status(400).json({ error: 'Choose a valid month and year.' });
  await db.query('INSERT INTO rosters (year,month) VALUES ($1,$2) ON CONFLICT (year,month) DO NOTHING', [y, m]);
  const roster = (await db.query('SELECT id,year,month,status FROM rosters WHERE year=$1 AND month=$2', [y, m])).rows[0];
  const staff = (await db.query("SELECT id,staff_code,full_name FROM staff WHERE employment_status='active' ORDER BY staff_code")).rows;
  const assignments = (await db.query(
    `SELECT id, staff_id, to_char(work_date,'YYYY-MM-DD') AS d, shift_code_id, residence_id, duty_note,
       (SELECT COALESCE(json_agg(duty_id ORDER BY sort_order),'[]') FROM assignment_duties ad WHERE ad.assignment_id=roster_assignments.id) AS duty_ids
     FROM roster_assignments WHERE roster_id=$1`, [roster.id])).rows;
  res.json({ roster, staff, assignments });
}));

// Set, change or clear one cell (shift_code_id null clears it). Every change is audited.
app.put('/api/rosters/:id/cell', auth(...ROSTER_ROLES), wrap(async (req, res) => {
  const { staff_id, work_date, shift_code_id, residence_id, duty_note, reason } = req.body;
  const roster = (await db.query('SELECT * FROM rosters WHERE id=$1', [req.params.id])).rows[0];
  if (!roster) return res.status(404).json({ error: 'Roster not found.' });
  const prefix = roster.year + '-' + String(roster.month).padStart(2, '0') + '-';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(work_date || '') || !work_date.startsWith(prefix)) return res.status(400).json({ error: 'That date is not in this month.' });
  const codeRow = (await db.query('SELECT code,category FROM shift_codes WHERE id=$1', [shift_code_id || 0])).rows[0];
  if (shift_code_id && !codeRow) return res.status(400).json({ error: 'Unknown roster code.' });
  const override = !!req.body.override;
  if (codeRow && !override) {
    if (codeRow.category === 'work') {
      const onLeave = await db.query("SELECT 1 FROM leave WHERE staff_id=$1 AND status='approved' AND $2::date BETWEEN start_date AND end_date", [staff_id, work_date]);
      if (onLeave.rowCount) return res.status(409).json({ code: 'ON_LEAVE', error: 'This person is on approved leave on that date.' });
    }
    if (codeRow.category === 'off') {
      const target = Number((await db.query("SELECT value FROM system_settings WHERE key='monthly_off_days'")).rows[0]?.value) || 4;
      const n = (await db.query("SELECT count(*)::int AS n FROM roster_assignments ra JOIN shift_codes sc ON sc.id=ra.shift_code_id WHERE ra.roster_id=$1 AND ra.staff_id=$2 AND sc.category='off' AND ra.work_date<>$3", [roster.id, staff_id, work_date])).rows[0].n;
      if (n >= target) return res.status(409).json({ code: 'OFF_LIMIT', error: 'This person already has ' + n + ' off days this month (limit ' + target + ').' });
    }
  }
  const codeOf = async id => id ? (await db.query('SELECT code FROM shift_codes WHERE id=$1', [id])).rows[0]?.code : null;
  const oldRow = (await db.query('SELECT shift_code_id,duty_note FROM roster_assignments WHERE roster_id=$1 AND staff_id=$2 AND work_date=$3', [roster.id, staff_id, work_date])).rows[0];
  if (shift_code_id) {
    const up = await db.query(
      `INSERT INTO roster_assignments (roster_id,staff_id,work_date,shift_code_id,residence_id,duty_note) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (roster_id,staff_id,work_date) DO UPDATE SET shift_code_id=$4, residence_id=$5, duty_note=$6 RETURNING id`,
      [roster.id, staff_id, work_date, shift_code_id, residence_id || null, duty_note || null]);
    if (Array.isArray(req.body.duty_ids)) {
      const aid = up.rows[0].id;
      await db.query('DELETE FROM assignment_duties WHERE assignment_id=$1', [aid]);
      for (const [i, did] of req.body.duty_ids.entries())
        await db.query('INSERT INTO assignment_duties (assignment_id,duty_id,sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [aid, did, i]);
    }
  } else {
    await db.query('DELETE FROM roster_assignments WHERE roster_id=$1 AND staff_id=$2 AND work_date=$3', [roster.id, staff_id, work_date]);
  }
  const oldTxt = oldRow ? [await codeOf(oldRow.shift_code_id), oldRow.duty_note].filter(Boolean).join(' - ') : '(empty)';
  const newTxt = shift_code_id ? [await codeOf(shift_code_id), duty_note].filter(Boolean).join(' - ') : '(empty)';
  await db.query('INSERT INTO audit_logs (user_id,staff_id,work_date,entity,old_value,new_value,reason) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [req.user.id, staff_id, work_date, 'roster_cell', oldTxt, newTxt, override ? ((reason || '') + ' [manager override]').trim() : (reason || null)]);
  res.json({ ok: true });
}));

app.post('/api/rosters/:id/publish', auth('admin', 'manager'), wrap(async (req, res) => {
  const r = await db.query("UPDATE rosters SET status='published', published_by=$1, published_at=now() WHERE id=$2 RETURNING id,status", [req.user.id, req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Roster not found.' });
  await audit(req.user, 'roster:publish', null, { roster_id: req.params.id });
  res.json(r.rows[0]);
}));

// ---- Leave (Stage 5) ----
const LEAVE_TYPES = ['annual', 'sick', 'emergency', 'other'];
const eachDay = (a, b) => { const out = []; for (let d = new Date(a + 'T00:00:00Z'); d <= new Date(b + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10)); return out; };

app.get('/api/leave', auth(...ROSTER_ROLES), wrap(async (req, res) => {
  res.json((await db.query(
    `SELECT l.id, l.staff_id, s.full_name, l.leave_type, to_char(l.start_date,'YYYY-MM-DD') AS start_date,
            to_char(l.end_date,'YYYY-MM-DD') AS end_date, l.status, l.notes
     FROM leave l JOIN staff s ON s.id=l.staff_id ORDER BY l.start_date DESC LIMIT 300`)).rows);
}));

// Recording leave marks the person L on the roster for those dates.
app.post('/api/leave', auth('admin', 'manager'), wrap(async (req, res) => {
  const { staff_id, leave_type, start_date, end_date, notes } = req.body;
  const ok = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
  if (!staff_id || !LEAVE_TYPES.includes(leave_type) || !ok(start_date) || !ok(end_date)) return res.status(400).json({ error: 'Choose a staff member, leave type and dates.' });
  if (end_date < start_date) return res.status(400).json({ error: 'The end date is before the start date.' });
  const days = eachDay(start_date, end_date);
  if (days.length > 366) return res.status(400).json({ error: 'Leave cannot be longer than a year.' });
  const L = (await db.query("SELECT id FROM shift_codes WHERE code='L'")).rows[0];
  if (!L) return res.status(500).json({ error: 'The L roster code is missing. Add it in the code settings.' });
  const r = await db.query("INSERT INTO leave (staff_id,leave_type,start_date,end_date,status,approved_by,notes) VALUES ($1,$2,$3,$4,'approved',$5,$6) RETURNING id", [staff_id, leave_type, start_date, end_date, req.user.id, notes || null]);
  for (const d of days) {
    const [y, m] = d.split('-').map(Number);
    await db.query('INSERT INTO rosters (year,month) VALUES ($1,$2) ON CONFLICT (year,month) DO NOTHING', [y, m]);
    const ro = (await db.query('SELECT id FROM rosters WHERE year=$1 AND month=$2', [y, m])).rows[0];
    await db.query(`INSERT INTO roster_assignments (roster_id,staff_id,work_date,shift_code_id) VALUES ($1,$2,$3,$4)
                    ON CONFLICT (roster_id,staff_id,work_date) DO UPDATE SET shift_code_id=$4, residence_id=NULL, duty_note=NULL`, [ro.id, staff_id, d, L.id]);
  }
  await db.query('INSERT INTO audit_logs (user_id,staff_id,work_date,entity,old_value,new_value,reason) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [req.user.id, staff_id, start_date, 'leave', null, leave_type + ' leave to ' + end_date, notes || null]);
  res.status(201).json({ id: r.rows[0].id, days: days.length });
}));

app.delete('/api/leave/:id', auth('admin', 'manager'), wrap(async (req, res) => {
  const l = (await db.query("SELECT staff_id, leave_type, to_char(start_date,'YYYY-MM-DD') AS s, to_char(end_date,'YYYY-MM-DD') AS e FROM leave WHERE id=$1", [req.params.id])).rows[0];
  if (!l) return res.status(404).json({ error: 'Leave record not found.' });
  const L = (await db.query("SELECT id FROM shift_codes WHERE code='L'")).rows[0];
  await db.query('DELETE FROM leave WHERE id=$1', [req.params.id]);
  if (L) await db.query('DELETE FROM roster_assignments WHERE staff_id=$1 AND work_date BETWEEN $2 AND $3 AND shift_code_id=$4', [l.staff_id, l.s, l.e, L.id]);
  await db.query('INSERT INTO audit_logs (user_id,staff_id,work_date,entity,old_value,new_value) VALUES ($1,$2,$3,$4,$5,$6)', [req.user.id, l.staff_id, l.s, 'leave', l.leave_type + ' leave to ' + l.e, '(removed)']);
  res.json({ ok: true });
}));

// ---- Duty library (Stage 6) ----
app.get('/api/duties', auth(), wrap(async (req, res) => {
  res.json((await db.query('SELECT id,name,category,active FROM duties ORDER BY category,name')).rows);
}));
app.post('/api/duties', auth('admin', 'manager'), wrap(async (req, res) => {
  const { name, category } = req.body;
  if (!name || !['opening', 'main', 'closing'].includes(category)) return res.status(400).json({ error: 'Enter a duty name and choose opening, main or closing.' });
  res.status(201).json((await db.query('INSERT INTO duties (name,category) VALUES ($1,$2) RETURNING id,name,category,active', [name.trim(), category])).rows[0]);
}));
app.put('/api/duties/:id', auth('admin', 'manager'), wrap(async (req, res) => {
  const r = await db.query('UPDATE duties SET name=COALESCE($1,name), category=COALESCE($2,category), active=COALESCE($3,active) WHERE id=$4 RETURNING id', [req.body.name || null, req.body.category || null, req.body.active ?? null, req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Duty not found.' });
  res.json({ ok: true });
}));

// ---- Today: attendance, tasks, replacements, handover (Stage 7) ----
app.get('/api/today', auth(...ROSTER_ROLES), wrap(async (req, res) => {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : new Date().toISOString().slice(0, 10);
  const rows = (await db.query(
    `SELECT ra.id, s.id AS staff_id, s.full_name, sc.code, sc.category, sc.shift_id, r.name AS residence, ra.duty_note,
            COALESCE(at.status,'') AS attendance,
            (SELECT COALESCE(json_agg(json_build_object('duty_id',du.id,'name',du.name,'category',du.category,'status',ad.task_status) ORDER BY ad.sort_order),'[]')
               FROM assignment_duties ad JOIN duties du ON du.id=ad.duty_id WHERE ad.assignment_id=ra.id) AS duties
     FROM roster_assignments ra JOIN staff s ON s.id=ra.staff_id JOIN shift_codes sc ON sc.id=ra.shift_code_id
     LEFT JOIN residences r ON r.id=ra.residence_id LEFT JOIN attendance at ON at.assignment_id=ra.id
     WHERE ra.work_date=$1 ORDER BY s.full_name`, [d])).rows;
  const replacements = (await db.query(
    `SELECT rp.assignment_id, o.full_name AS original, n.full_name AS replacement, rp.reason
     FROM replacements rp JOIN staff o ON o.id=rp.original_staff_id JOIN staff n ON n.id=rp.replacement_staff_id WHERE rp.work_date=$1`, [d])).rows;
  const handover = (await db.query(
    `SELECT h.*, u.username AS completed_by_name, to_char(h.completed_at,'HH24:MI') AS at_time
     FROM handover_records h LEFT JOIN users u ON u.id=h.completed_by WHERE h.work_date=$1 ORDER BY h.id DESC LIMIT 1`, [d])).rows[0] || null;
  res.json({ date: d, rows, replacements, handover });
}));

app.put('/api/attendance', auth(...ROSTER_ROLES), wrap(async (req, res) => {
  const { assignment_id, status, notes } = req.body;
  if (!['present', 'absent', 'late', 'sick', 'leave', 'off', 'replacement'].includes(status)) return res.status(400).json({ error: 'Choose an attendance status.' });
  await db.query(
    `INSERT INTO attendance (assignment_id,status,reported_at,marked_by,notes) VALUES ($1,$2,CASE WHEN $2 IN ('present','late') THEN now() END,$3,$4)
     ON CONFLICT (assignment_id) DO UPDATE SET status=$2, reported_at=CASE WHEN $2 IN ('present','late') THEN now() END, marked_by=$3, notes=$4`,
    [assignment_id, status, req.user.id, notes || null]);
  await audit(req.user, 'attendance', null, { assignment_id, status });
  res.json({ ok: true });
}));

app.put('/api/task', auth(...ROSTER_ROLES), wrap(async (req, res) => {
  const { assignment_id, duty_id, status } = req.body;
  if (!['open', 'done', 'skipped'].includes(status)) return res.status(400).json({ error: 'Invalid task status.' });
  await db.query('UPDATE assignment_duties SET task_status=$1 WHERE assignment_id=$2 AND duty_id=$3', [status, assignment_id, duty_id]);
  res.json({ ok: true });
}));

// Replacement: another person covers an assignment for that day (roster cell is unchanged).
app.post('/api/replacements', auth(...ROSTER_ROLES), wrap(async (req, res) => {
  const { assignment_id, replacement_staff_id, reason } = req.body;
  const a = (await db.query(
    `SELECT ra.staff_id, to_char(ra.work_date,'YYYY-MM-DD') AS d, ra.residence_id, sc.shift_id
     FROM roster_assignments ra JOIN shift_codes sc ON sc.id=ra.shift_code_id WHERE ra.id=$1`, [assignment_id])).rows[0];
  if (!a || !replacement_staff_id) return res.status(400).json({ error: 'Choose who is replacing.' });
  if (+replacement_staff_id === a.staff_id) return res.status(400).json({ error: 'A person cannot replace themselves.' });
  const busy = await db.query("SELECT 1 FROM roster_assignments ra JOIN shift_codes sc ON sc.id=ra.shift_code_id WHERE ra.staff_id=$1 AND ra.work_date=$2 AND sc.category='work'", [replacement_staff_id, a.d]);
  if (busy.rowCount) return res.status(409).json({ error: 'That person is already working that day.' });
  const lv = await db.query("SELECT 1 FROM leave WHERE staff_id=$1 AND status='approved' AND $2::date BETWEEN start_date AND end_date", [replacement_staff_id, a.d]);
  if (lv.rowCount) return res.status(409).json({ error: 'That person is on approved leave that day.' });
  await db.query('INSERT INTO replacements (assignment_id,original_staff_id,replacement_staff_id,work_date,shift_id,residence_id,reason,recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [assignment_id, a.staff_id, replacement_staff_id, a.d, a.shift_id, a.residence_id, reason || null, req.user.id]);
  await db.query('INSERT INTO audit_logs (user_id,staff_id,work_date,entity,old_value,new_value,reason) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [req.user.id, a.staff_id, a.d, 'replacement', 'staff ' + a.staff_id, 'replaced by staff ' + replacement_staff_id, reason || null]);
  res.status(201).json({ ok: true });
}));

const HANDOVER_FIELDS = ['cleaning_done', 'pending_work', 'special_instructions', 'residence_status', 'maintenance_issues', 'requests', 'supplies_needed', 'follow_up_areas'];
app.put('/api/handover', auth(...ROSTER_ROLES), wrap(async (req, res) => {
  const { work_date, from_shift_id, to_shift_id } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(work_date || '')) return res.status(400).json({ error: 'Choose a date.' });
  const vals = HANDOVER_FIELDS.map(f => req.body[f] || null);
  const ex = (await db.query('SELECT id FROM handover_records WHERE work_date=$1 ORDER BY id DESC LIMIT 1', [work_date])).rows[0];
  if (ex) await db.query(`UPDATE handover_records SET completed_by=$1, completed_at=now(), ${HANDOVER_FIELDS.map((f, i) => `${f}=$${i + 3}`).join(',')} WHERE id=$2`, [req.user.id, ex.id, ...vals]);
  else await db.query(`INSERT INTO handover_records (work_date,from_shift_id,to_shift_id,completed_by,completed_at,${HANDOVER_FIELDS.join(',')}) VALUES ($1,$2,$3,$4,now(),${HANDOVER_FIELDS.map((_, i) => '$' + (i + 5)).join(',')})`, [work_date, from_shift_id || null, to_shift_id || null, req.user.id, ...vals]);
  await audit(req.user, 'handover', null, { work_date });
  res.json({ ok: true });
}));

// ---- Automatic generation and validation (Stage 8) ----
const pad2 = v => String(v).padStart(2, '0');
const getCfg = async () => Object.fromEntries((await db.query('SELECT key,value FROM system_settings')).rows.map(r => [r.key, r.value]));

app.post('/api/rosters/:id/generate', auth('admin', 'manager'), wrap(async (req, res) => {
  const ro = (await db.query('SELECT * FROM rosters WHERE id=$1', [req.params.id])).rows[0];
  if (!ro) return res.status(404).json({ error: 'Roster not found.' });
  const n = new Date(ro.year, ro.month, 0).getDate();
  const ds = d => `${ro.year}-${pad2(ro.month)}-${pad2(d)}`;
  const cfg = await getCfg();
  const T = Number(req.body.off_days ?? cfg.monthly_off_days) || 4;
  const minA = Number(req.body.min_a ?? cfg.min_staff_a) || 0, minB = Number(req.body.min_b ?? cfg.min_staff_b) || 0;
  const ids = (req.body.staff_ids || []).map(Number);
  if (!ids.length) return res.status(400).json({ error: 'Choose at least one staff member.' });
  const staff = (await db.query("SELECT s.id, s.full_name, sc.code AS normal FROM staff s LEFT JOIN shift_codes sc ON sc.id=s.normal_shift_code_id WHERE s.id=ANY($1) AND s.employment_status='active' ORDER BY s.staff_code", [ids])).rows;
  const codes = Object.fromEntries((await db.query('SELECT id,code FROM shift_codes')).rows.map(r => [r.code, r.id]));
  if (!codes.A || !codes.B || !codes.OFF || !codes.L) return res.status(400).json({ error: 'The roster codes A, B, OFF and L must exist.' });
  const codeById = Object.fromEntries(Object.entries(codes).map(([c, i]) => [i, c]));
  const cat = Object.fromEntries((await db.query('SELECT code,category FROM shift_codes')).rows.map(r => [r.code, r.category]));
  const patternMode = req.body.mode === 'pattern';
  const pat = (Array.isArray(req.body.pattern) ? req.body.pattern : (Array.isArray(cfg.rotation_pattern) ? cfg.rotation_pattern : [])).map(c => String(c).toUpperCase());
  const workCodes = pat.filter(c => cat[c] === 'work');
  if (patternMode && !workCodes.length) return res.status(400).json({ error: 'The rotation pattern has no working shifts (for example A, B, OFF).' });
  const idx = Object.fromEntries(staff.map((s, i) => [s.id, i]));
  const sids = staff.map(s => s.id);
  if (req.body.overwrite) await db.query('DELETE FROM roster_assignments WHERE roster_id=$1 AND staff_id=ANY($2)', [ro.id, sids]);
  const grid = staff.map(() => Array(n).fill(null));
  (await db.query('SELECT staff_id, EXTRACT(DAY FROM work_date)::int AS d, shift_code_id FROM roster_assignments WHERE roster_id=$1 AND staff_id=ANY($2)', [ro.id, sids]))
    .rows.forEach(r => { grid[idx[r.staff_id]][r.d - 1] = codeById[r.shift_code_id] || 'X'; });
  const fixed = grid.map(r => r.map(c => c !== null));
  // 1. approved leave
  (await db.query("SELECT staff_id, to_char(start_date,'YYYY-MM-DD') AS a, to_char(end_date,'YYYY-MM-DD') AS b FROM leave WHERE status='approved' AND staff_id=ANY($1) AND end_date>=$2 AND start_date<=$3", [sids, ds(1), ds(n)]))
    .rows.forEach(l => { for (let d = 1; d <= n; d++) if (ds(d) >= l.a && ds(d) <= l.b && grid[idx[l.staff_id]][d - 1] === null) grid[idx[l.staff_id]][d - 1] = 'L'; });
  // 1b. special requirements: fixed days off (one date, or every given weekday)
  const notes = [];
  const reqs = (await db.query("SELECT staff_id, kind, to_char(req_date,'YYYY-MM-DD') AS req_date, weekday FROM staff_requirements WHERE staff_id=ANY($1)", [sids])).rows;
  staff.forEach((s, i) => {
    let forced = 0;
    for (let d = 1; d <= n; d++) {
      if (grid[i][d - 1] !== null) continue;
      const dow = new Date(ro.year, ro.month - 1, d).getDay();
      if (reqs.some(q => q.staff_id === s.id && ((q.kind === 'date' && q.req_date === ds(d)) || (q.kind === 'weekday' && q.weekday === dow)))) { grid[i][d - 1] = 'OFF'; forced++; }
    }
    if (forced > T) notes.push(`${s.full_name} has ${forced} fixed days off this month, more than the ${T} monthly off days.`);
  });
  // 2. off days: spread evenly, staggered per person, avoiding days when many others are off
  const offCount = Array(n).fill(0);
  grid.forEach(r => r.forEach((c, d) => { if (c === 'OFF') offCount[d]++; }));
  staff.forEach((s, i) => {
    const row = grid[i]; let have = row.filter(c => c === 'OFF').length; const step = n / T;
    for (let k = 0; have < T && k < T + n; k++) {
      const base = Math.floor(k * step + (i * 2) % Math.max(1, Math.floor(step)));
      let best = -1, bs = 1e9;
      for (let o = -3; o <= 3; o++) { const d = ((base + o) % n + n) % n; if (row[d] !== null) continue; const sc = offCount[d] * 10 + Math.abs(o); if (sc < bs) { bs = sc; best = d; } }
      if (best < 0) for (let d = 0; d < n; d++) if (row[d] === null && offCount[d] < bs) { bs = offCount[d]; best = d; }
      if (best < 0) break;
      row[best] = 'OFF'; offCount[best]++; have++;
    }
  });
  // 3. shifts. Rotation mode: the pattern's working shifts cycle block by block (a block is the run of working days
  //    between off or leave days), staggered per person. Otherwise each person's normal shift is used.
  //    Either way, people are then moved between A and B to meet the minimums.
  const blk = grid.map(row => { let b = 0, prevOff = false; return row.map(c => { const off = c === 'OFF' || c === 'L'; if (!off && prevOff) b++; prevOff = off; return b; }); });
  const bTot = grid.map(r => r.filter(c => c === 'B').length);
  for (let d = 0; d < n; d++) {
    const w = grid.map((r, i) => (r[d] === null ? i : -1)).filter(i => i >= 0);
    const cur = {}; w.forEach(i => { cur[i] = patternMode ? workCodes[(blk[i][d] + i) % workCodes.length] : (staff[i].normal === 'B' ? 'B' : 'A'); });
    const cnt = c => grid.filter(r => r[d] === c).length + w.filter(i => cur[i] === c).length;
    const flipped = new Set();
    while (cnt('B') < minB) {
      const c = w.filter(i => cur[i] === 'A' && (patternMode || staff[i].normal !== 'B')).sort((x, y) => bTot[x] - bTot[y])[0];
      if (c === undefined || cnt('A') <= minA) break; cur[c] = 'B'; flipped.add(c);
    }
    while (cnt('A') < minA) {
      const c = w.filter(i => cur[i] === 'B' && !flipped.has(i)).sort((x, y) => bTot[y] - bTot[x])[0];
      if (c === undefined || cnt('B') <= minB) break; cur[c] = 'A';
    }
    w.forEach(i => { grid[i][d] = cur[i]; if (cur[i] === 'B') bTot[i]++; });
  }
  const sA = [], dA = [], cA = [];
  grid.forEach((r, i) => r.forEach((c, d) => { if (!fixed[i][d] && c && codes[c]) { sA.push(staff[i].id); dA.push(ds(d + 1)); cA.push(codes[c]); } }));
  if (sA.length) await db.query(
    `INSERT INTO roster_assignments (roster_id,staff_id,work_date,shift_code_id)
     SELECT $1, unnest($2::int[]), unnest($3::date[]), unnest($4::int[])
     ON CONFLICT (roster_id,staff_id,work_date) DO UPDATE SET shift_code_id=EXCLUDED.shift_code_id, residence_id=NULL, duty_note=NULL`, [ro.id, sA, dA, cA]);
  await audit(req.user, 'roster:generate', null, { roster_id: ro.id, staff: sids.length, cells: sA.length, overwrite: !!req.body.overwrite, mode: patternMode ? 'pattern ' + workCodes.join(',') : 'normal' });
  res.json({ cells: sA.length, notes });
}));

app.get('/api/rosters/:id/validate', auth(...ROSTER_ROLES), wrap(async (req, res) => {
  const ro = (await db.query('SELECT year,month FROM rosters WHERE id=$1', [req.params.id])).rows[0];
  if (!ro) return res.status(404).json({ error: 'Roster not found.' });
  const n = new Date(ro.year, ro.month, 0).getDate(), ds = d => `${ro.year}-${pad2(ro.month)}-${pad2(d)}`;
  const cfg = await getCfg(), T = Number(cfg.monthly_off_days) || 4, maxRun = Number(cfg.max_consecutive_days) || 6;
  const staff = (await db.query("SELECT id,full_name FROM staff WHERE employment_status='active' ORDER BY staff_code")).rows;
  const shifts = (await db.query('SELECT id,name FROM shifts ORDER BY name')).rows;
  const cells = (await db.query("SELECT ra.staff_id, EXTRACT(DAY FROM ra.work_date)::int AS d, sc.category, sc.shift_id FROM roster_assignments ra JOIN shift_codes sc ON sc.id=ra.shift_code_id WHERE ra.roster_id=$1", [req.params.id])).rows;
  const leaves = (await db.query("SELECT staff_id, to_char(start_date,'YYYY-MM-DD') AS a, to_char(end_date,'YYYY-MM-DD') AS b FROM leave WHERE status='approved' AND end_date>=$1 AND start_date<=$2", [ds(1), ds(n)])).rows;
  const reqs = (await db.query("SELECT staff_id, kind, to_char(req_date,'YYYY-MM-DD') AS req_date, weekday FROM staff_requirements")).rows;
  const fixedOff = (sid, d) => reqs.some(q => q.staff_id === sid && ((q.kind === 'date' && q.req_date === ds(d)) || (q.kind === 'weekday' && q.weekday === new Date(ro.year, ro.month - 1, d).getDay())));
  const g = {}; cells.forEach(c => { (g[c.staff_id] = g[c.staff_id] || {})[c.d] = c; });
  const issues = [], add = (level, text) => issues.push({ level, text });
  for (const s of staff) {
    const row = g[s.id] || {}; let off = 0, blank = 0, run = 0, mx = 0;
    for (let d = 1; d <= n; d++) {
      const c = row[d];
      if (!c) { blank++; run = 0; continue; }
      if (c.category === 'work' && fixedOff(s.id, d)) add('warning', `${s.full_name} is scheduled on ${ds(d)}, which is a fixed day off.`);
      if (c.category === 'off') off++;
      if (c.category === 'work') { run++; mx = Math.max(mx, run); } else run = 0;
      if (c.category === 'work' && leaves.some(l => l.staff_id === s.id && ds(d) >= l.a && ds(d) <= l.b)) add('error', `${s.full_name} is scheduled to work on ${ds(d)} while on approved leave.`);
    }
    if (off < T) add('warning', `${s.full_name} has ${off} off days (needs ${T}).`);
    if (off > T) add('warning', `${s.full_name} has ${off} off days (limit ${T}).`);
    if (blank) add('warning', `${s.full_name} has ${blank} day(s) with no assignment.`);
    if (mx > maxRun) add('warning', `${s.full_name} works ${mx} days in a row (limit ${maxRun}).`);
  }
  for (const sh of shifts) {
    const min = Number(cfg['min_staff_' + sh.name.toLowerCase()]) || 0; const low = [];
    for (let d = 1; d <= n; d++) if (cells.filter(c => c.d === d && c.shift_id === sh.id).length < min) low.push(d);
    if (low.length) add('error', `Shift ${sh.name} is below its minimum of ${min} on day(s): ${low.slice(0, 10).join(', ')}${low.length > 10 ? ' and more' : ''}.`);
  }
  res.json({ issues });
}));

// ---- Print and export (Stage 9) ----
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
async function rosterData(year, month) {
  const ro = (await db.query('SELECT id FROM rosters WHERE year=$1 AND month=$2', [year, month])).rows[0];
  if (!ro) return null;
  const n = new Date(year, month, 0).getDate(), cfg = await getCfg();
  const staff = (await db.query("SELECT id,full_name FROM staff WHERE employment_status='active' ORDER BY staff_code")).rows;
  const codes = (await db.query('SELECT id,code,label,category,color FROM shift_codes ORDER BY id')).rows;
  const shifts = (await db.query(`SELECT name,${SHIFT_TIMES.map(c => `to_char(${c},'HH24:MI') AS ${c}`).join(',')} FROM shifts ORDER BY name`)).rows;
  const as = (await db.query(
    `SELECT ra.staff_id, EXTRACT(DAY FROM ra.work_date)::int AS d, ra.shift_code_id, ra.duty_note, r.name AS residence,
            (SELECT string_agg(du.name, '; ' ORDER BY ad.sort_order) FROM assignment_duties ad JOIN duties du ON du.id=ad.duty_id WHERE ad.assignment_id=ra.id) AS duties
     FROM roster_assignments ra LEFT JOIN residences r ON r.id=ra.residence_id WHERE ra.roster_id=$1`, [ro.id])).rows;
  const byCode = Object.fromEntries(codes.map(c => [c.id, c]));
  const cellMap = {}; as.forEach(a => { cellMap[a.staff_id + '|' + a.d] = a; });
  const duties = [];
  const rows = staff.map(s => {
    const counts = {}; let off = 0, leave = 0, blank = 0;
    const cells = Array.from({ length: n }, (_, i) => {
      const a = cellMap[s.id + '|' + (i + 1)];
      if (!a) { blank++; return null; }
      const c = byCode[a.shift_code_id];
      counts[c.code] = (counts[c.code] || 0) + 1;
      if (c.category === 'off') off++; if (c.category === 'leave') leave++;
      if (a.duty_note || a.duties || a.residence) duties.push({ date: `${year}-${pad2(month)}-${pad2(i + 1)}`, staff: s.full_name, code: c.code, residence: a.residence, note: a.duty_note, duties: a.duties });
      return { code: c.code, category: c.category, color: c.color };
    });
    return { name: s.full_name, cells, counts, off, leave, blank, working: n - off - leave - blank };
  });
  return { dept: (cfg.department_name || 'Housekeeping'), year, month, monthName: MONTHS[month - 1], n,
    days: Array.from({ length: n }, (_, i) => ({ d: i + 1, dow: new Date(year, month - 1, i + 1).getDay() })), staff: rows, codes, shifts, duties };
}
app.get('/api/rosters/:year/:month/export/:fmt', auth(...ROSTER_ROLES), wrap(async (req, res) => {
  const y = +req.params.year, m = +req.params.month, fmt = req.params.fmt;
  if (!['xlsx', 'pdf'].includes(fmt) || !(m >= 1 && m <= 12)) return res.status(400).json({ error: 'Unknown export.' });
  const data = await rosterData(y, m);
  if (!data) return res.status(404).json({ error: 'Open this month in the roster first.' });
  const paper = req.query.paper === 'A3' || (req.query.paper !== 'A4' && data.staff.length > 14) ? 'A3' : 'A4';
  const name = `roster-${y}-${pad2(m)}.${fmt}`;
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  if (fmt === 'xlsx') { res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); await toXlsx(data, paper, res); res.end(); }
  else { res.setHeader('Content-Type', 'application/pdf'); toPdf(data, paper, res); }
}));

// ---- Staff mobile view and manager dashboard (Stage 10) ----
const dateParam = q => (/^\d{4}-\d{2}-\d{2}$/.test(q || '') ? q : new Date().toISOString().slice(0, 10));

// A staff member sees only their own duty, and only from published rosters.
app.get('/api/me/today', auth(), wrap(async (req, res) => {
  const sid = req.user.staff_id;
  if (!sid) return res.status(400).json({ error: 'This account is not linked to a staff member. Ask a manager to link it.' });
  const d = dateParam(req.query.date);
  const name = (await db.query('SELECT full_name FROM staff WHERE id=$1', [sid])).rows[0]?.full_name;
  const up = (await db.query(
    `SELECT ra.id, to_char(ra.work_date,'YYYY-MM-DD') AS d, sc.code, sc.label, sc.category, sc.shift_id, r.name AS residence, ra.duty_note
     FROM roster_assignments ra JOIN rosters ro ON ro.id=ra.roster_id AND ro.status='published'
     JOIN shift_codes sc ON sc.id=ra.shift_code_id LEFT JOIN residences r ON r.id=ra.residence_id
     WHERE ra.staff_id=$1 AND ra.work_date>=$2 ORDER BY ra.work_date LIMIT 90`, [sid, d])).rows;
  const today = up.find(a => a.d === d) || null;
  let shift = null, duties = [];
  if (today) {
    duties = (await db.query(
      `SELECT du.id AS duty_id, du.name, du.category, ad.task_status AS status FROM assignment_duties ad JOIN duties du ON du.id=ad.duty_id WHERE ad.assignment_id=$1 ORDER BY ad.sort_order`, [today.id])).rows;
    if (today.shift_id) shift = (await db.query(`SELECT name,${SHIFT_TIMES.map(c => `to_char(${c},'HH24:MI') AS ${c}`).join(',')} FROM shifts WHERE id=$1`, [today.shift_id])).rows[0];
  }
  const covering = (await db.query(
    `SELECT o.full_name AS original, sh.name AS shift, r.name AS residence, rp.reason FROM replacements rp JOIN staff o ON o.id=rp.original_staff_id
     LEFT JOIN shifts sh ON sh.id=rp.shift_id LEFT JOIN residences r ON r.id=rp.residence_id WHERE rp.replacement_staff_id=$1 AND rp.work_date=$2`, [sid, d])).rows;
  const later = up.filter(a => a.d > d);
  res.json({ name, date: d, today, shift, duties, covering,
    nextWork: later.find(a => a.category === 'work') || null, nextOff: later.find(a => a.category === 'off') || null });
}));
app.put('/api/me/task', auth(), wrap(async (req, res) => {
  const { assignment_id, duty_id, status } = req.body;
  if (!req.user.staff_id || !['open', 'done'].includes(status)) return res.status(400).json({ error: 'Invalid request.' });
  const r = await db.query('UPDATE assignment_duties ad SET task_status=$1 FROM roster_assignments ra WHERE ra.id=ad.assignment_id AND ra.staff_id=$2 AND ad.assignment_id=$3 AND ad.duty_id=$4', [status, req.user.staff_id, assignment_id, duty_id]);
  if (!r.rowCount) return res.status(404).json({ error: 'That task is not yours.' });
  res.json({ ok: true });
}));

app.get('/api/dashboard', auth(...ROSTER_ROLES), wrap(async (req, res) => {
  const d = dateParam(req.query.date), [y, m] = d.split('-').map(Number), cfg = await getCfg();
  const shifts = (await db.query('SELECT id,name FROM shifts ORDER BY name')).rows;
  const t = (await db.query(`SELECT ra.id, sc.category, sc.shift_id, COALESCE(at.status,'') AS att FROM roster_assignments ra JOIN shift_codes sc ON sc.id=ra.shift_code_id LEFT JOIN attendance at ON at.assignment_id=ra.id WHERE ra.work_date=$1`, [d])).rows;
  const reps = new Set((await db.query('SELECT assignment_id FROM replacements WHERE work_date=$1', [d])).rows.map(r => r.assignment_id));
  const handover = (await db.query('SELECT 1 FROM handover_records WHERE work_date=$1 LIMIT 1', [d])).rowCount > 0;
  const gone = t.filter(r => ['absent', 'sick'].includes(r.att));
  const today = { date: d, byShift: shifts.map(sh => ({ name: sh.name, count: t.filter(r => r.category === 'work' && r.shift_id === sh.id).length })),
    off: t.filter(r => r.category === 'off').length, leave: t.filter(r => r.category === 'leave').length, absent: gone.length, replacements: reps.size,
    openAssignments: gone.filter(r => !reps.has(r.id)).length, pendingHandover: handover ? 0 : 1 };
  const ro = (await db.query('SELECT id,status FROM rosters WHERE year=$1 AND month=$2', [y, m])).rows[0];
  let monthly = null;
  if (ro) {
    const n = new Date(y, m, 0).getDate(), T = Number(cfg.monthly_off_days) || 4;
    const staff = (await db.query("SELECT count(*)::int AS n FROM staff WHERE employment_status='active'")).rows[0].n;
    const tot = (await db.query("SELECT sc.category, count(*)::int AS n FROM roster_assignments ra JOIN shift_codes sc ON sc.id=ra.shift_code_id WHERE ra.roster_id=$1 GROUP BY sc.category", [ro.id])).rows;
    const cnt = c => tot.find(x => x.category === c)?.n || 0;
    const per = (await db.query("SELECT sc.shift_id, EXTRACT(DAY FROM ra.work_date)::int AS d, count(*)::int AS n FROM roster_assignments ra JOIN shift_codes sc ON sc.id=ra.shift_code_id WHERE ra.roster_id=$1 AND sc.shift_id IS NOT NULL GROUP BY 1,2", [ro.id])).rows;
    let met = 0, all = 0;
    shifts.forEach(sh => { const min = Number(cfg['min_staff_' + sh.name.toLowerCase()]) || 0; for (let k = 1; k <= n; k++) { all++; if ((per.find(p => p.shift_id === sh.id && p.d === k)?.n || 0) >= min) met++; } });
    monthly = { rosterId: ro.id, status: ro.status, staff, offAllocated: cnt('off'), offTarget: staff * T, leaveDays: cnt('leave'), coverage: all ? Math.round(100 * met / all) : 100 };
  }
  res.json({ today, monthly });
}));

// ---- Special requirements: fixed days off (Stage 8 addition) ----
app.get('/api/requirements', auth(...ROSTER_ROLES), wrap(async (req, res) => {
  res.json((await db.query(`SELECT q.id, q.staff_id, s.full_name, q.kind, to_char(q.req_date,'YYYY-MM-DD') AS req_date, q.weekday, q.note
    FROM staff_requirements q JOIN staff s ON s.id=q.staff_id ORDER BY s.full_name, q.kind, q.req_date, q.weekday`)).rows);
}));
app.post('/api/requirements', auth('admin', 'manager'), wrap(async (req, res) => {
  const { staff_id, kind, req_date, weekday, note } = req.body;
  if (!staff_id || !['date', 'weekday'].includes(kind)) return res.status(400).json({ error: 'Choose a staff member and a type.' });
  if (kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(req_date || '')) return res.status(400).json({ error: 'Choose a date.' });
  if (kind === 'weekday' && !(Number.isInteger(+weekday) && +weekday >= 0 && +weekday <= 6)) return res.status(400).json({ error: 'Choose a weekday.' });
  const r = await db.query('INSERT INTO staff_requirements (staff_id,kind,req_date,weekday,note) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [staff_id, kind, kind === 'date' ? req_date : null, kind === 'weekday' ? +weekday : null, note || null]);
  await audit(req.user, 'requirement:add', null, { staff_id, kind, req_date, weekday });
  res.status(201).json(r.rows[0]);
}));
app.delete('/api/requirements/:id', auth('admin', 'manager'), wrap(async (req, res) => {
  await db.query('DELETE FROM staff_requirements WHERE id=$1', [req.params.id]);
  await audit(req.user, 'requirement:remove', { id: req.params.id }, null);
  res.json({ ok: true });
}));

// ---- Audit trail screen ----
app.get('/api/audit', auth('admin', 'manager'), wrap(async (req, res) => {
  const q = req.query, ok = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null;
  const limit = 50, offset = Math.max(0, parseInt(q.offset, 10) || 0);
  const rows = (await db.query(
    `SELECT a.id, to_char(a.occurred_at,'YYYY-MM-DD HH24:MI') AS at, u.username, u.role, s.full_name AS staff,
            to_char(a.work_date,'YYYY-MM-DD') AS work_date, a.entity, a.old_value, a.new_value, a.reason
     FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN staff s ON s.id=a.staff_id
     WHERE ($1::int IS NULL OR a.staff_id=$1) AND ($2::date IS NULL OR a.occurred_at>=$2::date)
       AND ($3::date IS NULL OR a.occurred_at < $3::date + 1) AND ($4::text IS NULL OR a.entity LIKE $4)
     ORDER BY a.id DESC LIMIT ${limit + 1} OFFSET $5`,
    [q.staff_id ? +q.staff_id : null, ok(q.from), ok(q.to), q.entity ? String(q.entity).slice(0, 40) : null, offset])).rows;
  res.json({ rows: rows.slice(0, limit), more: rows.length > limit, next: offset + limit });
}));

// ---- Roster codes screen ----
const PROTECTED_CODES = ['A', 'B', 'OFF', 'L']; // the generator and checks depend on these
const CATS = ['work', 'off', 'leave', 'other'];
const codeErr = b => {
  if (b.label !== undefined && !String(b.label).trim()) return 'Enter a meaning for the code.';
  if (b.category !== undefined && !CATS.includes(b.category)) return 'Choose a type.';
  if (b.color && !/^#[0-9a-fA-F]{6}$/.test(b.color)) return 'Choose a valid colour.';
  return null;
};
app.post('/api/shift-codes', auth('admin', 'manager'), wrap(async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase(), b = req.body;
  if (!/^[A-Z0-9]{1,8}$/.test(code)) return res.status(400).json({ error: 'Use 1 to 8 letters or digits for the code.' });
  const e = codeErr({ label: b.label || '', category: b.category, color: b.color });
  if (e) return res.status(400).json({ error: e });
  const r = await db.query('INSERT INTO shift_codes (code,label,shift_id,category,counts_as_working,color) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [code, b.label.trim(), b.category === 'work' && b.shift_id ? b.shift_id : null, b.category, b.category === 'work', b.color || null]);
  await audit(req.user, 'code:add', null, { code, label: b.label, category: b.category });
  res.status(201).json(r.rows[0]);
}));
app.put('/api/shift-codes/:id', auth('admin', 'manager'), wrap(async (req, res) => {
  const old = (await db.query('SELECT * FROM shift_codes WHERE id=$1', [req.params.id])).rows[0];
  if (!old) return res.status(404).json({ error: 'Code not found.' });
  const b = req.body, e = codeErr(b);
  if (e) return res.status(400).json({ error: e });
  const prot = PROTECTED_CODES.includes(old.code);
  const cat = prot ? old.category : (b.category ?? old.category);
  if (cat !== old.category && (await db.query('SELECT 1 FROM roster_assignments WHERE shift_code_id=$1 LIMIT 1', [old.id])).rowCount)
    return res.status(409).json({ error: 'This code is already on the roster, so its type cannot change. Clear those cells first.' });
  const shift = prot ? old.shift_id : (cat === 'work' ? ('shift_id' in b ? (b.shift_id || null) : old.shift_id) : null);
  await db.query('UPDATE shift_codes SET label=$1, category=$2, counts_as_working=$3, shift_id=$4, color=$5 WHERE id=$6',
    [(b.label ?? old.label).trim(), cat, cat === 'work', shift, b.color ?? old.color, old.id]);
  await audit(req.user, 'code:update', { code: old.code, label: old.label, category: old.category }, { label: b.label, category: cat, shift_id: shift });
  res.json({ ok: true });
}));
app.delete('/api/shift-codes/:id', auth('admin', 'manager'), wrap(async (req, res) => {
  const old = (await db.query('SELECT * FROM shift_codes WHERE id=$1', [req.params.id])).rows[0];
  if (!old) return res.status(404).json({ error: 'Code not found.' });
  if (PROTECTED_CODES.includes(old.code)) return res.status(400).json({ error: 'Built-in codes cannot be removed.' });
  if ((await db.query('SELECT 1 FROM roster_assignments WHERE shift_code_id=$1 LIMIT 1', [old.id])).rowCount) return res.status(409).json({ error: 'This code is used on a roster. Clear those cells first.' });
  await db.query('UPDATE staff SET normal_shift_code_id=NULL WHERE normal_shift_code_id=$1', [old.id]);
  await db.query('DELETE FROM shift_codes WHERE id=$1', [old.id]);
  await audit(req.user, 'code:remove', { code: old.code }, null);
  res.json({ ok: true });
}));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Roster API on port ' + port));
