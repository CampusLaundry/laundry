// Builds docs/Laundry-Test-Report.docx by running every test suite against the live system
// and writing up the results, the requirements they cover and the defects testing found.
// Needs: MySQL running, the app running (npm start), dev tools installed, Microsoft Edge.
// Usage: npm run docs:test-report
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Document, Packer, Paragraph, TextRun, PageBreak, TableOfContents, Footer } = require('docx');
const { collect, ROOT } = require('./live-data');
const { COLOR, p, h1, h2, spacer, bullets, numbered, box, command, table, documentStyles, footer } = require('./docx-helpers');
const { launch } = require('../../tools/render');

const OUT = path.join(ROOT, 'docs', 'Laundry-Test-Report.docx');
const DATE = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

function runSuite(script) {
  let out;
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, 'tools', script)], { cwd: ROOT, encoding: 'utf8' });
  } catch (err) {
    out = `${err.stdout || ''}`; // failures are reported in the document, not hidden
  }
  return out.split('\n').filter((l) => /^(PASS|FAIL) /.test(l)).map((l) => {
    const m = l.match(/^(PASS|FAIL)\s+\[(.*?)\]\s+(.*?)(?:\s{2}\((.*)\))?\s*$/);
    return { pass: m[1] === 'PASS', area: m[2], name: m[3], detail: m[4] || '' };
  });
}

async function main() {
  // REPORT_CACHE=file reuses saved results (for working on the layout without re-testing).
  let cached = process.env.REPORT_CACHE && fs.existsSync(process.env.REPORT_CACHE) ? JSON.parse(fs.readFileSync(process.env.REPORT_CACHE, 'utf8')) : null;
  if (!cached) {
    const browser = await launch();
    cached = {
      live: await collect(), // schema comparison, database integrity and API tests
      ui: runSuite('test-ui.js'),
      load: runSuite('test-load.js'),
      edgeVersion: await browser.version(),
    };
    await browser.close();
    if (process.env.REPORT_CACHE) fs.writeFileSync(process.env.REPORT_CACHE, JSON.stringify(cached));
  }
  const { live, ui, load, edgeVersion } = cached;

  const db = live.tests.constraints.map((t) => ({ ...t, area: t.name.split(':')[0] }));
  const api = live.tests.api;
  const suites = [
    ['Database integrity', 'tools/test-constraints.js', db, 'Each rule is broken on purpose directly in MySQL; the database must refuse.'],
    ['API / functional', 'tools/test-api.js', api, 'Every feature through the real HTTP API as an admin and three students at once.'],
    ['Browser / user interface', 'tools/test-ui.js', ui, 'The real pages in Microsoft Edge: clicking, typing, dialogs, phone-sized screens.'],
    ['Concurrency and performance', 'tools/test-load.js', load, '30 students at the same moment; response times.'],
  ];
  const all = suites.flatMap(([, , list]) => list);
  const passed = (list) => list.filter((t) => t.pass).length;
  const score = (list) => `${passed(list)}/${list.length}`;
  // The schema comparison counts as one more test.
  const schemaOk = live.tests.compare.startsWith('MATCH');
  const total = all.length + 1;
  const totalPassed = passed(all) + (schemaOk ? 1 : 0);
  const allPass = totalPassed === total;

  // Requirement → [suite list, areas]
  const pick = (list, areas) => list.filter((t) => areas.includes(t.area));
  const trace = [
    ['FR1', 'User management: register and log in securely; Student and Admin roles',
      [...pick(api, ['Accounts', 'Admin']), ...pick(ui, ['Accounts', 'People', 'Security', 'Admin']), ...db.filter((t) => /users|role/.test(t.name))]],
    ['FR2', 'Booking: see available machines in real time; book a date and slot; prevent double bookings; cancel or reschedule',
      [...pick(api, ['Booking', 'Reschedule', 'Cancel']), ...pick(ui, ['Booking']), ...pick(load, ['Concurrency']), ...db.filter((t) => /booking/i.test(t.name))]],
    ['FR3', 'Notifications: reminder before the booking; laundry done; next user when a machine is free',
      [...pick(api, ['Notifications', 'Waitlist', 'No-show', 'Cycle']), ...pick(ui, ['Notifications', 'Waitlist']), ...db.filter((t) => /notification|waiting/i.test(t.name))]],
    ['FR4', 'Laundry tips: sorting, detergents, fabrics, maintenance', [...pick(api, ['Tips']), ...pick(ui, ['Tips']), ...db.filter((t) => /tip/i.test(t.name))]],
    ['FR5', 'Feedback: rate the service or a machine; comments and issue reports; admin manages feedback',
      [...pick(api, ['Feedback']), ...pick(ui, ['Feedback']), ...db.filter((t) => /feedback|rating|issue|response/i.test(t.name))]],
    ['FR6', 'Administration: add, edit, remove machines; booking history and usage reports; act on feedback',
      [...pick(api, ['Rooms', 'Machines', 'Out of order', 'Reports', 'Integrity']), ...pick(ui, ['Machines', 'Reports']), ...db.filter((t) => /machine|room|outage|RESTRICT/i.test(t.name))]],
    ['NFR', 'Usability: simple, mobile-friendly', [...pick(ui, ['Mobile', 'Quality']), ...ui.filter((t) => /message|validation/i.test(t.name))]],
    ['NFR', 'Performance: loads quickly; many users booking at once', [...pick(load, ['Performance', 'Concurrency', 'Setup'])]],
    ['NFR', 'Reliability: booking data and notifications accurate and consistent', [...db, ...pick(api, ['Records'])]],
    ['NFR', 'Security: user data and passwords stored securely', [...pick(api, ['Admin']), ...pick(ui, ['Security']), ...api.filter((t) => /cannot|can't|403|404/i.test(t.name))]],
    ['NFR', 'Compatibility: web browsers and mobile devices', [...pick(ui, ['Mobile'])]],
  ];

  const content = [
    new Paragraph({ spacing: { before: 2000, after: 120 }, children: [new TextRun({ text: 'Campus Laundry Booking System', bold: true, size: 60, color: COLOR.primary, font: 'Cambria' })] }),
    new Paragraph({ spacing: { after: 400 }, children: [new TextRun({ text: 'Test Report', size: 40, color: COLOR.muted })] }),
    p(`${DATE} · ${total} automated tests · ${allPass ? 'all passed' : `${total - totalPassed} failed`}`, { run: { color: COLOR.muted } }),
    p('Students Campus Laundry Booking And Management System · Asemahle Sokaba · Avuziwe Mcata', { run: { color: COLOR.muted } }),
    new Paragraph({ children: [new PageBreak()] }),
    new Paragraph({ children: [new TextRun({ text: 'Contents', bold: true, size: 32, color: COLOR.primary, font: 'Cambria' })], spacing: { after: 200 } }),
    new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }),

    h1('1. Summary'),
    p(`The system was tested at four levels against the functional and non-functional requirements from the Phase 2 requirement analysis. **${totalPassed} of ${total} tests passed.** Testing also found four defects, which were fixed and retested (Section 5).`),
    table(['Test suite', 'What it tests', 'Tests', 'Result'],
      [...suites.map(([name, , list, what]) => [name, what, String(list.length), passed(list) === list.length ? `PASS ${score(list)}` : `FAIL ${score(list)}`]),
        ['Schema comparison', 'db/schema.sql builds exactly the same database as the migrations.', '1', schemaOk ? 'PASS (MATCH)' : 'FAIL'],
        ['Total', '', String(total), `${allPass ? 'ALL PASSED' : 'FAILURES'} ${totalPassed}/${total}`]],
      [0.22, 0.52, 0.09, 0.17]),
    spacer(),
    box('Every test creates its own temporary data (accounts on test-only email domains, a temporary laundry room) and deletes all of it afterwards, so the tests can be run safely on the real system at any time.', 'note'),

    h1('2. Test approach'),
    h2('2.1 Test levels'),
    table(['Level', 'Tool', 'How'], [
      ['Database integrity (unit level)', 'tools/test-constraints.js', 'Inserts test rows inside a transaction, then tries invalid statements straight against MySQL (bypassing the application) and checks the database refuses each one. Everything is rolled back.'],
      ['API / functional (integration)', 'tools/test-api.js', 'Acts as an administrator and three students at the same time through the real HTTP API, covering every create, read, update and delete, permissions and workflows. Time-based steps (cycle finishing, missed slot, reminder) move the test\'s own bookings in time in the database, then check the scheduler reacts.'],
      ['Browser / user interface (system)', 'tools/test-ui.js', 'Opens the real pages in Microsoft Edge (via Puppeteer) and clicks, types, answers dialogs and checks what appears on screen, as a student and an administrator in separate browser sessions, including a 375-pixel phone screen.'],
      ['Concurrency and performance (non-functional)', 'tools/test-load.js', '30 logged-in students send requests at exactly the same moment; response times are measured.'],
    ], [0.24, 0.22, 0.54]),
    h2('2.2 Test environment'),
    table(['Item', 'Version'], [
      ['Operating system', `${os.type()} ${os.release()} (${os.arch()})`],
      ['Node.js', process.version],
      ['MySQL', live.mysqlVersion],
      ['Browser', edgeVersion.replace(/^Edg\//, 'Microsoft Edge ').replace(/^HeadlessChrome\//, 'Microsoft Edge (headless) ')],
      ['Application', `Campus Laundry ${require(path.join(ROOT, 'package.json')).version}, http://localhost:${process.env.PORT || 3003}`],
    ], [0.3, 0.7]),
    h2('2.3 Pass criteria'),
    ...bullets([
      'Functional tests: the expected result happens and invalid actions are refused with the right HTTP status and a clear message.',
      'Concurrency: exactly one of many simultaneous bookings of one slot succeeds, and nothing is lost when bookings do not conflict.',
      'Performance: 95% of availability-grid requests under 300 ms; 30 simultaneous "My laundry" requests answered within 2 seconds; pages load in under 200 ms.',
      'Usability on phones: no page scrolls sideways on a 375-pixel screen (only the booking grid scrolls inside its box).',
    ]),

    h1('3. Requirements coverage'),
    p('Each requirement from the Phase 2 requirement analysis and the tests that cover it (a test can cover more than one requirement).'),
    table(['ID', 'Requirement', 'Tests', 'Result'],
      trace.map(([id, req, list]) => [id, req, String(list.length), list.length && passed(list) === list.length ? 'PASS' : list.length ? `FAIL (${list.length - passed(list)})` : 'NOT COVERED']),
      [0.08, 0.66, 0.1, 0.16]),

    h1('4. Results by suite'),
    ...suites.flatMap(([name, file, list]) => [
      h2(`${name} (${score(list)})`),
      p(`\`${file}\``),
      table(['Area', 'Test', 'Result'],
        list.map((t) => [t.area, t.detail ? `${t.name}\n${t.detail}` : t.name, t.pass ? 'PASS' : 'FAIL']), [0.17, 0.71, 0.12], { size: 16 }),
    ]),

    h1('5. Defects found during testing'),
    p('These problems were found by the tests and the browser checks, fixed, and the tests run again.'),
    table(['ID', 'Found by', 'Symptom', 'Cause and fix', 'Retest'], [
      ['D-01', 'Concurrency test', 'When 16 students booked different slots at the same moment, only 3 bookings were saved; the others got a server error.',
        'The booking transaction locked the student\'s existing bookings with SELECT … FOR UPDATE, which locks index ranges shared with other students, and MySQL detected deadlocks. Fixed by locking only the student\'s own users row, and by retrying a transaction automatically if MySQL ever reports a deadlock (lib/validate.js inTransaction).', 'PASS, 3 runs in a row'],
      ['D-02', 'Concurrency test', 'Five simultaneous bookings by one student did not reliably apply the limit of three open bookings.',
        'Same cause as D-01. With the student\'s row locked first, the bookings are counted one after the other.', 'PASS'],
      ['D-03', 'Performance test', 'Occasionally 30 students opening "My laundry" at once took 3.4 seconds.',
        'Opening MySQL connections costs up to a second when several open at once, and the connection pool closed idle connections after 60 seconds. Fixed by keeping idle connections for 10 minutes and opening them when the server starts (db/pool.js).', 'PASS (0.2–0.7 s), also after a 75-second idle pause'],
      ['D-04', 'Browser check', 'When a booking was refused (e.g. over the limit), the error message disappeared immediately.',
        'The page reloaded the grid after the error and the reload cleared the message. Fixed so the message is shown after the reload (public/book.html).', 'PASS (UI test "Booking")'],
    ], [0.08, 0.14, 0.24, 0.39, 0.15], { size: 16 }),

    h1('6. How to run the tests'),
    p('Start the app in one terminal, then run the tests in a second terminal in the project folder:'),
    ...command('npm start'),
    ...command('npm test'),
    p('`npm test` runs every suite. They can also be run one at a time:'),
    table(['Command', 'Suite'], [
      ['npm run db:check', 'Schema comparison and database integrity (does not need the app running)'],
      ['npm run test:api', 'API / functional'],
      ['npm run test:ui', 'Browser / user interface (needs Microsoft Edge and `npm install` with dev tools)'],
      ['npm run test:load', 'Concurrency and performance'],
      ['npm run docs:test-report', 'Runs everything and rebuilds this report'],
    ], [0.35, 0.65]),
    ...numbered([
      'Each suite prints PASS or FAIL for every test and a total at the end.',
      'All test data is removed automatically, even when a test fails.',
    ]),
  ];

  const doc = new Document({
    creator: 'Campus Laundry project team',
    title: 'Campus Laundry Booking System: Test Report',
    ...documentStyles(),
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } }, titlePage: true },
      footers: { first: new Footer({ children: [] }), default: footer('Campus Laundry · Test Report') },
      children: content.flat(), // a list helper added without ... would otherwise break the document
    }],
  });
  fs.writeFileSync(OUT, await Packer.toBuffer(doc));
  console.log(`Wrote ${OUT}`);
  console.log(`  ${totalPassed}/${total} tests passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
