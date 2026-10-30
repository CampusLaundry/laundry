-- =============================================================================
-- Campus Laundry: complete database creation script (schema version 1.0, MySQL 8.4)
--
-- Builds the whole current schema in one go. It produces the same result as
-- running db/migrations/ in order (the setup script uses the migrations, so an
-- existing database can be upgraded without losing data).
-- =============================================================================

CREATE DATABASE IF NOT EXISTS campus_laundry;
USE campus_laundry;

-- Naming convention
--   tables       plural snake_case                 bookings, laundry_rooms
--   primary key  id (INT AUTO_INCREMENT)
--   foreign key  <singular>_id or a role name      room_id, machine_id, responded_by
--                constraint fk_<table>_<target>     fk_bookings_machine
--   unique       uq_<table>_<columns>               uq_users_email
--   index        idx_<table>_<column>               idx_bookings_status
--   check        chk_<table>_<rule>                 chk_bookings_times

-- -----------------------------------------------------------------------------
-- laundry_rooms: the campus laundry rooms (e.g. one per residence), each with
-- opening hours that are divided into booking slots of slot_minutes.
-- -----------------------------------------------------------------------------
CREATE TABLE laundry_rooms (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  location     VARCHAR(200) NULL,
  opens_at     TIME NOT NULL DEFAULT '06:00:00',
  closes_at    TIME NOT NULL DEFAULT '22:00:00',
  slot_minutes INT NOT NULL DEFAULT 60,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_laundry_rooms_name UNIQUE (name),
  CONSTRAINT chk_laundry_rooms_name CHECK (CHAR_LENGTH(TRIM(name)) >= 2),
  CONSTRAINT chk_laundry_rooms_hours CHECK (closes_at > opens_at),
  CONSTRAINT chk_laundry_rooms_slot CHECK (slot_minutes BETWEEN 30 AND 240)
);

-- -----------------------------------------------------------------------------
-- users: students and administrators. Students register themselves with their
-- student number; administrators are created with npm run admin:create.
-- Deactivated users (is_active = FALSE) cannot log in, but their records stay.
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  full_name            VARCHAR(100) NOT NULL,
  email                VARCHAR(150) NOT NULL,
  student_number       VARCHAR(12) NULL,
  password_hash        VARCHAR(100) NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  role                 ENUM('student', 'admin') NOT NULL DEFAULT 'student',
  room_id              INT NULL,
  phone                VARCHAR(20) NULL,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_users_email UNIQUE (email),
  CONSTRAINT uq_users_student_number UNIQUE (student_number),
  INDEX idx_users_room (room_id),
  CONSTRAINT fk_users_room FOREIGN KEY (room_id) REFERENCES laundry_rooms (id) ON DELETE SET NULL,
  CONSTRAINT chk_users_email CHECK (email LIKE '%_@_%._%'),
  CONSTRAINT chk_users_full_name CHECK (CHAR_LENGTH(TRIM(full_name)) >= 2),
  CONSTRAINT chk_users_student_number CHECK (student_number IS NULL OR student_number REGEXP '^[0-9]{8,10}$'),
  CONSTRAINT chk_users_student_has_number CHECK (role <> 'student' OR student_number IS NOT NULL),
  CONSTRAINT chk_users_phone CHECK (phone IS NULL OR phone REGEXP '^[0-9+() -]{7,20}$')
);

-- -----------------------------------------------------------------------------
-- machines: washers and dryers in a laundry room. A retired machine
-- (is_active = FALSE) keeps its booking history but can't be booked.
-- -----------------------------------------------------------------------------
CREATE TABLE machines (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  room_id       INT NOT NULL,
  code          VARCHAR(20) NOT NULL,
  kind          ENUM('washer', 'dryer') NOT NULL,
  cycle_minutes INT NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_machines_room_code UNIQUE (room_id, code),
  CONSTRAINT fk_machines_room FOREIGN KEY (room_id) REFERENCES laundry_rooms (id) ON DELETE RESTRICT,
  CONSTRAINT chk_machines_code CHECK (CHAR_LENGTH(TRIM(code)) >= 1),
  CONSTRAINT chk_machines_cycle CHECK (cycle_minutes BETWEEN 10 AND 240)
);

-- -----------------------------------------------------------------------------
-- machine_outages: periods when a machine is out of order. A machine is out of
-- order while it has an outage with no end time (at most one, enforced by the
-- generated column open_flag, which is 1 for an open outage and NULL otherwise).
-- -----------------------------------------------------------------------------
CREATE TABLE machine_outages (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  machine_id  INT NOT NULL,
  reason      VARCHAR(255) NOT NULL,
  reported_by INT NULL,
  started_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at    DATETIME NULL,
  open_flag   TINYINT GENERATED ALWAYS AS (IF(ended_at IS NULL, 1, NULL)) STORED,
  CONSTRAINT uq_machine_outages_machine_open UNIQUE (machine_id, open_flag),
  INDEX idx_machine_outages_reported_by (reported_by),
  CONSTRAINT fk_machine_outages_machine FOREIGN KEY (machine_id) REFERENCES machines (id) ON DELETE CASCADE,
  CONSTRAINT fk_machine_outages_reported_by FOREIGN KEY (reported_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_machine_outages_reason CHECK (CHAR_LENGTH(TRIM(reason)) >= 5),
  CONSTRAINT chk_machine_outages_period CHECK (ended_at IS NULL OR ended_at > started_at)
);

-- -----------------------------------------------------------------------------
-- bookings: a student books one machine for one slot on one day.
--   status flow: booked -> in_progress (Start cycle) -> done (cycle finished)
--                -> collected; or booked -> cancelled / no_show
-- Double bookings are impossible: slot_lock is the slot start for a live booking
-- and NULL for a cancelled or no-show one, and (machine, date, slot_lock) is
-- unique. The same trick stops one student holding two machines at the same time.
-- -----------------------------------------------------------------------------
CREATE TABLE bookings (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  user_id      INT NULL,
  machine_id   INT NOT NULL,
  booking_date DATE NOT NULL,
  slot_start   TIME NOT NULL,
  slot_end     TIME NOT NULL,
  status       ENUM('booked', 'in_progress', 'done', 'collected', 'cancelled', 'no_show') NOT NULL DEFAULT 'booked',
  started_at   DATETIME NULL,
  finishes_at  DATETIME NULL,
  collected_at DATETIME NULL,
  cancelled_at DATETIME NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  slot_lock    TIME GENERATED ALWAYS AS (IF(status IN ('cancelled', 'no_show'), NULL, slot_start)) STORED,
  CONSTRAINT uq_bookings_machine_slot UNIQUE (machine_id, booking_date, slot_lock),
  CONSTRAINT uq_bookings_user_slot UNIQUE (user_id, booking_date, slot_lock),
  INDEX idx_bookings_date (booking_date),
  INDEX idx_bookings_status (status),
  CONSTRAINT fk_bookings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_bookings_machine FOREIGN KEY (machine_id) REFERENCES machines (id) ON DELETE RESTRICT,
  CONSTRAINT chk_bookings_times CHECK (slot_end > slot_start),
  CONSTRAINT chk_bookings_started CHECK ((status IN ('in_progress', 'done', 'collected')) = (started_at IS NOT NULL)),
  CONSTRAINT chk_bookings_finishes CHECK ((started_at IS NULL) = (finishes_at IS NULL) AND (finishes_at IS NULL OR finishes_at > started_at)),
  CONSTRAINT chk_bookings_collected CHECK ((status = 'collected') = (collected_at IS NOT NULL)),
  CONSTRAINT chk_bookings_cancelled CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

-- -----------------------------------------------------------------------------
-- waitlist_entries: a student waiting for a washer or dryer in a room on a day.
-- When a booking for that room, day and kind is cancelled or missed, the next
-- student in line is notified (notified_at is then set).
-- -----------------------------------------------------------------------------
CREATE TABLE waitlist_entries (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  room_id     INT NOT NULL,
  wait_date   DATE NOT NULL,
  kind        ENUM('washer', 'dryer') NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  notified_at DATETIME NULL,
  CONSTRAINT uq_waitlist_entries_user_room_date_kind UNIQUE (user_id, room_id, wait_date, kind),
  INDEX idx_waitlist_entries_room_date (room_id, wait_date),
  CONSTRAINT fk_waitlist_entries_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_waitlist_entries_room FOREIGN KEY (room_id) REFERENCES laundry_rooms (id) ON DELETE CASCADE
);

-- -----------------------------------------------------------------------------
-- notifications: in-app messages (reminders, "laundry done", "machine free",
-- cancellations, replies to feedback). A booking gets each kind at most once,
-- so the background scheduler can safely run again and again.
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  booking_id INT NULL,
  kind       ENUM('reminder', 'cycle_done', 'machine_free', 'booking_cancelled', 'no_show', 'feedback_reply') NOT NULL,
  message    VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  read_at    DATETIME NULL,
  CONSTRAINT uq_notifications_booking_kind UNIQUE (booking_id, kind),
  INDEX idx_notifications_user (user_id),
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_notifications_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE,
  CONSTRAINT chk_notifications_message CHECK (CHAR_LENGTH(TRIM(message)) >= 5)
);

-- -----------------------------------------------------------------------------
-- laundry_tips: guidance on sorting clothes, detergents, fabrics and machine
-- care, written by the administrator. Unpublished tips are drafts.
-- -----------------------------------------------------------------------------
CREATE TABLE laundry_tips (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  category     ENUM('sorting', 'detergents', 'fabrics', 'maintenance') NOT NULL,
  title        VARCHAR(150) NOT NULL,
  body         TEXT NOT NULL,
  is_published BOOLEAN NOT NULL DEFAULT TRUE,
  created_by   INT NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT uq_laundry_tips_title UNIQUE (title),
  INDEX idx_laundry_tips_created_by (created_by),
  CONSTRAINT fk_laundry_tips_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_laundry_tips_title CHECK (CHAR_LENGTH(TRIM(title)) >= 5),
  CONSTRAINT chk_laundry_tips_body CHECK (CHAR_LENGTH(TRIM(body)) >= 20)
);

-- -----------------------------------------------------------------------------
-- feedback: a student rates the service or a machine (1–5 stars), comments, or
-- reports an issue. The administrator responds and closes it.
--   status flow: new -> in_progress -> resolved / dismissed
-- -----------------------------------------------------------------------------
CREATE TABLE feedback (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NULL,
  room_id       INT NULL,
  machine_id    INT NULL,
  kind          ENUM('rating', 'comment', 'issue') NOT NULL,
  rating        TINYINT NULL,
  comment       TEXT NULL,
  status        ENUM('new', 'in_progress', 'resolved', 'dismissed') NOT NULL DEFAULT 'new',
  admin_response TEXT NULL,
  responded_by  INT NULL,
  responded_at  DATETIME NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_feedback_user (user_id),
  INDEX idx_feedback_room (room_id),
  INDEX idx_feedback_machine (machine_id),
  INDEX idx_feedback_responded_by (responded_by),
  INDEX idx_feedback_status (status),
  CONSTRAINT fk_feedback_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_feedback_room FOREIGN KEY (room_id) REFERENCES laundry_rooms (id) ON DELETE SET NULL,
  CONSTRAINT fk_feedback_machine FOREIGN KEY (machine_id) REFERENCES machines (id) ON DELETE SET NULL,
  CONSTRAINT fk_feedback_responded_by FOREIGN KEY (responded_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_feedback_rating CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  CONSTRAINT chk_feedback_rating_kind CHECK ((kind = 'rating') = (rating IS NOT NULL)),
  CONSTRAINT chk_feedback_comment CHECK (kind = 'rating' OR (comment IS NOT NULL AND CHAR_LENGTH(TRIM(comment)) >= 5)),
  CONSTRAINT chk_feedback_response CHECK ((admin_response IS NULL) = (responded_at IS NULL))
);

-- -----------------------------------------------------------------------------
-- Reference data: a starting set of laundry tips (the administrator can edit them).
-- -----------------------------------------------------------------------------
INSERT INTO laundry_tips (category, title, body) VALUES
  ('sorting', 'Separate whites, darks and colours',
   'Wash whites, darks and bright colours in separate loads. New dark or red clothes can bleed dye for the first few washes, so wash them on their own or with similar colours.'),
  ('sorting', 'Check the care labels and empty the pockets',
   'Read the care label before washing: it shows the highest temperature and whether the item can be tumble dried. Empty all pockets; tissues, pens and coins damage clothes and machines.'),
  ('detergents', 'Use the right amount of detergent',
   'More detergent does not mean cleaner clothes. Too much leaves residue, irritates skin and wastes money. Follow the dose on the pack for a normal load, and use less for a small load.'),
  ('detergents', 'Powder, liquid or pods?',
   'Powder is best for whites and heavily soiled clothes; liquid works well at low temperatures and on greasy stains; pods are convenient but cannot be adjusted for small loads. Never put pods in the detergent drawer.'),
  ('fabrics', 'Cotton, polyester and wool',
   'Cotton can be washed warm (40 °C) and tumble dried on medium. Polyester and other synthetics prefer 30 °C and a short, cool dry. Wool and delicate fabrics need the wool or hand-wash cycle and should be dried flat, not in the dryer.'),
  ('fabrics', 'Denim and sportswear',
   'Turn jeans inside out and wash them cold to keep the colour. Wash sportswear inside out at 30 °C without fabric softener, which blocks the fabric''s ability to wick sweat.'),
  ('maintenance', 'Clean the dryer lint filter every time',
   'Empty the lint filter before or after every dryer cycle. A full filter makes drying take much longer and is a fire risk. Report a dryer that still leaves clothes damp.'),
  ('maintenance', 'Leave the machine ready for the next student',
   'Collect your laundry as soon as the cycle is done, wipe away spilled detergent, and leave the washer door open a little so it can air out. Report leaks, strange noises or error codes through Feedback.');

-- -----------------------------------------------------------------------------
-- schema_migrations: which migration scripts have been applied (change log).
-- -----------------------------------------------------------------------------
CREATE TABLE schema_migrations (
  version    VARCHAR(100) PRIMARY KEY,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO schema_migrations (version) VALUES
  ('001_initial_schema');
