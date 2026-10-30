# Students Campus Laundry Booking and Management System

Students book washers and dryers online instead of queuing, get notified when their slot is near and when their laundry is done, read laundry tips, and give feedback. The administrator manages the laundry rooms and machines, handles feedback and sees booking history and usage reports.

**Group members:** Asemahle Sokaba · Avuziwe Mcata
**Roles:** System Analyst · Database Designer · Developer · Presenter
**Stack:** HTML/CSS/JavaScript · Node.js + Express · MySQL 8.4 · **Schema version:** 1.0

## Documents

| File | What it is |
|---|---|
| [docs/Laundry-User-Manual.docx](docs/Laundry-User-Manual.docx) (+ `.pdf`) | Installation and user manual: installing on a computer, student guide and administrator guide, with screenshots |
| [docs/Laundry-Test-Report.docx](docs/Laundry-Test-Report.docx) (+ `.pdf`) | Test report: 171 automated tests, requirements coverage and defects found |

Rebuild them with `npm run docs:screenshots` then `npm run docs:manual`, and `npm run docs:test-report` (the app must be running; needs `npm install` with dev tools, Microsoft Edge and Word). The screenshot tool creates its own sample data and deletes it afterwards.

## Problems addressed

| Problem (Phase 1) | How the system solves it |
|---|---|
| Long queues and waiting times | Students book a machine for a time slot from their phone; a waiting list notifies the next student when a slot frees up |
| Poor scheduling of machines | Fixed time slots per laundry room; the database makes double bookings impossible; missed slots are released after 15 minutes |
| No notification when laundry is done | The student taps **Start cycle**; the system knows the machine's cycle time and sends "your laundry is done" automatically |
| Limited knowledge of laundry practices | Laundry tips on sorting, detergents, fabrics and machine care, maintained by the admin |
| No platform for feedback | Ratings (1–5 stars), comments and issue reports; the admin replies and can take a faulty machine out of service |

## Requirements coverage (Phase 2)

| Requirement | Where |
|---|---|
| Register and log in securely; roles Student and Admin | Registration with student number; bcrypt passwords; log in with email or student number |
| View available machines in real time; book a date and slot; prevent double bookings; cancel or reschedule | **Book a machine** grid; unique keys in MySQL; **My laundry** → Cancel / Reschedule |
| Reminders before the booking; "cycle done"; notify the next user when a machine is free | In-app notifications (🔔 on every page), sent by a background scheduler |
| Laundry tips: sorting, detergents, fabrics, maintenance | **Laundry tips** page; admin adds and edits tips |
| Rate the service or a machine; comments and issue reports; admin manages feedback | **Feedback** page; admin replies, changes status, marks machines out of order |
| Admin adds, edits, removes machines; booking history and usage reports; monitors feedback | **Machines & rooms**, **Bookings**, **Dashboard**, **Feedback** |
| Usability, performance, reliability, security, compatibility | Mobile-friendly pages; row locks and unique keys for simultaneous bookings; constraints and automated tests; hashed passwords, parameterised SQL; works in any modern browser |

## How a booking works

1. A student picks a laundry room and a day (today and the next 7 days) and clicks a free slot. At most 3 open bookings per student.
2. 30 minutes before the slot they get a **reminder**.
3. From 5 minutes before the slot, they load the machine and tap **Start cycle**. If they don't start within 15 minutes, the booking becomes a **no-show** and the slot is released (the waiting list is told).
4. When the machine's cycle time has passed, the booking becomes **Done** and the student is notified.
5. The student taps **Collected**. The student with the next booking on that machine today is told it is free.

Booking statuses: Booked → Washing/drying → Done → Collected (or Cancelled / Missed).

## Setup

1. Install **Node.js (LTS)** and **MySQL Server 8.4**.
2. Copy `.env.example` to `.env` and set `DB_PASSWORD` and a random `SESSION_SECRET`.
3. In this folder:

   ```
   npm install --omit=dev
   npm run db:setup
   npm run admin:create -- "Your Name" you@example.com
   npm start
   ```

4. Open <http://localhost:3003> and log in with the email and the temporary password printed by `admin:create`. Choose your own password.
5. As admin: **Machines & rooms → Laundry rooms** to add the laundry rooms and their opening hours, then **Machines** to add the washers and dryers. Students can now register and book.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Starts the app at http://localhost:3003 (and the scheduler for reminders, finished cycles and no-shows) |
| `npm run db:setup` | Creates the database or applies new migrations (never deletes data) |
| `npm run db:reset` | **Deletes** the database and creates an empty one |
| `npm run admin:create -- "Name" email` | Creates an administrator (or promotes an existing account) with a temporary password |
| `npm run admin:reset-password -- email` | Gives anyone a temporary password (e.g. the only admin forgot theirs) |
| `npm run db:check` | Checks `db/schema.sql` matches the database and that 43 integrity rules are enforced by MySQL (test rows are rolled back) |
| `npm run test:api` | 84 end-to-end tests as admin and students (app must be running; all test data is removed afterwards) |
| `npm run test:ui` | 34 browser tests: the real pages in Microsoft Edge as a student and an admin, including a phone-sized screen |
| `npm run test:load` | 9 concurrency and performance tests: 30 students booking at the same moment, response times |
| `npm test` | Runs every test suite (app must be running) |
| `npm run docs:test-report` | Runs everything and writes [docs/Laundry-Test-Report.docx](docs/Laundry-Test-Report.docx) (+ `.pdf`) |
| `npm run sample:seed` / `sample:clean` | Adds / removes fictional demonstration data (`@sample.test` accounts, three laundry rooms, two weeks of history) |
| `npm run db:inspect` | Lists every key, index and constraint in the live database |

## Database

9 tables (plus `schema_migrations`). Core tables from the requirements: `users`, `machines`, `bookings`, `notifications`, `laundry_tips`, `feedback`. Extension tables: `laundry_rooms`, `waitlist_entries`, `machine_outages`.

- **Double bookings are impossible in the database itself:** a generated column `slot_lock` holds the slot start for a live booking and NULL for a cancelled or missed one; `(machine_id, booking_date, slot_lock)` is unique, and so is `(user_id, booking_date, slot_lock)`, so a student can't hold two machines at once either.
- A machine is out of order while it has an open `machine_outages` row; at most one open outage per machine (unique key on a generated column).
- Each booking gets each kind of notification at most once (`uq_notifications_booking_kind`), so the scheduler can safely run again and again.
- Named constraints throughout: `fk_<table>_<target>`, `uq_<table>_<cols>`, `idx_<table>_<col>`, `chk_<table>_<rule>`; CHECK constraints keep booking times consistent with the status (started, finished, collected, cancelled).
- `ON DELETE RESTRICT` for rooms with machines and machines with bookings; `SET NULL` keeps booking history and feedback when a student leaves; `CASCADE` removes their notifications and waiting-list places.
- Full creation script: [db/schema.sql](db/schema.sql). Upgrades: [db/migrations/](db/migrations).

## Project structure

```
server.js              Express app, sessions, readable database errors, starts the scheduler
routes/                auth, rooms (availability grid), machines, bookings, waitlist, notifications, tips, feedback, admin, stats
lib/                   account helpers, login/role middleware, input validation, laundry rules and scheduler
db/                    schema.sql, migrations/, setup.js, pool.js
public/                Web pages: login, book, my laundry, notifications, tips, feedback, dashboard, bookings, machines, people, profile
tools/                 admin commands, schema comparison, constraint and API tests, sample data
```
