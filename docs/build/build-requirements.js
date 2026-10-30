// Builds docs/Laundry-Requirements.docx: the requirements specification of the Campus Laundry
// system (Phase 1 problem and objectives, Phase 2 functional and non-functional requirements),
// with the crow's-foot ERD, the relationships and a data dictionary read from the database.
// Black and white on purpose (printable, no colour).
// Needs the ERD images from tools/erd.js.
// Usage: npm run docs:requirements   (builds the document, fills in the contents page and saves a PDF)
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, PageBreak, TableOfContents, Footer, ImageRun, AlignmentType } = require('docx');
const helpers = require('./docx-helpers');
const pool = require('../../db/pool');

// Black and white: headings, table headers and boxes use black and greys only.
Object.assign(helpers.COLOR, {
  primary: '000000', accent: '000000', muted: '595959', rowAlt: 'F2F2F2', code: 'F2F2F2',
  border: '808080', tip: 'F2F2F2', warn: 'F2F2F2', headerFill: 'D9D9D9', headerText: '000000',
});
const { COLOR, PORTRAIT_W, p, h1, h2, bullets, box, table, makeFigure, documentStyles, footer } = helpers;

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'Laundry-Requirements.docx');
const VERSION = require(path.join(ROOT, 'package.json')).version;
const DATE = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const figure = makeFigure(ROOT);
const DB = process.env.DB_NAME || 'campus_laundry';

for (const f of ['laundry-erd-conceptual.png', 'laundry-erd-physical.png']) {
  if (!fs.existsSync(path.join(ROOT, 'docs', 'erd', f))) {
    console.error(`docs/erd/${f} is missing. Run "node tools/erd.js" first.`);
    process.exit(1);
  }
}

// ------------------------------------------------------------------ requirements
// [id, requirement, priority, how the system meets it]
const FUNCTIONAL = [
  ['1. User management', [
    ['FR-01', 'Students register with their full name, student number, email and a password.', 'Must',
      'Registration page. Student number 8–10 digits, password at least 8 characters; optional home laundry room and phone.'],
    ['FR-02', 'Users log in securely.', 'Must', 'Log in with email or student number. Passwords stored only as bcrypt hashes; session cookie (http-only, 8 hours).'],
    ['FR-03', 'The system supports the roles Student and Admin.', 'Must', 'Role stored per user and checked on every request; each role sees only its own menu and pages.'],
    ['FR-04', 'Users manage their own profile.', 'Should', 'Change name, email, home room, phone and password; students can delete their own account.'],
    ['FR-05', 'The administrator manages accounts.', 'Should', 'People page: make another admin, deactivate/reactivate, reset a password (temporary password that must be changed), delete.'],
  ]],
  ['2. Machine booking and scheduling', [
    ['FR-06', 'Students view available laundry machines in real time.', 'Must', 'Booking grid per laundry room and day (today and the next 7 days): free, taken, own and out-of-order slots.'],
    ['FR-07', 'Students book a machine for a specific date and time slot.', 'Must', 'Fixed time slots per room (slot length set by the admin); click a free slot and confirm.'],
    ['FR-08', 'Double bookings of the same machine are prevented.', 'Must', 'Unique key on (machine, date, slot) in the database; a student also cannot hold two machines at the same time.'],
    ['FR-09', 'Students cancel or reschedule a booking.', 'Must', 'My laundry → Cancel or Reschedule, until the slot starts. The freed slot goes to the waiting list.'],
    ['FR-10', 'Fair use of machines.', 'Should', 'At most 3 open bookings per student; a booking not started within 15 minutes becomes a no-show and the machine is released.'],
    ['FR-11', 'Students record the start and end of their laundry.', 'Must', 'Start cycle (from 5 minutes before to 15 minutes after the slot starts) and Collected; the cycle time comes from the machine.'],
    ['FR-12', 'Students join a waiting list when a room is fully booked.', 'Should', 'Waiting list per room, day and machine type; the first student in line is told when a slot frees up.'],
  ]],
  ['3. Notifications', [
    ['FR-13', 'Send a reminder when the booking time is approaching.', 'Must', 'In-app reminder 30 minutes before the slot, sent by a background scheduler.'],
    ['FR-14', 'Notify the user when their laundry cycle is done.', 'Must', '"Your laundry is done" when the machine\'s cycle time has passed after Start cycle.'],
    ['FR-15', 'Notify the next user when a machine becomes free.', 'Must', 'After Collected, the student with the next booking on that machine today is told; freed slots go to the waiting list.'],
    ['FR-16', 'Users see and manage their notifications.', 'Should', 'Bell with unread count on every page; notifications page with Open, Mark read, Mark all as read, Delete.'],
    ['FR-17', 'Users are told about changes made by the administrator.', 'Should', 'Notifications when a booking is cancelled (e.g. machine out of order), a slot is missed, or feedback is answered.'],
  ]],
  ['4. Laundry tips', [
    ['FR-18', 'Provide guidelines on sorting clothes, choosing detergents, washing fabric types and machine maintenance.', 'Must', 'Laundry tips page with the four categories and a filter; 8 tips included at installation.'],
    ['FR-19', 'The administrator maintains the tips.', 'Should', 'Add, edit, delete and publish/unpublish tips (drafts are hidden from students).'],
  ]],
  ['5. Feedback system', [
    ['FR-20', 'Students rate the service or a machine\'s condition.', 'Must', 'Rating of 1 to 5 stars for a laundry room or a single machine.'],
    ['FR-21', 'Students submit comments or report issues.', 'Must', 'Comment and issue forms; an issue needs a room and a description.'],
    ['FR-22', 'The administrator views and manages feedback.', 'Must', 'Feedback page (open first): reply, set status New / Being looked at / Resolved / Closed; the student is notified. Closing needs a reply.'],
  ]],
  ['6. Management and administration', [
    ['FR-23', 'The administrator adds, edits and removes machines.', 'Must', 'Machines page. A machine that was used is retired (kept for history) instead of deleted.'],
    ['FR-24', 'The administrator manages laundry rooms.', 'Should', 'Rooms with opening hours and slot length; hours can only change when no bookings are upcoming.'],
    ['FR-25', 'The administrator marks machines out of order.', 'Should', 'Reason recorded; the machine can\'t be booked, its upcoming bookings are cancelled and the students notified; outage history kept.'],
    ['FR-26', 'The administrator views booking history.', 'Must', 'Bookings page with filters (student, dates, room, status); the admin can cancel an upcoming booking.'],
    ['FR-27', 'The administrator views usage reports.', 'Must', 'Dashboard: today\'s activity and, for 7/30/90 days, bookings, loads, cancellations, no-show rate, average rating, use per day, hour, machine and room.'],
    ['FR-28', 'The administrator monitors feedback and takes action.', 'Must', 'Open issues on the dashboard; an issue about a machine can take it out of order in one step.'],
  ]],
];

// [id, quality, requirement, how it is met and verified]
const NON_FUNCTIONAL = [
  ['NFR-01', 'Usability', 'The interface is simple, mobile-friendly and easy for students to use.',
    'Plain-language pages with a menu (a tab bar on phones). Verified: browser tests at 1280 px and on a 375 px phone screen (no sideways scrolling).'],
  ['NFR-02', 'Performance', 'The system loads quickly and handles many users booking at the same time.',
    'Targets: availability grid under 300 ms for 95% of requests; 30 students opening "My laundry" at once answered within 2 s; a page in under 200 ms. Verified by the load tests.'],
  ['NFR-03', 'Reliability', 'Booking data and notifications are accurate and consistent.',
    'Database constraints (unique keys, CHECK rules, foreign keys); transactions with row locks; each notification sent at most once. Verified: 30 simultaneous bookings of one slot → exactly one succeeds.'],
  ['NFR-04', 'Security', 'User data and passwords are stored securely.',
    'bcrypt password hashes; http-only session cookie; parameterised SQL; role and account status re-checked on every request; temporary passwords must be changed.'],
  ['NFR-05', 'Compatibility', 'Works in web browsers and on mobile devices.',
    'Standard HTML/CSS/JavaScript; works in current Edge, Chrome and Firefox and on phones on the same network.'],
  ['NFR-06', 'Maintainability', 'The database can be changed without losing data.',
    'Versioned migrations (db/migrations) recorded in schema_migrations; a full creation script (db/schema.sql) checked against the live database.'],
  ['NFR-07', 'Availability of data', 'History is kept when people leave or machines are removed.',
    'Deleting an account keeps its bookings and feedback ("former student"); used machines are retired, not deleted.'],
];

const BUSINESS_RULES = [
  'A booking is for one machine, one day and one slot of the room\'s fixed slot length (30–240 minutes).',
  'Bookings can be made for today and up to 7 days ahead, only inside the room\'s opening hours and never in the past.',
  'A student has at most 3 open bookings and cannot book two machines for the same time.',
  'A machine\'s cycle time (10–240 minutes) must fit inside one slot.',
  'Start cycle is possible from 5 minutes before the slot until 15 minutes after it starts; after that the booking is a no-show.',
  'Booking status flow: Booked → Washing/drying → Done → Collected, or Cancelled / No-show.',
  'A machine has at most one open outage; while it is out of order it cannot be booked.',
  'Feedback of kind "rating" has 1–5 stars; comments and issues have a description of at least 5 characters.',
  'Each booking gets each kind of notification at most once.',
  'Only students have a student number, and every student has one.',
];

// ------------------------------------------------------------------ data dictionary text
const TABLES = {
  users: ['Everyone who can log in: students and administrators.', 'requirements'],
  laundry_rooms: ['A laundry room with its opening hours and slot length.', 'design: several laundry rooms'],
  machines: ['A washer or dryer in a laundry room.', 'requirements'],
  bookings: ['A student\'s booking of one machine for one slot, and what happened to it.', 'requirements'],
  notifications: ['A message to one user (reminder, cycle done, machine free …).', 'requirements'],
  waitlist_entries: ['A student waiting for a washer or dryer in a room on a day.', 'design: waiting list'],
  machine_outages: ['A period during which a machine is out of order.', 'design: out-of-order machines'],
  laundry_tips: ['A laundry tip in one of the four categories.', 'requirements'],
  feedback: ['A rating, comment or issue from a student, and the administrator\'s reply.', 'requirements'],
};
const COLUMNS = {
  'users.id': 'Unique number of the user',
  'users.full_name': 'Full name (at least 2 characters)',
  'users.email': 'Email address, used to log in',
  'users.student_number': 'Student number, 8–10 digits (students only); also used to log in',
  'users.password_hash': 'bcrypt hash of the password (the password itself is never stored)',
  'users.must_change_password': 'True after a reset: the user must choose a new password first',
  'users.role': 'student or admin',
  'users.room_id': 'Home laundry room, opened first when booking',
  'users.phone': 'Phone number (optional)',
  'users.is_active': 'False when the administrator deactivated the account',
  'users.created_at': 'When the account was created',
  'laundry_rooms.id': 'Unique number of the room',
  'laundry_rooms.name': 'Name, e.g. "Residence A Laundry"',
  'laundry_rooms.location': 'Where it is (optional)',
  'laundry_rooms.opens_at': 'Opening time',
  'laundry_rooms.closes_at': 'Closing time (after opening time)',
  'laundry_rooms.slot_minutes': 'Length of one booking slot, 30–240 minutes',
  'laundry_rooms.is_active': 'False when the room is closed for bookings',
  'laundry_rooms.created_at': 'When the room was added',
  'machines.id': 'Unique number of the machine',
  'machines.room_id': 'Room the machine is in',
  'machines.code': 'Short code written on the machine, e.g. W1 (unique in its room)',
  'machines.kind': 'washer or dryer',
  'machines.cycle_minutes': 'Length of one cycle, 10–240 minutes',
  'machines.is_active': 'False when the machine is retired',
  'machines.created_at': 'When the machine was added',
  'bookings.id': 'Unique number of the booking',
  'bookings.user_id': 'Student who booked (empty if the account was deleted)',
  'bookings.machine_id': 'Machine booked',
  'bookings.booking_date': 'Day of the booking',
  'bookings.slot_start': 'Start of the slot',
  'bookings.slot_end': 'End of the slot (after the start)',
  'bookings.status': 'booked, in_progress, done, collected, cancelled or no_show',
  'bookings.started_at': 'When Start cycle was tapped',
  'bookings.finishes_at': 'When the cycle finishes (start + cycle time)',
  'bookings.collected_at': 'When Collected was tapped',
  'bookings.cancelled_at': 'When the booking was cancelled',
  'bookings.created_at': 'When the booking was made',
  'bookings.updated_at': 'When the booking last changed',
  'bookings.slot_lock': 'Generated: the slot start for a live booking, empty when cancelled or missed (makes double bookings impossible)',
  'notifications.id': 'Unique number of the notification',
  'notifications.user_id': 'Who receives it',
  'notifications.booking_id': 'Booking it is about (optional)',
  'notifications.kind': 'reminder, cycle_done, machine_free, booking_cancelled, no_show or feedback_reply',
  'notifications.message': 'Text shown to the user',
  'notifications.created_at': 'When it was sent',
  'notifications.read_at': 'When it was read (empty = unread)',
  'waitlist_entries.id': 'Unique number of the entry',
  'waitlist_entries.user_id': 'Student waiting',
  'waitlist_entries.room_id': 'Room',
  'waitlist_entries.wait_date': 'Day',
  'waitlist_entries.kind': 'washer or dryer',
  'waitlist_entries.created_at': 'When the student joined (decides the order)',
  'waitlist_entries.notified_at': 'When the student was told a machine is free',
  'machine_outages.id': 'Unique number of the outage',
  'machine_outages.machine_id': 'Machine that is out of order',
  'machine_outages.reason': 'Why (at least 5 characters)',
  'machine_outages.reported_by': 'Administrator who recorded it',
  'machine_outages.started_at': 'When it went out of order',
  'machine_outages.ended_at': 'When it was back in service (empty = still out of order)',
  'machine_outages.open_flag': 'Generated: 1 while the outage is open (allows only one open outage per machine)',
  'laundry_tips.id': 'Unique number of the tip',
  'laundry_tips.category': 'sorting, detergents, fabrics or maintenance',
  'laundry_tips.title': 'Title (unique)',
  'laundry_tips.body': 'The tip (at least 20 characters)',
  'laundry_tips.is_published': 'False for a draft that students don\'t see',
  'laundry_tips.created_by': 'Administrator who wrote it',
  'laundry_tips.created_at': 'When it was written',
  'laundry_tips.updated_at': 'When it was last changed',
  'feedback.id': 'Unique number of the feedback',
  'feedback.user_id': 'Student who sent it',
  'feedback.room_id': 'Laundry room it is about',
  'feedback.machine_id': 'Machine it is about (optional)',
  'feedback.kind': 'rating, comment or issue',
  'feedback.rating': '1–5 stars (ratings only)',
  'feedback.comment': 'Comment or description of the issue',
  'feedback.status': 'new, in_progress, resolved or dismissed',
  'feedback.admin_response': 'The administrator\'s reply',
  'feedback.responded_by': 'Administrator who replied',
  'feedback.responded_at': 'When the reply was sent',
  'feedback.created_at': 'When the feedback was sent',
};
const RELATIONSHIP_TEXT = {
  fk_users_room: ['laundry_rooms', 'is home room of', 'users'],
  fk_machines_room: ['laundry_rooms', 'contains', 'machines'],
  fk_bookings_machine: ['machines', 'is booked in', 'bookings'],
  fk_bookings_user: ['users', 'makes', 'bookings'],
  fk_notifications_user: ['users', 'receives', 'notifications'],
  fk_notifications_booking: ['bookings', 'triggers', 'notifications'],
  fk_waitlist_entries_user: ['users', 'joins', 'waitlist_entries'],
  fk_waitlist_entries_room: ['laundry_rooms', 'has waiting list', 'waitlist_entries'],
  fk_machine_outages_machine: ['machines', 'has outages', 'machine_outages'],
  fk_machine_outages_reported_by: ['users', 'reports', 'machine_outages'],
  fk_laundry_tips_created_by: ['users', 'writes', 'laundry_tips'],
  fk_feedback_user: ['users', 'gives', 'feedback'],
  fk_feedback_room: ['laundry_rooms', 'receives', 'feedback'],
  fk_feedback_machine: ['machines', 'is rated in', 'feedback'],
  fk_feedback_responded_by: ['users', 'responds to', 'feedback'],
};
const ON_DELETE = {
  RESTRICT: 'Not allowed while children exist',
  CASCADE: 'Children are deleted too',
  'SET NULL': 'Children are kept; the link becomes empty',
};
const CHECK_TEXT = {
  chk_users_full_name: 'Full name has at least 2 characters',
  chk_users_email: 'Email looks like name@domain.tld',
  chk_users_student_number: 'Student number is 8–10 digits',
  chk_users_student_has_number: 'Every student has a student number',
  chk_users_phone: 'Phone has 7–20 digits, spaces, +, - or brackets',
  chk_laundry_rooms_name: 'Room name has at least 2 characters',
  chk_laundry_rooms_hours: 'Closing time is after opening time',
  chk_laundry_rooms_slot: 'Slot length is 30–240 minutes',
  chk_machines_code: 'Machine code is not empty',
  chk_machines_cycle: 'Cycle time is 10–240 minutes',
  chk_bookings_times: 'Slot end is after slot start',
  chk_bookings_started: 'A start time exists exactly when the status is in progress, done or collected',
  chk_bookings_finishes: 'Start and finish times come together, and the finish is after the start',
  chk_bookings_collected: 'A collection time exists exactly when the status is collected',
  chk_bookings_cancelled: 'A cancellation time exists exactly when the status is cancelled',
  chk_notifications_message: 'Message has at least 5 characters',
  chk_machine_outages_reason: 'Reason has at least 5 characters',
  chk_machine_outages_period: 'An outage ends after it starts',
  chk_laundry_tips_title: 'Tip title has at least 5 characters',
  chk_laundry_tips_body: 'Tip text has at least 20 characters',
  chk_feedback_rating: 'Rating is 1–5',
  chk_feedback_rating_kind: 'A rating exists exactly when the kind is "rating"',
  chk_feedback_comment: 'Comments and issues have a description of at least 5 characters',
  chk_feedback_response: 'A reply and its time come together',
};
const UNIQUE_TEXT = {
  uq_users_email: 'One account per email',
  uq_users_student_number: 'One account per student number',
  uq_laundry_rooms_name: 'Room names are unique',
  uq_machines_room_code: 'Machine codes are unique within a room',
  uq_bookings_machine_slot: 'A machine can\'t be booked twice for the same slot (ignores cancelled and missed bookings)',
  uq_bookings_user_slot: 'A student can\'t hold two machines at the same time',
  uq_notifications_booking_kind: 'Each kind of notification is sent once per booking',
  uq_waitlist_entries_user_room_date_kind: 'A student joins a waiting list once',
  uq_machine_outages_machine_open: 'At most one open outage per machine',
  uq_laundry_tips_title: 'Tip titles are unique',
};
const TRACE = [
  ['FR-01 – FR-05', 'users', 'Register / Log in, Profile, People'],
  ['FR-06 – FR-11', 'laundry_rooms, machines, bookings', 'Book a machine, My laundry'],
  ['FR-12', 'waitlist_entries', 'Book a machine, My laundry'],
  ['FR-13 – FR-17', 'notifications', 'Bell, Notifications'],
  ['FR-18 – FR-19', 'laundry_tips', 'Laundry tips'],
  ['FR-20 – FR-22', 'feedback', 'Feedback'],
  ['FR-23 – FR-25', 'machines, laundry_rooms, machine_outages', 'Machines & rooms'],
  ['FR-26 – FR-28', 'bookings, feedback (read)', 'Dashboard, Bookings, Feedback'],
];

// The physical ERD as a vector image (SVG, with the PNG for programs that can't show SVG),
// as wide as the narrow-margin page allows.
const SECTION_BREAK = Symbol('section break');
const NARROW_MARGIN = 720; // 0.5 inch
function physicalErd() {
  const base = path.join(ROOT, 'docs', 'erd', 'laundry-erd-physical');
  const png = fs.readFileSync(`${base}.png`);
  const svg = fs.readFileSync(`${base}.svg`);
  const ratio = png.readUInt32BE(20) / png.readUInt32BE(16);
  const width = Math.floor((11906 - 2 * NARROW_MARGIN) * 96 / 1440);
  return [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 }, keepNext: true, children: [new ImageRun({
      type: 'svg', data: svg, fallback: { type: 'png', data: png }, transformation: { width, height: Math.round(width * ratio) },
    })] }),
    p('Figure 2: Physical ERD (crow\'s foot) with columns and keys', { run: { italics: true, size: 18, color: COLOR.muted }, para: { alignment: AlignmentType.CENTER } }),
  ];
}

async function readSchema() {
  const [columns] = await pool.query(`
    SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE = 'YES' AS nullable, COLUMN_KEY AS col_key
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> 'schema_migrations' ORDER BY TABLE_NAME, ORDINAL_POSITION`, [DB]);
  const [fks] = await pool.query(`
    SELECT k.CONSTRAINT_NAME AS name, k.TABLE_NAME AS child, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_NAME AS parent, r.DELETE_RULE AS on_delete
    FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
    WHERE k.TABLE_SCHEMA = ? ORDER BY k.CONSTRAINT_NAME`, [DB]);
  const [checks] = await pool.query(`
    SELECT tc.TABLE_NAME AS tbl, cc.CONSTRAINT_NAME AS name FROM information_schema.CHECK_CONSTRAINTS cc
    JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
    WHERE cc.CONSTRAINT_SCHEMA = ? ORDER BY tc.TABLE_NAME, cc.CONSTRAINT_NAME`, [DB]);
  const [uniques] = await pool.query(`
    SELECT TABLE_NAME AS tbl, INDEX_NAME AS name, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', ') AS cols
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY'
    GROUP BY TABLE_NAME, INDEX_NAME ORDER BY TABLE_NAME, INDEX_NAME`, [DB]);

  // Everything in the database must be described here, so the document can never fall behind.
  const missing = [
    ...columns.filter((c) => !COLUMNS[`${c.tbl}.${c.name}`]).map((c) => `column ${c.tbl}.${c.name}`),
    ...[...new Set(columns.map((c) => c.tbl))].filter((t) => !TABLES[t]).map((t) => `table ${t}`),
    ...fks.filter((f) => !RELATIONSHIP_TEXT[f.name]).map((f) => `foreign key ${f.name}`),
    ...checks.filter((c) => !CHECK_TEXT[c.name]).map((c) => `check ${c.name}`),
    ...uniques.filter((u) => !UNIQUE_TEXT[u.name]).map((u) => `unique key ${u.name}`),
  ];
  if (missing.length) throw new Error(`Not described in build-requirements.js: ${missing.join(', ')}`);
  return { columns, fks, checks, uniques };
}

function dataSection({ columns, fks, checks, uniques }) {
  const keyOf = (c) => {
    const k = [];
    if (c.col_key === 'PRI') k.push('PK');
    const fk = fks.find((f) => f.child === c.tbl && f.col === c.name);
    if (fk) k.push(`FK → ${fk.parent}`);
    if (uniques.some((u) => u.tbl === c.tbl && u.cols.split(', ').includes(c.name))) k.push('UQ');
    return k.join(', ');
  };
  const typeOf = (t) => (t.startsWith('enum') ? 'enum' : t.replace('tinyint(1)', 'boolean'));
  const order = ['users', 'laundry_rooms', 'machines', 'bookings', 'notifications', 'waitlist_entries', 'machine_outages', 'laundry_tips', 'feedback'];
  const out = [];
  order.forEach((t, i) => {
    out.push(h2(`7.${i + 1} ${t}`));
    out.push(p(`${TABLES[t][0]} (Source: ${TABLES[t][1]}.)`));
    out.push(table(['Column', 'Type', 'Null', 'Key', 'Description'],
      columns.filter((c) => c.tbl === t).map((c) => [c.name, typeOf(c.type), c.nullable ? 'Yes' : 'No', keyOf(c), COLUMNS[`${t}.${c.name}`]]),
      [0.2, 0.15, 0.07, 0.17, 0.41], { size: 16 }));
  });
  const relationships = table(['Parent', 'Verb', 'Child', 'Cardinality', 'Foreign key', 'When the parent is deleted'],
    fks.map((f) => {
      const [parent, verb, child] = RELATIONSHIP_TEXT[f.name];
      const optional = columns.find((c) => c.tbl === f.child && c.name === f.col).nullable;
      return [parent, verb, child, optional ? '0..1 to 0..many' : '1 to 0..many', `${f.child}.${f.col}`, ON_DELETE[f.on_delete] || f.on_delete];
    }), [0.15, 0.14, 0.16, 0.14, 0.2, 0.21], { size: 16 });
  const checkTable = table(['Table', 'Rule', 'Meaning'], checks.map((c) => [c.tbl, c.name, CHECK_TEXT[c.name]]), [0.17, 0.33, 0.5], { size: 16 });
  const uniqueTable = table(['Table', 'Unique key', 'Columns', 'Meaning'], uniques.map((u) => [u.tbl, u.name, u.cols, UNIQUE_TEXT[u.name]]), [0.15, 0.3, 0.2, 0.35], { size: 16 });
  return { dictionary: out, relationships, checkTable, uniqueTable };
}

async function main() {
  const schema = await readSchema();
  await pool.end();
  const data = dataSection(schema);
  const tableCount = new Set(schema.columns.map((c) => c.tbl)).size;

  const content = [
    new Paragraph({ spacing: { before: 2200, after: 120 }, children: [new TextRun({ text: 'Students Campus Laundry Booking and Management System', bold: true, size: 44, font: 'Cambria' })] }),
    new Paragraph({ spacing: { after: 400 }, children: [new TextRun({ text: 'Requirements Specification', size: 36, bold: true })] }),
    p('Functional and non-functional requirements, business rules and data requirements, with the crow\'s-foot entity relationship diagram (ERD) and data dictionary.'),
    p(`Version ${VERSION} · ${DATE}`, { run: { color: COLOR.muted } }),
    p('Asemahle Sokaba (223172243) · Avuziwe Mcata (222106697)', { run: { color: COLOR.muted } }),
    new Paragraph({ children: [new PageBreak()] }),
    new Paragraph({ children: [new TextRun({ text: 'Contents', bold: true, size: 32, font: 'Cambria' })], spacing: { after: 200 } }),
    new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }),

    // ============================================================ 1
    h1('1. Introduction'),
    h2('1.1 Purpose of this document'),
    p('This document states what the Campus Laundry system must do (functional requirements), how well it must do it (non-functional requirements), the rules it follows and the data it stores. It combines the problem and objectives from Phase 1 with the requirement analysis from Phase 2, and shows the database design that meets them as a crow\'s-foot ERD.'),
    h2('1.2 Background'),
    p('Laundry facilities on campus are shared among many students, which often leads to overcrowding, long waiting times and poor management of machines. Students usually rely on a first-come, first-served system, which causes inconvenience and conflicts. Students also often lack knowledge about proper laundry practices such as separating clothes, choosing the correct detergent and caring for different fabric types.'),
    h2('1.3 Problem statement'),
    table(['Problem', 'Addressed by'], [
      ['Long queues and waiting times', 'FR-06 – FR-12 (booking and waiting list)'],
      ['Poor scheduling of machines', 'FR-07 – FR-10, FR-23 – FR-25'],
      ['No notification when laundry is done', 'FR-13 – FR-17'],
      ['Limited knowledge of proper laundry practices', 'FR-18 – FR-19'],
      ['No platform to give feedback on the service', 'FR-20 – FR-22, FR-28'],
    ], [0.5, 0.5]),
    h2('1.4 Purpose and objectives of the system'),
    p('The system provides a digital platform where students book laundry machines, receive notifications, read laundry tips and give feedback. Its objectives are:'),
    ...bullets([
      'To allow students to book machines online.',
      'To send notifications when laundry is complete.',
      'To provide helpful laundry tips.',
      'To allow students to give feedback.',
      'To improve the overall management of the laundry.',
    ]),
    h2('1.5 Scope'),
    table(['In scope', 'Out of scope'], [
      ['Student registration and login; administrator accounts', 'Payment for laundry or detergent'],
      ['Several laundry rooms with washers and dryers', 'Connecting to the machines themselves (students tap Start and Collected)'],
      ['Booking, rescheduling, cancelling, waiting list', 'SMS, email or push notifications (notifications are in the app)'],
      ['In-app notifications, laundry tips, feedback', 'A native mobile app (the web pages work on phones)'],
      ['Machine and room management, booking history, usage reports', ''],
    ], [0.5, 0.5]),
    h2('1.6 Definitions'),
    table(['Term', 'Meaning'], [
      ['Slot', 'A fixed block of time (e.g. 60 minutes) in which one machine can be booked'],
      ['Cycle', 'The washing or drying time of a machine, started by the student with Start cycle'],
      ['No-show', 'A booking whose cycle was not started within 15 minutes of the slot start'],
      ['Waiting list', 'Students waiting for a washer or dryer in a room on a day, in order of joining'],
      ['Out of order', 'A machine with an open outage; it cannot be booked'],
      ['Core table', 'A table that comes straight from the requirements (black heading in the ERD)'],
      ['Extension table', 'A table added in design to meet the requirements well (grey heading in the ERD)'],
    ], [0.22, 0.78]),

    // ============================================================ 2
    h1('2. Stakeholders and users'),
    table(['Stakeholder', 'Role in the system', 'Main needs'], [
      ['Student', 'Main user', 'Book a machine without queuing; know when laundry is done; learn good laundry practice; report problems'],
      ['Laundry administrator', 'Manages the system', 'Manage rooms and machines; see usage and history; handle feedback; manage accounts'],
      ['Residence / campus management', 'Indirect', 'Fair, well-used facilities; reports on use and problems'],
      ['Maintenance technician', 'Indirect', 'Clear reports of faulty machines (issues and outages)'],
    ], [0.24, 0.2, 0.56]),
    h2('2.1 Project team'),
    table(['Role', 'Responsibilities'], [
      ['System Analyst', 'Identifies user needs; analyses the system requirements'],
      ['Database Designer', 'Designs the tables and relationships; creates the ERD'],
      ['Developer', 'Builds the system; connects the database'],
      ['Presenter', 'Prepares the slides; presents the project'],
    ], [0.3, 0.7]),
    p('Group members: Asemahle Sokaba (223172243) and Avuziwe Mcata (222106697).'),

    // ============================================================ 3
    h1('3. Functional requirements'),
    p('Priority: **Must** = from the Phase 2 requirement analysis and needed for the system to be accepted; **Should** = added in design to make the requirement work well in practice.'),
    ...FUNCTIONAL.flatMap(([group, rows], i) => [
      h2(`3.${i + 1} ${group.replace(/^\d+\.\s*/, '')}`),
      table(['ID', 'Requirement', 'Priority', 'How the system meets it'], rows, [0.09, 0.33, 0.1, 0.48], { size: 17 }),
    ]),

    // ============================================================ 4
    h1('4. Non-functional requirements'),
    table(['ID', 'Quality', 'Requirement', 'How it is met and verified'], NON_FUNCTIONAL, [0.1, 0.15, 0.27, 0.48], { size: 17 }),

    // ============================================================ 5
    h1('5. Business rules'),
    table(['ID', 'Rule'], BUSINESS_RULES.map((r, i) => [`BR-${String(i + 1).padStart(2, '0')}`, r]), [0.1, 0.9]),
    h2('5.1 Assumptions and constraints'),
    ...bullets([
      'The system runs on one computer in the residence or laundry office (Node.js and MySQL 8.4); students use it in a web browser on the same network.',
      'Students record the start and the collection of their laundry in the app; the system does not read the machines.',
      'Each laundry room has fixed opening hours and one slot length for all its machines.',
      'Notifications are shown in the app; they are not sent by SMS or email.',
    ]),

    // ============================================================ 6
    h1('6. Data requirements and ERD'),
    p(`The database has ${tableCount} tables. Six come straight from the requirements (users, machines, bookings, notifications, laundry_tips, feedback). Three were added in design: **laundry_rooms** (the campus has several laundry rooms with their own hours), **waitlist_entries** (the waiting list that lets the system "notify the next user when a machine becomes free") and **machine_outages** (machines out of order, with their history).`),
    h2('6.1 Crow\'s-foot notation'),
    table(['Symbol at the end of a line', 'Meaning'], [
      ['Two bars ( || )', 'Exactly one'],
      ['Bar and circle ( |○ )', 'Zero or one (the link is optional)'],
      ['Crow\'s foot and circle ( ○< )', 'Zero or many'],
    ], [0.4, 0.6]),
    p('Each line is read from the parent (top) to the child (bottom) with its verb, e.g. "a laundry room **contains** zero or many machines; a machine is in exactly one laundry room".'),
    h2('6.2 Conceptual ERD'),
    p('The entities and how they are related.'),
    ...figure('docs/erd/laundry-erd-conceptual.png', 'Conceptual ERD (crow\'s foot)', PORTRAIT_W),
    SECTION_BREAK,
    h2('6.3 Physical ERD'),
    p('Every table with its columns, data types and keys, as built in MySQL 8.4. The diagram is a vector image: zoom in to read it in detail.'),
    ...physicalErd(),
    SECTION_BREAK,
    h2('6.4 Relationships'),
    data.relationships,
    h2('6.5 Unique keys'),
    data.uniqueTable,
    h2('6.6 Validation rules (CHECK constraints)'),
    p('These rules are enforced by MySQL itself, so invalid data is refused even if it does not come through the web pages.'),
    data.checkTable,

    // ============================================================ 7
    h1('7. Data dictionary'),
    p('PK = primary key, FK = foreign key (→ the table it refers to), UQ = part of a unique key. "Null: Yes" means the value is optional.'),
    ...data.dictionary,

    // ============================================================ 8
    h1('8. Requirements traceability'),
    p('Where each group of requirements is stored and which pages provide it.'),
    table(['Requirements', 'Tables', 'Pages'], TRACE, [0.2, 0.4, 0.4]),
    box('All requirements are verified by automated tests: database constraint tests, end-to-end API tests, browser tests and concurrency/performance tests (see the Test Report).', 'note'),
  ];

  // Three sections: the physical ERD gets a page of its own with narrow margins.
  const parts = [[]];
  for (const item of content.flat()) {
    if (item === SECTION_BREAK) parts.push([]);
    else parts[parts.length - 1].push(item);
  }
  const page = (margin) => ({ size: { width: 11906, height: 16838 }, margin: { top: margin, bottom: margin, left: margin, right: margin } });
  const pageFooter = footer('Campus Laundry · Requirements Specification');
  const doc = new Document({
    creator: 'Asemahle Sokaba & Avuziwe Mcata',
    title: 'Campus Laundry: Requirements Specification',
    ...documentStyles(),
    sections: parts.map((children, i) => ({
      properties: { page: page(i === 1 ? NARROW_MARGIN : 1440), titlePage: i === 0 },
      footers: i === 0 ? { first: new Footer({ children: [] }), default: pageFooter } : { default: pageFooter },
      children,
    })),
  });
  fs.writeFileSync(OUT, await Packer.toBuffer(doc));
  console.log(`Wrote ${OUT} (${tableCount} tables, ${schema.fks.length} relationships, ${schema.checks.length} checks)`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
