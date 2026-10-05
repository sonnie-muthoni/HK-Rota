-- Executive Residences Housekeeping Roster: Stage 1 schema (PostgreSQL 14+)
BEGIN;

CREATE TABLE shifts (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  start_time TIME NOT NULL, end_time TIME NOT NULL, report_time TIME,
  opening_start TIME, opening_end TIME, handover_start TIME, handover_end TIME, closing_start TIME,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE shift_codes (
  id SERIAL PRIMARY KEY, code TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
  shift_id INT REFERENCES shifts(id),
  category TEXT NOT NULL CHECK (category IN ('work','off','leave','other')),
  counts_as_working BOOLEAN NOT NULL DEFAULT TRUE, color TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE staff (
  id SERIAL PRIMARY KEY, staff_code TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL,
  position TEXT, phone TEXT,
  employment_status TEXT NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active','inactive')),
  normal_shift_code_id INT REFERENCES shift_codes(id),
  availability JSONB NOT NULL DEFAULT '{}',
  leave_balance_annual NUMERIC(5,1) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY, staff_id INT REFERENCES staff(id) ON DELETE SET NULL,
  username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','supervisor','staff')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE residences (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, location TEXT, cleaning_areas TEXT,
  room_count INT CHECK (room_count >= 0), cleaning_frequency TEXT, special_requirements TEXT, notes TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE residence_staff (
  residence_id INT REFERENCES residences(id) ON DELETE CASCADE,
  staff_id INT REFERENCES staff(id) ON DELETE CASCADE,
  PRIMARY KEY (residence_id, staff_id)
);

CREATE TABLE duties (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('opening','main','closing')),
  default_residence_id INT REFERENCES residences(id), active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rosters (
  id SERIAL PRIMARY KEY, year INT NOT NULL, month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  published_by INT REFERENCES users(id), published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (year, month)
);
CREATE TABLE roster_assignments (
  id SERIAL PRIMARY KEY, roster_id INT NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
  staff_id INT NOT NULL REFERENCES staff(id), work_date DATE NOT NULL,
  shift_code_id INT NOT NULL REFERENCES shift_codes(id),
  residence_id INT REFERENCES residences(id), duty_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (roster_id, staff_id, work_date)
);
CREATE TABLE assignment_duties (
  assignment_id INT REFERENCES roster_assignments(id) ON DELETE CASCADE,
  duty_id INT REFERENCES duties(id), sort_order INT NOT NULL DEFAULT 0,
  task_status TEXT NOT NULL DEFAULT 'open' CHECK (task_status IN ('open','done','skipped')),
  PRIMARY KEY (assignment_id, duty_id)
);

CREATE TABLE leave (
  id SERIAL PRIMARY KEY, staff_id INT NOT NULL REFERENCES staff(id),
  leave_type TEXT NOT NULL CHECK (leave_type IN ('annual','sick','emergency','other')),
  start_date DATE NOT NULL, end_date DATE NOT NULL, CHECK (end_date >= start_date),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  approved_by INT REFERENCES users(id), notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE attendance (
  id SERIAL PRIMARY KEY, assignment_id INT NOT NULL UNIQUE REFERENCES roster_assignments(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('present','absent','late','sick','leave','off','replacement')),
  reported_at TIMESTAMPTZ, marked_by INT REFERENCES users(id), notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE handover_records (
  id SERIAL PRIMARY KEY, work_date DATE NOT NULL,
  from_shift_id INT REFERENCES shifts(id), to_shift_id INT REFERENCES shifts(id),
  completed_by INT REFERENCES users(id), completed_at TIMESTAMPTZ,
  cleaning_done TEXT, pending_work TEXT, special_instructions TEXT, residence_status TEXT,
  maintenance_issues TEXT, requests TEXT, supplies_needed TEXT, follow_up_areas TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE replacements (
  id SERIAL PRIMARY KEY, assignment_id INT REFERENCES roster_assignments(id),
  original_staff_id INT NOT NULL REFERENCES staff(id), replacement_staff_id INT NOT NULL REFERENCES staff(id),
  work_date DATE NOT NULL, shift_id INT REFERENCES shifts(id), residence_id INT REFERENCES residences(id),
  reason TEXT, recorded_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, message TEXT NOT NULL, read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY, user_id INT REFERENCES users(id), occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  staff_id INT REFERENCES staff(id), work_date DATE, entity TEXT,
  old_value TEXT, new_value TEXT, reason TEXT
);

CREATE TABLE system_settings (
  key TEXT PRIMARY KEY, value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE staff_requirements (
  id SERIAL PRIMARY KEY, staff_id INT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('date','weekday')),   -- fixed day off: one date, or every given weekday
  req_date DATE, weekday INT CHECK (weekday BETWEEN 0 AND 6),  -- 0 = Sunday
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'date' AND req_date IS NOT NULL) OR (kind = 'weekday' AND weekday IS NOT NULL))
);

CREATE INDEX idx_assign_date ON roster_assignments (work_date);
CREATE INDEX idx_assign_staff ON roster_assignments (staff_id, work_date);
CREATE INDEX idx_leave_staff ON leave (staff_id, start_date, end_date);
CREATE INDEX idx_audit_time ON audit_logs (occurred_at);

-- Keep updated_at current
CREATE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;
DO $$ DECLARE t TEXT; BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'updated_at' LOOP
    EXECUTE format('CREATE TRIGGER trg_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t);
  END LOOP;
END $$;

-- Seed data (all editable from Settings)
INSERT INTO shifts (name,start_time,end_time,report_time,opening_start,opening_end,handover_start,handover_end,closing_start) VALUES
 ('A','07:00','15:00','06:45','07:00','08:00','15:00','15:15','15:15'),
 ('B','15:00','23:00','14:45',NULL,NULL,'15:00','15:15','15:15');

INSERT INTO shift_codes (code,label,shift_id,category,counts_as_working,color) VALUES
 ('A','Morning shift',(SELECT id FROM shifts WHERE name='A'),'work',TRUE,'#cfe8e4'),
 ('B','Afternoon / closing shift',(SELECT id FROM shifts WHERE name='B'),'work',TRUE,'#fbe3b8'),
 ('3PM','3:00 PM duty',NULL,'work',TRUE,'#d9d4f3'),
 ('OFF','Off day',NULL,'off',FALSE,'#e3e6ea'),
 ('L','Leave',NULL,'leave',FALSE,'#f7cfd4');

INSERT INTO system_settings (key,value) VALUES
 ('monthly_off_days','4'),('max_consecutive_days','8'),
 ('min_staff_a','2'),('min_staff_b','1'),
 ('rotation_pattern','["A","A","OFF"]'),
 ('department_name','"Executive Residences Housekeeping"'),
 ('manager','""'),('supervisor','""');

COMMIT;
