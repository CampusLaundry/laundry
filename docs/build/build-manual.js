// Builds docs/Laundry-User-Manual.docx: how to install and run the Campus Laundry system on
// another computer after copying the project folder, and how students and administrators use it.
// Needs the screenshots from tools/screenshots.js.
// Usage: npm run docs:manual   (builds the document, fills in the contents page and saves a PDF)
const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, PageBreak, TableOfContents, Footer } = require('docx');
const {
  COLOR, PORTRAIT_W, p, h1, h2, bullets, numbered, newList, box, command, table, makeFigure, documentStyles, footer,
} = require('./docx-helpers');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'Laundry-User-Manual.docx');
const VERSION = require(path.join(ROOT, 'package.json')).version;
const DATE = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const MOVE_LIST = newList();
const figure = makeFigure(ROOT);
const shot = (file, caption) => figure(`docs/screenshots/${file}.png`, caption, PORTRAIT_W * 0.95, 330);

const missing = ['01-login', '02-register', '03-my-laundry', '04-book-grid', '05-book-confirm', '06-waitlist', '07-notifications', '08-tips',
  '09-feedback', '10-profile', '11-dashboard', '12-machines', '13-rooms', '14-admin-feedback', '15-admin-bookings', '16-people', '17-tips-admin']
  .filter((f) => !fs.existsSync(path.join(ROOT, 'docs', 'screenshots', `${f}.png`)));
if (missing.length) {
  console.error(`Screenshots missing (${missing.join(', ')}). Run "node tools/screenshots.js" with the app running first.`);
  process.exit(1);
}

const content = [
  new Paragraph({ spacing: { before: 2200, after: 120 }, children: [new TextRun({ text: 'Campus Laundry', bold: true, size: 64, color: COLOR.primary, font: 'Cambria' })] }),
  new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: 'Students Campus Laundry Booking and Management System', size: 30, color: COLOR.muted })] }),
  new Paragraph({ spacing: { after: 400 }, children: [new TextRun({ text: 'Installation and User Manual', size: 36, bold: true })] }),
  p('How to install and run the system on a computer, and how students and administrators use it.'),
  p(`Version ${VERSION} · ${DATE} · Asemahle Sokaba · Avuziwe Mcata`, { run: { color: COLOR.muted } }),
  new Paragraph({ children: [new PageBreak()] }),
  new Paragraph({ children: [new TextRun({ text: 'Contents', bold: true, size: 32, color: COLOR.primary, font: 'Cambria' })], spacing: { after: 200 } }),
  new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }),

  // ================================================================ 1
  h1('1. About the system'),
  p('Campus Laundry lets students book a washer or dryer for a time slot instead of queuing. Students get a reminder before their slot and a notification when their laundry is done, can join a waiting list when everything is booked, read laundry tips and send feedback. The laundry administrator manages the laundry rooms and machines, answers feedback and sees booking history and usage reports.'),
  table(['Who', 'Uses the system to', 'Read'], [
    ['Student', 'Book, start and collect laundry; waiting list; notifications; tips; feedback', 'Part B (Sections 5–11)'],
    ['Administrator', 'Set up rooms and machines; mark machines out of order; reply to feedback; reports; manage accounts', 'Part C (Sections 12–17)'],
    ['Whoever installs it', 'Install and run the system on a computer', 'Part A (Sections 2–4) and Section 18'],
  ], [0.18, 0.55, 0.27]),
  h2('How a laundry booking works'),
  ...numbered([
    'Book a washer or dryer for a slot (today or up to 7 days ahead).',
    '30 minutes before the slot you get a **reminder** (🔔).',
    'At the laundry room, load the machine and tap **Start cycle** (from 5 minutes before your slot until 15 minutes after it starts).',
    'When the machine\'s cycle time has passed you get **"your laundry is done"**.',
    'Take your laundry out and tap **Collected**. The next student booked on that machine is told it is free.',
  ]),
  box('If you don\'t start the cycle within 15 minutes of your slot starting, the booking is marked as **missed** and the machine is released for others.', 'warn'),

  // ================================================================ PART A
  h1('Part A · Installation'),
  p('The system runs on one computer (for example the residence office computer). That computer runs **MySQL** (the database) and the **Campus Laundry server** (Node.js). Students and staff use it in a web browser: on the same computer at http://localhost:3003, or from phones and laptops on the same Wi-Fi (Section 18.2).'),
  table(['Step', 'Task', 'Time'], [
    ['1', 'Copy the project folder to the computer', '5 min'],
    ['2', 'Install Node.js', '5 min'],
    ['3', 'Install and configure MySQL Server', '10–15 min'],
    ['4', 'Open a terminal in the project folder', '1 min'],
    ['5', 'Create the settings file (.env)', '5 min'],
    ['6', 'Install the project\'s packages', '1–3 min'],
    ['7', 'Create the database', '1 min'],
    ['8', 'Create the first administrator', '1 min'],
    ['9', 'Start the system and log in', '2 min'],
    ['10', '(Optional) Check the installation', '5 min'],
  ], [0.1, 0.72, 0.18]),
  box('You need an internet connection while installing (steps 2, 3 and 6). After that, the system works without internet.'),

  h1('2. What you need'),
  h2('2.1 Computer'),
  ...bullets([
    'Windows 10 or 11 (64-bit). macOS and Linux also work; see Appendix B.',
    'At least 4 GB of RAM and 1 GB of free disk space.',
    'An account that is allowed to install software (administrator rights).',
  ]),
  h2('2.2 Software to install'),
  table(['Software', 'Version', 'What it is for', 'Where to get it'], [
    ['Node.js (includes npm)', '24 LTS (tested with 24.19.0)', 'Runs the server; npm installs its packages', 'https://nodejs.org (choose "LTS")'],
    ['MySQL Community Server', '8.4 LTS (tested with 8.4.9)', 'The database', 'https://dev.mysql.com/downloads/mysql/ (choose 8.4 LTS)'],
    ['A web browser', 'Any current version', 'Using the system', 'Microsoft Edge, Google Chrome or Firefox'],
    ['Microsoft Edge, Word (optional)', 'Current', 'Only for the browser tests and rebuilding the documents', 'Not needed to run the system'],
  ], [0.22, 0.24, 0.28, 0.26]),
  h2('2.3 What is in the project folder'),
  table(['Item', 'What it is', 'Copy it?'], [
    ['server.js, routes/, lib/, public/', 'The application', 'Yes'],
    ['db/', 'Database creation script and migrations', 'Yes'],
    ['tools/', 'Admin commands, tests and sample data', 'Yes'],
    ['docs/', 'This manual, the test report and screenshots', 'Yes'],
    ['package.json, package-lock.json', 'The list of packages needed', 'Yes'],
    ['.env.example', 'Template for the settings file', 'Yes'],
    ['.env', 'Settings for the OLD computer (database password, secret key)', 'No: create a new one (step 5)'],
    ['node_modules/', 'Downloaded packages (large)', 'No: re-created in step 6'],
    ['.claude/', 'Editor settings from development', 'No'],
  ], [0.3, 0.45, 0.25]),
  box('The database is not inside the project folder: accounts and bookings live in MySQL. A new installation starts with an empty database. To bring existing data across, see Section 19.', 'warn'),

  h1('3. Installation steps'),
  h2('Step 1: Copy the project folder'),
  ...numbered([
    'Copy the whole **laundry** folder, apart from **node_modules**, **.claude** and **.env**, using a USB drive, a zip file or a cloud drive.',
    'On the new computer, put it somewhere simple, for example **C:\\CampusLaundry\\laundry**.',
  ]),
  box('Avoid keeping the folder in OneDrive, Dropbox or Google Drive on the new computer. Syncing thousands of package files makes installing and starting much slower.'),

  h2('Step 2: Install Node.js'),
  p('**Option A: installer (easiest).** Go to https://nodejs.org, download the **LTS** Windows installer (.msi), run it and keep all the default options.'),
  p('**Option B: command.** In Windows Terminal or PowerShell:'),
  ...command('winget install --id OpenJS.NodeJS.LTS'),
  p('**Check it worked.** Close every terminal window, open a **new** one, and run:'),
  ...command('node -v', 'npm -v'),
  box('If you see "npm is not recognized", the terminal was opened before Node.js was installed. Close all terminal windows (and editors such as VS Code) and open a new one.', 'warn'),

  h2('Step 3: Install and configure MySQL Server'),
  p('**Option A: installer.** Go to https://dev.mysql.com/downloads/mysql/, choose **8.4 LTS**, and download the **Windows (x86, 64-bit), MSI Installer** ("No thanks, just start my download"). Run it and choose **Typical**.'),
  p('**Option B: command.**'),
  ...command('winget install --id Oracle.MySQL'),
  p('**Configure the server.** When installation finishes, **MySQL Configurator** opens. If it doesn\'t, search the Start menu for "MySQL Configurator".'),
  ...numbered([
    'Config type: **Development Computer**. Port: **3306** (keep the default).',
    'Set a **root password** and write it down; you need it in step 5.',
    'Keep **Configure MySQL Server as a Windows Service** and **Start the MySQL Server at System Startup** ticked. The service is usually called **MySQL84**.',
    'Click **Next** through the remaining pages, then **Execute**, then **Finish**.',
  ]),
  p('**Check it is running:** open the **Services** app and look for **MySQL84** with status **Running**, or in PowerShell:'),
  ...command('Get-Service MySQL84'),
  box('If this computer already runs another project with MySQL 8.4, skip this step: they can share the same MySQL server because each uses its own database.'),

  h2('Step 4: Open a terminal in the project folder'),
  p('In File Explorer, open the **laundry** folder, right-click an empty area and choose **Open in Terminal**, or type:'),
  ...command('cd "C:\\CampusLaundry\\laundry"'),

  h2('Step 5: Create the settings file (.env)'),
  ...command('copy .env.example .env', 'notepad .env'),
  table(['Setting', 'What to put'], [
    ['DB_HOST, DB_PORT, DB_USER', 'Leave as `localhost`, `3306`, `root`'],
    ['DB_PASSWORD', 'The MySQL root password from step 3'],
    ['DB_NAME', 'Leave as `campus_laundry`'],
    ['PORT', 'Leave as `3003` (change only if another program uses it)'],
    ['SESSION_SECRET', 'A long random text that keeps logins secure. Create one with the command below and paste it in.'],
  ], [0.3, 0.7]),
  ...command('node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'),
  box('.env contains passwords. Do not share it or copy it to other computers.', 'warn'),

  h2('Step 6: Install the project\'s packages'),
  ...command('npm install --omit=dev'),
  p('This downloads what the system needs into a new **node_modules** folder and ends with a line such as "added 80 packages".'),
  box('`--omit=dev` skips the tools that are only used for browser tests, sample data and rebuilding the documents. To include them, run `npm install` instead.'),

  h2('Step 7: Create the database'),
  ...command('npm run db:setup'),
  p('You should see:'),
  ...command('Applying migration 001_initial_schema…', 'Database "campus_laundry" is up to date.', 'There is no administrator yet. Create one with:  npm run admin:create -- "Full Name" email@example.com'),
  p('This creates an empty database with all 9 tables and 8 starting laundry tips. It is safe to run again at any time: it never deletes data.'),

  h2('Step 8: Create the first administrator'),
  ...command('npm run admin:create -- "Your Name" you@example.com'),
  p('It prints a **temporary password**. Write it down; you will choose your own password when you log in.'),

  h2('Step 9: Start the system'),
  ...command('npm start'),
  p('When you see **Campus Laundry running at http://localhost:3003**, open a browser and go to:'),
  ...command('http://localhost:3003'),
  p('Log in with the administrator email and temporary password, then choose your own password. Keep the terminal window open while the system is in use: it also sends the reminders and "laundry done" notifications. Press **Ctrl + C** in it to stop.'),

  h2('Step 10 (optional): Check the installation'),
  p('These checks create their own temporary test data and remove it again, so they are safe on a real installation.'),
  ...command('npm run db:check'),
  p('Expect "MATCH" and "43/43 integrity rules enforced". Then, **while the system is running**, open a second terminal in the project folder and run:'),
  ...command('npm run test:api'),
  p('Expect "84/84 API tests passed. All test accounts and data were removed." With the full `npm install`, `npm test` also runs the browser and load tests (see the Test Report).'),

  h1('4. First-time setup (administrator)'),
  ...numbered([
    'Go to **Machines & rooms → Laundry rooms** and add each laundry room: its name, location, opening and closing times and the **slot length** (for example 60 minutes). Students book one slot at a time.',
    'Go to **Machines** and add every washer and dryer: the room, a short **code** written on the machine (e.g. W1, D2), the type and its **cycle time** in minutes. The cycle must fit in one slot.',
    'Check the **Laundry tips** and edit them if you like.',
    'Tell students the address of the system so they can **register**.',
  ]),
  ...shot('13-rooms', 'Machines & rooms → Laundry rooms: opening hours and slot length'),
  ...shot('12-machines', 'Machines: add washers and dryers; mark them out of order or retire them'),

  // ================================================================ PART B
  h1('Part B · Student guide'),
  h1('5. Getting started', false),
  h2('5.1 Register'),
  ...numbered([
    'Open the system and click **Register**.',
    'Enter your full name, **student number** (8–10 digits), email and a password of at least 8 characters.',
    'Choose **your laundry room** (it opens first when you book) and, if you like, your phone number.',
    'Click **Create account**. You are logged in and taken to **My laundry**.',
  ]),
  ...shot('02-register', 'Registering as a student'),
  h2('5.2 Log in'),
  p('Log in with your **email or your student number** and your password. Forgot your password? Ask the laundry administrator: they can give you a temporary password, and you then choose a new one.'),
  ...shot('01-login', 'Log in'),
  h2('5.3 The menu and the bell'),
  p('The menu is on the left of the screen. On a phone it is a bar along the bottom of the screen with short names (Mine, Book, Tips, Feedback). The bar at the top shows today\'s date, the bell and your initials.'),
  table(['Menu', 'What it is for'], [
    ['My laundry', 'Your bookings: start the cycle, mark it collected, cancel or reschedule; your waiting list; your history'],
    ['Book a machine', 'Find a free washer or dryer and book it'],
    ['Laundry tips', 'Advice on sorting, detergents, fabrics and machine care'],
    ['Feedback', 'Rate the service, comment, or report a problem'],
    ['Bell (top right)', 'Your notifications; the red number shows how many are unread'],
    ['Your initials (top right) or your name (bottom of the menu)', 'Your profile: details, laundry room, phone, password'],
    ['Log out (bottom of the menu; the arrow icon at the top right on a phone)', 'Log out'],
  ], [0.35, 0.65]),
  h2('5.4 Your profile'),
  p('Click your initials at the top right (or your name at the bottom of the menu) to change your name, email, laundry room or phone, change your password, or delete your account. Your student number cannot be changed.'),
  ...shot('10-profile', 'My profile'),

  h1('6. Booking a machine'),
  ...numbered([
    'Click **Book a machine**.',
    'Choose the **laundry room** at the top right, and the **day** (today or up to 7 days ahead).',
    'The grid shows every machine (rows) and every time slot (columns). Scroll sideways to see later slots.',
    'Click a green **Book** slot. A bar appears at the bottom with the machine, day and time.',
    'Click **Confirm booking**. You are taken to **My laundry** with your new booking.',
  ]),
  table(['In the grid', 'Means'], [
    ['Book (green)', 'Free: click to book'],
    ['Yours (blue)', 'Your booking'],
    ['Taken (grey)', 'Another student booked it'],
    ['Out (red stripes)', 'The machine is out of order; the reason is shown under the machine'],
    ['Empty', 'The slot has passed'],
  ], [0.3, 0.7]),
  ...shot('04-book-grid', 'The booking grid: free, taken and out-of-order slots'),
  ...shot('05-book-confirm', 'Confirming a booking'),
  h2('6.1 Booking rules'),
  ...bullets([
    'You can have at most **3 open bookings** at a time.',
    'You can\'t book two machines for the same time.',
    'If someone books the same slot a moment before you, you\'ll see "Sorry, someone has just booked that slot". Choose another one.',
  ]),
  h2('6.2 Reschedule or cancel'),
  p('On **My laundry**, click **Reschedule** to pick a new slot in the grid (then **Move booking**), or **Cancel** to free the slot for someone else. Both are possible until your slot starts.'),

  h1('7. Doing your laundry'),
  ...numbered([
    'Go to the laundry room in time for your slot and load the machine.',
    'Open **My laundry** and tap **▶ Start cycle**. You can do this from 5 minutes before your slot until 15 minutes after it starts.',
    'A progress bar shows how much time is left.',
    'When the cycle is done you get a notification. Take your laundry out promptly.',
    'Tap **✓ Collected**. The machine is now free, and the next student booked on it is told.',
  ]),
  ...shot('03-my-laundry', 'My laundry: a cycle running, a booking ready to start, and an upcoming booking'),
  box('Not started within 15 minutes? The booking is marked as **Missed** and the machine is released. Missed bookings show up in your history and in the administrator\'s reports.', 'warn'),

  h1('8. The waiting list'),
  p('When every washer (or dryer) in a room is booked for a day, the **Book a machine** page shows **Join the waiting list for a washer / dryer**. If someone cancels or misses their slot, the **first** student in line gets a notification and can book it. Your waiting-list places are listed on **My laundry**, with how many students are ahead of you. Booking a machine of that type removes you from the list automatically.'),
  ...shot('06-waitlist', 'My laundry: on the waiting list for a dryer'),

  h1('9. Notifications'),
  p('Click the **bell** to see your notifications. **Open** takes you to the right page; **Mark read** or **Mark all as read** clear the red number.'),
  table(['Notification', 'When'], [
    ['⏰ Reminder', '30 minutes before your slot'],
    ['✅ Laundry done', 'When your cycle has finished'],
    ['🟢 Machine free', 'The machine you booked later today is free now, or a machine became free for your waiting list'],
    ['⚠️ Booking cancelled', 'The administrator cancelled your booking, for example because the machine is out of order'],
    ['⌛ Missed', 'You did not start the cycle within 15 minutes'],
    ['💬 Feedback reply', 'The administrator answered your feedback'],
  ], [0.3, 0.7]),
  ...shot('07-notifications', 'Notifications'),

  h1('10. Laundry tips'),
  p('**Laundry tips** gives advice on **sorting clothes**, **choosing detergents**, **fabric types** and **machine care**. Click a category to see only those tips.'),
  ...shot('08-tips', 'Laundry tips'),

  h1('11. Feedback'),
  ...numbered([
    'Click **Feedback** and choose **Rate**, **Comment** or **Report an issue**.',
    'Choose the laundry room and, if it is about one machine, the machine.',
    'For a rating, click 1 to 5 stars. Add a comment (required for comments and issues).',
    'Click **Send feedback**. Your feedback and the administrator\'s replies appear under **My feedback**, and you get a notification when they reply.',
  ]),
  ...shot('09-feedback', 'Reporting an issue with a machine'),

  // ================================================================ PART C
  h1('Part C · Administrator guide'),
  h1('12. Dashboard', false),
  p('The **Dashboard** opens when you log in. **Right now** shows today\'s bookings, machines running, loads waiting to be collected, machines out of order, open issues and students on waiting lists. The **Usage report** (last 7, 30 or 90 days) shows bookings, loads washed, cancellations, the no-show rate and the average rating, with bookings per day, the busiest hours, use per machine and per room.'),
  ...shot('11-dashboard', 'Dashboard and usage report'),

  h1('13. Machines and rooms'),
  table(['Task', 'How'], [
    ['Add a machine', 'Machines & rooms → fill in room, code, type and cycle time → **Add machine**'],
    ['Edit a machine', '**Edit** in its row; change the details → **Save changes**'],
    ['Out of order', '**Out of order** → type the reason. The machine can\'t be booked; its upcoming bookings are cancelled and those students are notified with the reason.'],
    ['Repaired', '**Back in service**. The **History** button lists every past outage.'],
    ['Remove a machine', '**Delete** works only for a machine that was never booked. Otherwise use **Retire**: it disappears from the booking grid but its history stays (its upcoming bookings are cancelled).'],
    ['Rooms', 'Laundry rooms tab: add or edit rooms and opening hours. Opening hours and slot length can only change when the room has no upcoming bookings. Untick **Open for bookings** to close a room. A room with machines can\'t be deleted.'],
  ], [0.2, 0.8]),

  h1('14. Feedback and issues'),
  p('**Feedback** lists open feedback first (issues before ratings and comments). For each one you can write a **reply**, set the **status** (New, Being looked at, Resolved, Closed) and **Save**; the student is notified. Closing (dismissing) feedback needs a reply explaining why. For an issue about a machine, **Mark machine out of order** takes it out of service in one step.'),
  ...shot('14-admin-feedback', 'Feedback and issues'),

  h1('15. Booking history'),
  p('**Bookings** lists every booking in every room. Filter by student (name, student number or email), dates, room and status. You can **Cancel** an upcoming booking; the student is notified.'),
  ...shot('15-admin-bookings', 'Booking history'),

  h1('16. People'),
  ...bullets([
    'Search by name, email or student number.',
    'Change a role to **Admin** to make another administrator.',
    '**Deactivate** someone who should no longer use the system: they can\'t log in and their upcoming bookings are cancelled; their history stays. **Reactivate** reverses it.',
    '**Reset password** shows a temporary password once; they choose a new one when they log in.',
    '**Delete** removes the account; their past bookings and feedback stay in the reports as "former student".',
  ]),
  ...shot('16-people', 'People'),

  h1('17. Laundry tips (administrator)'),
  p('On **Tips**, click **+ New tip**, choose the category, write a title and the tip, and **Save tip**. Untick **Published** to keep it as a draft that students can\'t see. **Edit** and **Delete** are on each tip.'),
  ...shot('17-tips-admin', 'Adding a laundry tip'),

  // ================================================================ everyday use
  h1('18. Everyday use'),
  h2('18.1 Starting and stopping'),
  ...bullets([
    'MySQL starts automatically with Windows.',
    'Start the system: open a terminal in the project folder and run `npm start`.',
    'Stop it: press **Ctrl + C** in that terminal, or close the window. While it is stopped, no reminders or "laundry done" notifications are sent; they catch up when it starts again.',
  ]),
  h2('18.2 Using it from phones'),
  ...numbered([
    'On the computer running the system, run `ipconfig` and note the **IPv4 Address**, e.g. `192.168.1.25`.',
    'The first time it starts, Windows may ask whether to allow Node.js through the firewall. Allow it on **Private networks**.',
    'On phones on the same Wi-Fi, open `http://192.168.1.25:3003` (use your own address). The pages are designed for phone screens.',
  ]),
  box('The system uses plain http, which is fine on a trusted local network. Do not put it directly on the internet without setting up https.', 'warn'),
  h2('18.3 Backing up'),
  p('Back up regularly. Open **Command Prompt**, go to the project folder and run (it asks for the MySQL root password):'),
  ...command('cd /d "C:\\CampusLaundry\\laundry"', '"C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysqldump.exe" -u root -p --databases campus_laundry --result-file=laundry-backup.sql'),
  h2('18.4 Demonstration data'),
  p('For a presentation you can fill the system with fictional data: three laundry rooms, students with @sample.test emails and two weeks of bookings. It needs the full `npm install` and the system running:'),
  ...command('npm run sample:seed'),
  p('Log in as **admin@sample.test** or a student such as **thandi@sample.test**; the password is in `tools/sample-data.js`. Remove all of it again afterwards (only the sample data is deleted):'),
  ...command('npm run sample:clean'),

  h1('19. Moving existing data to another computer'),
  ...numbered([
    'On the **old** computer, make a backup as in Section 18.3 and copy **laundry-backup.sql** to the new computer.',
    'On the **new** computer, complete installation steps 1–6, but **skip steps 7 and 8**.',
    'Put **laundry-backup.sql** in the project folder, open **Command Prompt** there and import it:',
  ], MOVE_LIST),
  ...command('"C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysql.exe" -u root -p < laundry-backup.sql'),
  ...numbered([
    'Run `npm run db:setup` (it applies any newer updates).',
    'Start with `npm start` and log in with the existing accounts.',
  ], MOVE_LIST),

  h1('20. Troubleshooting'),
  table(['Problem', 'Likely cause', 'What to do'], [
    ['"npm is not recognized"', 'The terminal was opened before Node.js was installed', 'Close all terminals (and VS Code) and open a new one.'],
    ['"Cannot reach the database" or ECONNREFUSED', 'MySQL is not running', 'Services → MySQL84 → Start. Set its startup type to Automatic.'],
    ['db:setup: "ER_ACCESS_DENIED_ERROR"', 'Wrong DB_PASSWORD in .env', 'Put the correct MySQL root password in .env.'],
    ['npm start: "EADDRINUSE :::3003"', 'Another program is using port 3003', 'Close it, or set another PORT in .env and open that address.'],
    ['The only administrator forgot their password', 'Nobody else can reset it in the app', 'Run `npm run admin:reset-password -- admin@email` and use the temporary password shown.'],
    ['A student forgot their password', '', 'Administrator: People → Reset password.'],
    ['"This account has been deactivated"', 'The administrator deactivated it', 'Administrator: People → Reactivate.'],
    ['No rooms to book', 'No laundry rooms or machines yet, or the room is closed', 'Administrator: Machines & rooms (Section 4).'],
    ['"You can have at most 3 open bookings"', 'The limit per student', 'Finish (Collected) or cancel a booking first.'],
    ['"Start cycle" button missing', 'Too early, or more than 15 minutes into the slot', 'It appears 5 minutes before the slot; after 15 minutes the booking is released.'],
    ['"The previous cycle is still running"', 'The student before you started late', 'Wait until it finishes, then start.'],
    ['No reminders or "done" notifications', 'The server was stopped', 'Keep `npm start` running; notifications catch up when it restarts.'],
    ['Changes to .env have no effect', 'The server reads .env only when it starts', 'Stop (Ctrl + C) and run `npm start` again.'],
  ], [0.28, 0.3, 0.42]),

  h1('Appendix A: Command reference'),
  table(['Command', 'What it does'], [
    ['npm install --omit=dev', 'Installs the packages the system needs'],
    ['npm run db:setup', 'Creates the database or brings it up to date. Never deletes data.'],
    ['npm run admin:create -- "Name" email', 'Creates an administrator (or promotes an existing account) with a temporary password'],
    ['npm run admin:reset-password -- email', 'Gives anyone a temporary password'],
    ['npm start', 'Starts the system at http://localhost:3003 (stop with Ctrl + C)'],
    ['npm run db:check', 'Checks the database structure and 43 integrity rules (leaves no data)'],
    ['npm run test:api', '84 end-to-end tests while the system is running (leaves no data)'],
    ['npm test', 'Every test suite, including browser and load tests (needs the full npm install)'],
    ['npm run sample:seed / sample:clean', 'Adds / removes fictional demonstration data'],
    ['npm run db:reset', '**Deletes the whole database** and creates an empty one'],
  ], [0.42, 0.58]),
  h1('Appendix B: macOS and Linux'),
  table(['Step', 'Windows', 'macOS / Linux'], [
    ['Install Node.js', 'Installer or winget', 'Installer from https://nodejs.org (macOS), or your package manager'],
    ['Install MySQL 8.4', 'MSI installer + MySQL Configurator', 'DMG installer from dev.mysql.com (macOS), or your package manager'],
    ['Copy the settings file', 'copy .env.example .env', 'cp .env.example .env'],
    ['Edit the settings file', 'notepad .env', 'nano .env (or any text editor)'],
  ], [0.22, 0.33, 0.45]),
  p('All the npm commands are the same on every system. The browser tests and document tools use Microsoft Edge and Word, so they run on Windows.'),
];

async function main() {
  const doc = new Document({
    creator: 'Asemahle Sokaba & Avuziwe Mcata',
    title: 'Campus Laundry: Installation and User Manual',
    ...documentStyles(),
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } }, titlePage: true },
      footers: { first: new Footer({ children: [] }), default: footer('Campus Laundry · Installation and User Manual') },
      children: content.flat(), // a list helper added without ... would otherwise break the document
    }],
  });
  fs.writeFileSync(OUT, await Packer.toBuffer(doc));
  console.log(`Wrote ${OUT} (${figure.count()} screenshots)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
