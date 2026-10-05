-- Run once on a database created before special requirements were added:
-- psql DBNAME -f migrations/002_staff_requirements.sql
BEGIN;
CREATE TABLE staff_requirements (
  id SERIAL PRIMARY KEY, staff_id INT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('date','weekday')),   -- fixed day off: one date, or every given weekday
  req_date DATE, weekday INT CHECK (weekday BETWEEN 0 AND 6),  -- 0 = Sunday
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'date' AND req_date IS NOT NULL) OR (kind = 'weekday' AND weekday IS NOT NULL))
);
CREATE TRIGGER trg_touch BEFORE UPDATE ON staff_requirements FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
COMMIT;
