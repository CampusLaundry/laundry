// Helpers shared by every page.

// Calls the API and returns the JSON body. Throws an Error with the server's message on failure.
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !location.pathname.endsWith('/') && !location.pathname.endsWith('/index.html')) {
      location.href = '/';
    }
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function param(name) {
  return new URLSearchParams(location.search).get(name);
}

function homeFor(user) {
  if (user.mustChangePassword) return '/profile.html';
  return user.role === 'admin' ? '/dashboard.html' : '/bookings.html';
}

// Makes sure someone is logged in (optionally with one of the given roles) and draws the header.
async function requireUser(...roles) {
  let user;
  try {
    user = await api('/api/auth/me');
  } catch {
    location.href = '/';
    return new Promise(() => {});
  }
  if (user.mustChangePassword && !location.pathname.endsWith('/profile.html')) {
    location.href = '/profile.html';
    return new Promise(() => {});
  }
  if (roles.length && !roles.includes(user.role)) {
    location.href = homeFor(user);
    return new Promise(() => {});
  }
  renderHeader(user);
  return user;
}

// Line icons for the sidebar (24×24, drawn with the current text colour).
const ICONS = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  basket: '<path d="M4 9h16l-1.5 10.5a2 2 0 0 1-2 1.5h-9a2 2 0 0 1-2-1.5z"/><path d="M8 9l4-5 4 5"/><path d="M9 13v4M15 13v4"/>',
  washer: '<rect x="4" y="3" width="16" height="18" rx="3"/><circle cx="12" cy="13" r="4.5"/><path d="M8 6.5h.01M11 6.5h5"/>',
  tip: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  logout: '<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4M6 12h10"/>',
};
const icon = (name) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
const LOGO = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="#2dd4bf"/><circle cx="20" cy="21" r="10" fill="#0b3b4a"/><path d="M12 22c3-3 5 3 8 0s5 3 8 0" stroke="#5eead4" stroke-width="2.4" fill="none" stroke-linecap="round"/><circle cx="31" cy="8" r="3" fill="#a5f3fc"/><circle cx="35" cy="14" r="1.8" fill="#a5f3fc"/></svg>';

// [href, label, short label for the phone tab bar, icon]
function navLinks(user) {
  if (user.role === 'admin') {
    return [['dashboard.html', 'Dashboard', 'Home', 'home'], ['book.html', 'Book', 'Book', 'washer'],
      ['admin-bookings.html', 'Bookings', 'Bookings', 'list'], ['machines.html', 'Machines & rooms', 'Machines', 'cog'],
      ['feedback.html', 'Feedback', 'Feedback', 'chat'], ['tips.html', 'Tips', 'Tips', 'tip'], ['admin.html', 'People', 'People', 'people']];
  }
  return [['bookings.html', 'My laundry', 'Mine', 'basket'], ['book.html', 'Book a machine', 'Book', 'washer'],
    ['tips.html', 'Laundry tips', 'Tips', 'tip'], ['feedback.html', 'Feedback', 'Feedback', 'chat']];
}

const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

// The app frame: a sidebar (a tab bar along the bottom on phones) and a top bar with
// the date, the notification bell and the user. Every page has <header><div class="inner">.
function renderHeader(user) {
  document.body.classList.add('app');
  const header = document.querySelector('header');
  header.classList.add('sidebar');
  const current = location.pathname.split('/').pop();
  const links = user.mustChangePassword ? '' : navLinks(user).map(([href, label, short, ico]) =>
    `<a href="${href}" class="${current === href ? 'active' : ''}">${icon(ico)}<span class="full">${label}</span><span class="short">${short}</span></a>`).join('');
  header.querySelector('.inner').innerHTML = `
    <a class="brand" href="${homeFor(user)}"><span class="logo">${LOGO}</span><span>Campus<br>Laundry</span></a>
    <nav class="nav">${links}</nav>
    <div class="side-foot">
      <a class="who" href="profile.html"><span class="avatar">${esc(initials(user.fullName))}</span>
        <span class="who-text"><strong>${esc(user.fullName)}</strong><span class="role">${user.role === 'admin' ? 'Administrator' : 'Student'}</span></span></a>
      <button class="ghost" data-logout>${icon('logout')}<span>Log out</span></button>
    </div>`;

  document.querySelector('.topbar')?.remove();
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  header.insertAdjacentHTML('afterend', `
    <div class="topbar">
      <a class="mini-brand" href="${homeFor(user)}"><span class="logo">${LOGO}</span>Campus Laundry</a>
      <span class="today">${esc(today)}</span>
      <div class="top-actions">
        ${user.mustChangePassword ? '' : `<a class="bell" href="notifications.html" title="Notifications">${icon('bell')}<span class="count ${user.unread ? '' : 'hidden'}" id="bell-count">${user.unread || ''}</span></a>`}
        <a class="avatar" href="profile.html" title="${esc(user.fullName)}">${esc(initials(user.fullName))}</a>
        <button class="icon-btn" data-logout title="Log out">${icon('logout')}</button>
      </div>
    </div>`);
  document.querySelectorAll('[data-logout]').forEach((b) => {
    b.onclick = async () => {
      await api('/api/auth/logout', { method: 'POST' });
      location.href = '/';
    };
  });
  if (!user.mustChangePassword) {
    clearInterval(window.bellTimer);
    window.bellTimer = setInterval(refreshBell, 30000);
  }
}

// Updates the unread count on the bell (also moves bookings along on the server).
async function refreshBell() {
  try {
    const { unread } = await api('/api/notifications/unread');
    const el = document.getElementById('bell-count');
    if (!el) return;
    el.textContent = unread || '';
    el.classList.toggle('hidden', !unread);
  } catch { /* ignore */ }
}

const BOOKING_STATUS = {
  booked: 'Booked', in_progress: 'Washing / drying', done: 'Done – collect now', collected: 'Collected', cancelled: 'Cancelled', no_show: 'Missed',
};
const FEEDBACK_STATUS = { new: 'New', in_progress: 'Being looked at', resolved: 'Resolved', dismissed: 'Closed' };
const FEEDBACK_KIND = { rating: 'Rating', comment: 'Comment', issue: 'Issue' };
const TIP_CATEGORY = { sorting: 'Sorting clothes', detergents: 'Choosing detergents', fabrics: 'Fabric types', maintenance: 'Machine care' };

function badge(kind, value, labels) {
  return `<span class="badge ${kind}-${value}">${labels[value] || esc(value)}</span>`;
}
const bookingBadge = (s) => badge('s', s, BOOKING_STATUS);
const feedbackBadge = (s) => badge('s', s, FEEDBACK_STATUS);
const kindBadge = (k) => badge('k', k, { washer: 'Washer', dryer: 'Dryer', ...FEEDBACK_KIND });
function roleBadge(role) {
  return role === 'admin' ? ' <span class="badge role-admin">admin</span>' : '';
}
const stars = (n) => `<span class="stars" title="${n} of 5">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>`;
const hhmm = (t) => String(t || '').slice(0, 5);

function formatDate(value) {
  return value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

// A DATE column ('YYYY-MM-DD') shown without any time-zone shift.
function formatDay(value, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  if (!value) return '';
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}

function todayInput(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayLabel(value) {
  if (value === todayInput()) return 'Today';
  if (value === todayInput(1)) return 'Tomorrow';
  return formatDay(value);
}

function timeAgo(value) {
  const seconds = Math.round((Date.now() - new Date(value)) / 1000);
  if (seconds < 60) return 'just now';
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [name, size] of units) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

// Shows a one-time temporary password.
function tempPasswordNotice(name, email, password) {
  return `<div class="success">
    <strong>New login details for ${esc(name)}:</strong><br>
    Email: <strong>${esc(email)}</strong><br>
    Temporary password: <span class="temp-password">${esc(password)}</span><br>
    <span class="small">They will choose their own password when they next log in. This password won't be shown again.</span>
  </div>`;
}

// Fills a <select> with rooms or machines.
function optionsHtml(items, selectedId, placeholder, label = (i) => i.name) {
  return (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') +
    items.map((i) => `<option value="${i.id}" ${Number(selectedId) === i.id ? 'selected' : ''}>${esc(label(i))}</option>`).join('');
}

// Shows a message at the top of the page for a few seconds.
function flash(message) {
  const el = document.getElementById('banner');
  el.innerHTML = `<div class="success">${esc(message)}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 5000);
}
