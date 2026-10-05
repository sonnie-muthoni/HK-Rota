# Housekeeping Roster: setup and test guide

Use a **test database** first. Do not point this at real data until the checklist below passes.

## 1. What you need

- Node.js 18 or newer
- PostgreSQL 14 or newer
- The files from this folder plus `../schema.sql`

## 2. Set up

1. Create an empty database:
   `createdb roster_test`
2. Load the tables and starting data:
   `psql roster_test -f ../schema.sql`
   If you see errors, stop and send them to me. Do not continue.
3. Install the packages, from inside `roster-api`:
   `npm install`
4. Set the connection and a secret (replace the values):
   - Mac or Linux:
     `export DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/roster_test`
     `export JWT_SECRET=$(openssl rand -hex 32)`
   - Windows PowerShell:
     `$env:DATABASE_URL="postgres://USER:PASSWORD@localhost:5432/roster_test"`
     `$env:JWT_SECRET="paste-a-long-random-text-here"`
5. Create the first admin:
   `node create-user.js admin YourPassword admin`
6. Start it:
   `npm start`
7. Open `http://localhost:3000` and log in as `admin`.

If you loaded `schema.sql` before the Fixed days off feature was added, also run:
`psql roster_test -f migrations/002_staff_requirements.sql`

## 3. Roster and department settings

These are now on the **Settings** tab (off days, most days in a row, rotation pattern, department, manager, supervisor). If you prefer SQL:

```sql
-- department name shown at the top and on printouts
UPDATE system_settings SET value = '"Executive Residences Housekeeping"' WHERE key = 'department_name';
-- off days per month, and most days in a row someone may work
UPDATE system_settings SET value = '4' WHERE key = 'monthly_off_days';
UPDATE system_settings SET value = '8' WHERE key = 'max_consecutive_days';
```

Shift times and the minimum staff per shift are on the **Settings** tab.

## 4. Test data to enter first

1. **Staff tab:** add at least 6 people (IDs like HK001). Set the normal shift to A for most and B for one or two.
2. **Residences tab:** add two residences and assign staff.
3. **Duties tab:** add 5 or 6 duties, for example "Ground reception mopping and dusting" (main), "Prepare cleaning equipment" (opening), "Final inspection" (closing).
4. **Settings tab:** set minimum staff, for example A = 2 and B = 1.
5. Create two more logins for the later tests:
   `node create-user.js supervisor1 Pass123 supervisor`
   `node create-user.js aisha Pass123 staff HK002` (use a real staff ID)

## 5. Test checklist

Tick each line. Write down anything that fails: what you clicked, what you expected, what happened.

**Stage 1: staff and residences**
- [ ] Add, edit, deactivate and remove a staff member.
- [ ] A duplicate staff ID is refused with a clear message.
- [ ] Residences save with their assigned staff.

**Stage 2 and 3: roster and shifts**
- [ ] Monthly roster opens for the current month with the right number of dates and weekdays.
- [ ] Try February 2028 (29 days) and a 30-day month.
- [ ] Click a cell, choose A, save. The colour and summary update.
- [ ] Shift times line above the grid matches the Settings tab. Change a time in Settings and see it change.
- [ ] Coverage rows go red on a day below the minimum.

**Stage 4: off days**
- [ ] Give one person 4 OFF days, then try a fifth. As admin you get an override prompt. As supervisor1 you are told to ask a manager.
- [ ] The override shows in the audit table (see section 6).

**Stage 5: leave**
- [ ] Record leave on the Leave tab. L appears on the roster for those dates.
- [ ] Try setting A on a leave day. It is blocked.
- [ ] Remove the leave. The L days clear.

**Stage 6: duties**
- [ ] Open a cell, tick two duties, save, reopen. The ticks are still there.

**Stage 7: today, attendance, handover**
- [ ] Publish the roster first (Publish roster button).
- [ ] On the Today tab, mark someone Sick. "Assign replacement" appears.
- [ ] Assign someone who is OFF. Someone already working is not offered.
- [ ] Tick a task. The count changes.
- [ ] Record a handover. It shows who and when.

**Stage 8: generate and check**
- [ ] On an empty month, click Generate monthly rota with all staff.
- [ ] Everyone gets the right number of OFF days and every day meets the minimums (or the check explains why not).
- [ ] Generate with "Rotation pattern" set to A, B: staff alternate between A and B from one block to the next, and the minimums are still met.
- [ ] Run Generate again without "Replace existing": manual edits are kept.
- [ ] Check roster lists problems you create on purpose (blank day, too many OFF).

**Fixed days off (Leave tab)**
- [ ] Add "Every Sunday" for one person, then Generate a month. Every Sunday is OFF for them.
- [ ] Add a specific date. That date is OFF.
- [ ] Manually set a working shift on a fixed day off, then Check roster. It is flagged.
- [ ] Add 5 Sundays' worth of fixed days (a month with 5 Sundays) with the off days set to 4. Generation shows a note that they exceed the monthly off days.

**Roster codes tab**
- [ ] Add a code TRN (Training, type Other, pick a colour). It appears in the cell picker, the legend and the grid in that colour.
- [ ] Link 3PM to Shift A. A 3PM cell now counts toward A coverage.
- [ ] Try to remove A: refused. Try to remove a code used on the roster: refused with a clear message.

**Stage 9: print and export**
- [ ] Print monthly rota: landscape, header, legend, shift times, notes. Try A4 and A3.
- [ ] Export Excel opens with three sheets (Roster, Summary, Duties).
- [ ] Export PDF opens and fits the page.

**Stage 10: staff and dashboard**
- [ ] Log in as `aisha`. She sees only Today's duty, with her own shift, duties, next working day and next off day.
- [ ] She can tick her own tasks.
- [ ] If the roster is unpublished, she sees "No duty scheduled".
- [ ] Dashboard numbers match what you see on Today and the roster.

**Roles**
- [ ] supervisor1 can use Today and edit roster cells but cannot publish, add staff or open Settings.

## 6. Audit trail

Open the **Audit trail** tab (admin and manager). Filter by staff, type and dates. Roster changes read like "supervisor1 (supervisor) changed Aisha from OFF to A on 15 August 2026."

- [ ] Change a cell, then find it in the audit trail with the right user, old value, new value and reason.
- [ ] Filters work, and "Show older" loads more after 50 entries.
- [ ] A supervisor does not see the Audit trail tab.

## 7. Before real use

- Serve it over HTTPS (behind a reverse proxy such as Nginx or Caddy).
- Use a long random `JWT_SECRET` and keep it out of the code.
- Change the admin password and remove test users.
- Schedule database backups (`pg_dump`).

## 8. Known gaps

- Rotation pattern: choose it in the Generate dialog. Working shifts take turns block by block between off days. OFF entries in the pattern are ignored.
- Special requirements are limited to fixed days off (a date or a weekday). There is no fixed-shift or fixed-residence requirement.
- No screen or alerts for notifications (the table exists but is unused).
