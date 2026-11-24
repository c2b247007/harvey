let currentTab = 'today';
let companyDrill = false;      // true while viewing a single company's contacts
let _companies = [], _prospects = [], _campaigns = [];
let _signals = null;           // last /api/signals payload, for the cohort builder
let _desk = { items: [], i: 0 };

// ── Appearance ──
//
// Three states, not two: "auto" follows the OS and is the default, so the
// dashboard matches the rest of your machine until you deliberately override
// it. Stored per-browser; nothing is sent anywhere.

const THEMES = ['auto', 'light', 'dark'];

function applyTheme(mode) {
  const root = document.documentElement;
  // Every colour would transition at once and smear: switch with none, for one frame.
  root.classList.add('theme-swap');
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  document.querySelectorAll('[data-theme-opt]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.themeOpt === mode)));
  void root.offsetHeight;
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-swap')));
}

function currentTheme() {
  try { return localStorage.getItem('sellbird-theme') || 'auto'; } catch { return 'auto'; }
}

function setTheme(mode) {
  try { localStorage.setItem('sellbird-theme', mode); } catch { /* private mode */ }
  applyTheme(mode);
}

(function initTheme() {
  let saved = 'auto';
  try {
    // Carry the choice over from Harvey, Sellbird's old name.
    const legacy = localStorage.getItem('harvey-theme');
    if (legacy && !localStorage.getItem('sellbird-theme')) localStorage.setItem('sellbird-theme', legacy);
    if (legacy) localStorage.removeItem('harvey-theme');
    saved = localStorage.getItem('sellbird-theme') || 'auto';
  } catch { /* ignore */ }
  applyTheme(THEMES.includes(saved) ? saved : 'auto');
})();

// ── Utilities ──

function escHtml(s) {
  if (s === null || s === undefined || s === '') return '';
  return String(s).replace(/[&<>"']/g, ch => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]
  ));
}

// A value placed inside an onclick handler as a JS string: JSON-quote it,
// then escape for the attribute (escHtml alone is undone before the JS runs).
function jsq(v) {
  return escHtml(JSON.stringify(String(v ?? '')));
}

// The reason a failed action gave, or a fallback when it gave none.
function failMsg(data, fallback) {
  return (data && (data.message || data.error || data.detail)) || fallback;
}

// Lookup tables keyed by stored strings: "constructor" must not hit Object's.
function own(table, key) {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

// Links built from collected data (websites, profiles) open only as http(s):
// a javascript: URL from a scraped page must never run in the dashboard.
function safeHref(u) {
  const s = String(u || '').trim();
  return /^https?:\/\//i.test(s) ? escHtml(s) : '';
}

// ── One status vocabulary ──
//
// Sellbird's tables each carry their own words for state: a prospect is `new`,
// a campaign is `draft`, an email is `pending_review`, a signal is `proposed`.
// Five of those mean "waiting on you" and the old dashboard styled every one
// differently. Everything now resolves through this map, so a status reads the
// same way no matter which table it came out of.
//
// tone: waiting (needs a human) | active (in flight) | good | bad | idle
const STATUS = {
  // prospects
  new:            ['New', 'active'],
  contacted:      ['Contacted', 'active'],
  replied:        ['Replied', 'good'],
  accepted_offer: ['Said yes to your offer', 'good'],
  interested:     ['Interested', 'good'],
  meeting:        ['Meeting booked', 'note'],
  not_interested: ['Not interested', 'bad'],
  bounced:        ['Bounced', 'bad'],
  write_failed:   ["Couldn't write", 'bad'],
  no_tip:         ['Nothing to write about yet', 'idle'],
  queued:         ['Queued', 'active'],
  opted_out:      ['Opted out', 'bad'],
  // campaigns
  draft:          ['Draft', 'waiting'],
  active:         ['Active', 'good'],
  completed:      ['Completed', 'idle'],
  paused:         ['Paused', 'bad'],
  // conversations
  open:           ['Open', 'active'],
  closed:         ['Closed', 'idle'],
  closed_won:     ['Won', 'good'],
  closed_lost:    ['Lost', 'bad'],
  objection:      ['Objection', 'waiting'],
  question:       ['Question', 'active'],
  ooo:            ['Out of office', 'idle'],
  wrong_person:   ['Wrong person', 'waiting'],
  unsubscribe:    ['Unsubscribed', 'bad'],
  escalate:       ['Needs a human', 'bad'],
  needs_human:    ['Needs you', 'waiting'],
  // outbox
  pending_review: ['Waiting on you', 'waiting'],
  approved:       ['Approved', 'good'],
  sending:        ['Sending now', 'active'],
  scheduled:      ['Scheduled', 'active'],
  sent:           ['Sent', 'good'],
  awaiting_reply: ['Awaiting reply', 'active'],
  failed:         ['Failed', 'bad'],
  rejected:       ['Rejected', 'idle'],
  cancelled:      ['Cancelled', 'idle'],
  // signals
  proposed:       ['Waiting on you', 'waiting'],
  confirmed:      ['Confirmed', 'good'],
  // email deliverability
  verified:       ['Verified', 'good'],
  risky:          ['Catch-all', 'waiting'],
  guess:          ['Unverified', 'idle'],
  invalid:        ['Invalid', 'bad'],
  // runs
  running:        ['Running', 'active'],
  stale:          ['Stale', 'bad'],
  stalled:        ['Stopped', 'bad'],
};

function statusMeta(status) {
  const key = String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const hit = own(STATUS, key);
  if (hit) return { label: hit[0], tone: hit[1] };
  const label = String(status || 'unknown').replace(/_/g, ' ');
  return { label: label.charAt(0).toUpperCase() + label.slice(1), tone: 'idle' };
}

function badge(status) {
  const m = statusMeta(status);
  return '<span class="badge t-' + m.tone + '">' + escHtml(m.label) + '</span>';
}

function formatDate(d) {
  if (!d) return '';
  try {
    let t = String(d).trim().replace(' ', 'T');
    if (/^\d{4}-\d\d-\d\dT/.test(t) && !/[zZ]$|[+-]\d\d:?\d\d$/.test(t)) t += 'Z';  // stored UTC
    const dt = new Date(t);
    if (isNaN(dt)) return escHtml(d);
    return dt.toLocaleString('en-US', {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  } catch { return escHtml(d); }
}

// ── Small render helpers ──

// The sprite in index.html holds every icon; this just references one.
function icon(name, cls) {
  return '<svg class="icon' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
}

function initials(first, last) {
  const a = String(first || '').trim(), b = String(last || '').trim();
  const ch = x => Array.from(x)[0] || '';  // whole characters, not UTF-16 halves
  const s = (ch(a) + ch(b)) || '?';
  return escHtml(s.toUpperCase());
}

// Stored times are UTC, often without a zone ("2026-10-21 03:07:57").
function parseTs(d) {
  let t = String(d || '').trim().replace(' ', 'T');
  if (t && !/[zZ]$|[+-]\d\d:?\d\d$/.test(t)) t += 'Z';
  return new Date(t);
}

// "3m ago", "5h ago", "Yesterday", then a date: recent things read faster.
function relTime(d) {
  if (!d) return '';
  const dt = parseTs(d);
  if (isNaN(dt)) return escHtml(d);
  const mins = Math.round((Date.now() - dt) / 60000);
  if (mins < -1 && mins > -60) return 'in ' + -mins + 'm';
  if (mins < -1 && mins > -60 * 24) return 'in ' + Math.round(-mins / 60) + 'h';
  if (mins >= -1 && mins < 1) return 'just now';
  if (mins >= 1 && mins < 60) return mins + 'm ago';
  if (mins >= 60 && mins < 60 * 24) return Math.round(mins / 60) + 'h ago';
  if (mins >= 60 * 24 && mins < 60 * 48) return 'Yesterday';
  const opts = {month: 'short', day: 'numeric'};
  if (dt.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return dt.toLocaleDateString('en-US', opts);
}

function dayLabel(d) {
  const dt = parseTs(d);
  if (isNaN(dt)) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(dt); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return dt.toLocaleDateString('en-US', {weekday: 'long', month: 'short', day: 'numeric'});
}

function timeOfDay(d) {
  const dt = parseTs(d);
  return isNaN(dt) ? '' : dt.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'});
}

// Columns of a tiny bar chart; the last day is "today".
// A small line with its last point marked: the shape of a 14-day trend.
function sparkBars(values, title, tone) {
  const vals = (values || []).map(v => Number(v) || 0);
  if (vals.length < 2) return '';
  const max = Math.max(...vals), min = Math.min(...vals), span = max - min || 1;
  const pts = vals.map((v, i) => [Math.round((i / (vals.length - 1)) * 60 + 2), Math.round(20 - ((v - min) / span) * 17)]);
  const c = tone === 'good' ? 'var(--good-solid)' : 'var(--accent)';
  const last = pts[pts.length - 1];
  return '<svg class="sparkline" viewBox="0 0 64 22" role="img" aria-label="' + escHtml(title || 'trend') + '">' +
    '<polyline points="' + pts.map(p => p.join(',')).join(' ') + '" fill="none" stroke="' + c +
    '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>' +
    '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="2.2" fill="' + c + '"/></svg>';
}

// ── Agent first: the answer line, the agent's name, its log ──

const LOCK_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="7.5" width="8" height="6" rx="1.2"/>' +
  '<path d="M5.8 7.5V5.6a2.2 2.2 0 0 1 4.4 0v1.9"/></svg>';
const SPARK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>';
// A decision only the person can make: approve, send, buy, resume.
function onlyYou() {
  return '<span class="only-you" title="Your agent can\'t do this; only you can">' + LOCK_SVG + 'Only you</span>';
}

let _report = null;     // /api/agent/report: name, chip, the day, the log
function agentName() { return (_report && _report.name) || 'Your agent'; }
function agentWho() { return '<span class="agent-name">' + escHtml(agentName()) + '</span>'; }

// The page opens with an eyebrow, one badge and a sentence that says where things stand.
function setAnswer(screen, badgeHtml, sentenceHtml, eyebrow) {
  const head = document.querySelector('#' + screen + ' .section-head');
  if (!head) return;
  const box = head.firstElementChild;
  const h1 = box.querySelector('h1');
  let row = box.querySelector('.headrow');
  if (!row) {
    row = document.createElement('div');
    row.className = 'headrow';
    h1.replaceWith(row);
    row.appendChild(h1);
    row.insertAdjacentHTML('beforeend', '<span class="head-badge"></span>');
  }
  if (eyebrow) h1.textContent = eyebrow;
  row.querySelector('.head-badge').innerHTML = badgeHtml || '';
  let p = box.querySelector('p.answer') || box.querySelector('p');
  if (!p) { p = document.createElement('p'); box.appendChild(p); }
  p.className = 'answer';
  p.innerHTML = sentenceHtml;
  head.classList.add('has-answer');
}
function toneBadge(tone, text) {
  return '<span class="badge ' + tone + '">' + escHtml(text) + '</span>';
}
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

// The chip in the top bar: is the agent at work, connected, or not there.
function renderAgentChip() {
  const el = document.getElementById('agent-chip');
  if (!el || !_report) return;
  const name = agentName();
  const words = {
    working: '<b>' + escHtml(name) + '</b> is working',
    connected: '<b>' + escHtml(name) + '</b> connected',
    not_connected: 'Agent not connected',
    off: 'Agent cut off',
  };
  const state = own(words, _report.chip) ? _report.chip : 'not_connected';
  el.className = 'agentchip ' + state.replace('_', '-');
  if (state === 'working') el.classList.add('working');
  if (state === 'connected') el.classList.add('connected');
  el.querySelector('.lbl').innerHTML = words[state];
  el.setAttribute('aria-label', el.querySelector('.lbl').textContent + '. Open Your agent');
}

async function loadAgentReport() {
  const d = await api('/api/agent/report');
  if (d && !d.error && d.day) { _report = d; renderAgentChip(); }
  return _report;
}

// One line of the agent's log: what it did through Sellbird, or what you did.
function logLine(e) {
  const a = {action_type: e.action_type, agent: e.by, details: e.details || {}, created_at: e.at};
  let text = e.action_type === 'agent_call'
    ? 'Through its own key: ' + escHtml((e.details || {}).what || 'a change')
    : actionText(a);
  if (e.times > 1) text += ' <span class="muted">(' + e.times + ' times)</span>';
  const you = e.who === 'you';
  return '<div class="logrow"><span class="lt">' + relTime(e.at) + '</span>' +
    '<span class="mk' + (you ? ' you' : '') + '" title="' + (you ? 'You' : escHtml(agentName())) + '">' +
      (you ? CHECK_SVG : SPARK_SVG) + '</span>' +
    '<span class="lb">' + text +
      (e.via === 'sellbird' ? '<span class="ls">Through Sellbird</span>' : '') + '</span></div>';
}
function logHtml(entries, empty) {
  if (!entries || !entries.length) return '<p class="log-empty">' + escHtml(empty) + '</p>';
  return '<div class="log">' + entries.map(logLine).join('') + '</div>';
}

// "Ask your agent to change it": put a ready prompt on the clipboard.
async function copyPrompt(text) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    try {
      const t = document.createElement('textarea');
      t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select(); ok = document.execCommand('copy'); t.remove();
    } catch { ok = false; }
  }
  showToast(ok ? 'Copied a prompt. Paste it to ' + agentName() + '.' : 'Couldn\'t copy. The prompt: ' + text, ok ? 'success' : 'info');
}

// A segmented meter, 0-100.
function meterHtml(pct, segments) {
  const n = segments || 10;
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  const on = Math.round(v / 100 * n);
  return '<span class="meter-row"><span class="meter" role="meter" aria-valuemin="0" ' +
    'aria-valuemax="100" aria-valuenow="' + v + '">' +
    Array.from({length: n}, (_, i) => '<i class="' + (i < on ? 'on' : '') + '"></i>').join('') +
    '</span><span class="v">' + v + '</span></span>';
}

const SOURCE_LABELS = {
  company_website: 'Team page', known_company_backfill: 'Team page',
  scraped_mailto: 'Published address', hunter_domain_search: 'Hunter', linkedin_search: 'LinkedIn',
  job_board: 'Job board', web_search: 'Web search', company_inbox: 'Company inbox',
  osm: 'OpenStreetMap', dataforseo_listings: 'DataForSEO', dataforseo_serp: 'DataForSEO SERP', dataforseo_maps: 'DataForSEO Maps',
  serper: 'Serper', tinyfish: 'TinyFish', scavio_maps: 'Scavio Maps', scavio_search: 'Scavio Search',
};
function sourceLabel(s) {
  if (!s) return '';
  return escHtml(Object.prototype.hasOwnProperty.call(SOURCE_LABELS, s) ? SOURCE_LABELS[s]
    : String(s).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()));
}

const AGENT_ICONS = {scout: 'discover', writer: 'pen', sender: 'campaigns', handler: 'message',
                     analyst: 'usage', user: 'contacts', main: 'refresh'};
// One plain sentence per logged action, from the details each agent records.
function actionText(a) {
  const d = a.details || {};
  const who = escHtml(d.prospect_email || d.prospect || d.to || '');
  const camp = escHtml(d.campaign_name || d.campaign || '');
  const intent = d.intent ? ' · ' + escHtml(String(d.intent).replace(/_/g, ' ')) : '';
  const n = (v, one, many) => (Number(v) || 0) + ' ' + ((Number(v) || 0) === 1 ? one : many);
  switch (a.action_type) {
    case 'prospect': return 'Found ' + n(d.prospects_found, 'new contact', 'new contacts');
    case 'write_campaign': return 'Wrote “' + camp + '” for ' + n(d.prospect_count, 'contact', 'contacts');
    case 'write_failed': return 'Couldn’t write for some contacts' + (camp ? ' in “' + camp + '”' : '');
    case 'stage_campaign': return 'Queued ' + n(d.staged, 'email', 'emails') + ' from “' + camp + '”' +
      (d.mode ? ' · ' + escHtml(d.mode) : '');
    case 'send_campaign': return 'Sent “' + camp + '” to Instantly · ' + n(d.leads_added, 'lead', 'leads');
    case 'email_sent': return d.kind === 'reply' ? 'Sent a reply to ' + who
      : 'Sent email ' + escHtml(String(d.step || 1)) + ' to ' + who;
    case 'reply': return 'Answered ' + who + intent;
    case 'reply_queued': return 'Drafted a reply to ' + who + intent;
    case 'opt_out': return who + ' opted out' + (d.why ? ' · ' + escHtml(d.why) : '');
    case 'opt_out_undone': return 'You undid ' + (who || 'a contact') + '’s opt-out';
    case 'reply_after_opt_out': return who + ' wrote again after opting out · no reply sent';
    case 'escalation': return 'Flagged ' + who + ' for you' + (d.reason ? ' · ' + escHtml(d.reason) : '');
    case 'bounce': return 'Email to ' + who + ' bounced';
    case 'manual_send': return 'You marked a contact as emailed by hand';
    case 'manual_send_undone': return 'You undid a hand-sent mark';
    case 'outbox_edited': return 'You edited a draft';
    case 'stage_change': return (d.by === 'sellbird' ? 'Moved ' : (d.by === 'agent' ? 'Your agent moved ' : 'You moved ')) +
      (who || 'someone') + ' to ' + escHtml(String(d.to || '').replace(/_/g, ' ')) + (d.reason ? ' · ' + escHtml(d.reason) : '');
    case 'lead_added': return (d.via === 'agent' ? 'Your agent added a lead' : d.via === 'form_email' ? 'A form email became a lead'
      : 'You added a lead') + (d.held ? ' · on your never-email list, no answer drafted' : d.new_person ? ' · a new person' : '');
    case 'lead_answer_drafted': return 'A first answer to a lead was drafted · it waits in the Outbox';
    case 'lead_dismissed': return 'You set a lead aside';
    case 'mentions_checked': return 'Checked for mentions · ' + n(d.found || 0, 'new one', 'new ones') + ' from ' + n(d.searches || 0, 'search', 'searches') +
      (d.problems ? ' · ' + n(d.problems, 'source failed', 'sources failed') : '');
    case 'mention_watch_added': return (d.proposed ? 'Your agent proposed a term to watch · off until you turn it on' : 'You started watching a term');
    case 'mention_became_lead': return 'A mention became a lead';
    case 'social_post_drafted': return (a.agent === 'agent' ? 'Your agent drafted' : 'You drafted') + ' a social post · it waits for you';
    case 'social_post_approved': return 'You approved a social post';
    case 'social_post_posted': return 'A social post you approved was marked as posted';
    case 'social_playbook_switched': return 'You turned a social playbook ' + (d.on ? 'on' : 'off');
    case 'text_sent': return 'Sent a text';
    case 'text_drafted': return (d.by === 'agent' ? 'Your agent drafted' : 'You drafted') + ' a text';
    case 'text_approved': return 'You approved a text';
    case 'text_blocked': return 'Held a text: the consent check said no';
    case 'text_opt_out': return 'A number replied STOP' + (d.cancelled ? ' · ' + n(d.cancelled, 'queued text', 'queued texts') + ' cancelled' : '');
    case 'consent_recorded': return 'You recorded consent · ' + escHtml(d.channel === 'call' ? 'calls' : 'texts') + ' · ' + escHtml(d.status === 'granted' ? 'yes' : 'taken back');
    case 'meeting_booked': return 'Meeting booked' + (d.cancelled ? ' · ' + n(d.cancelled, 'queued email', 'queued emails') + ' cancelled' : '');
    case 'agent_connect': {
      const name = own({'claude': 'Claude Code', 'claude-desktop': 'Claude desktop', 'codex': 'Codex'}, d.agent) || 'an agent';
      return d.action === 'remove' ? 'You took Sellbird out of ' + name : 'You connected Sellbird to ' + name;
    }
    case 'pane_link_made': return 'Opened the dashboard in its browser pane';
    case 'agent_access_off': return 'You cut your agent off';
    case 'agent_access_on': return 'You let your agent back in';
    case 'panes_signed_out': return 'You signed your agent\'s browser panes out';
    case 'conversation_status':
      return d.to === 'closed' ? 'You closed a conversation'
        : d.from === 'needs_human' ? 'You handed a conversation back to Sellbird' : 'You reopened a conversation';
  }
  const text = escHtml(String(a.action_type || '').replace(/_/g, ' '));
  return a.agent === 'main' ? 'Heartbeat: ' + text : text;
}

function emptyState(glyph, title, copy) {
  return '<div class="empty"><div class="glyph">' + glyph + '</div>' +
    '<div class="title">' + title + '</div>' +
    '<div class="copy">' + copy + '</div></div>';
}

function offlineState() {
  return emptyState('&#9888;', 'Dashboard can\'t reach the server',
    'The dashboard process may have stopped. Restart it with <b>sellbird dashboard</b> and refresh this page.');
}

async function api(path, opts) {
  try {
    const r = await authFetch(path, opts);
    if (await lockIfRefused(r)) return null;
    if (!r.ok) {
      // An action the server refused says why ("a run is already going");
      // pass that body on so the toast can show it. Reads stay null.
      if (!opts || !opts.method || opts.method === 'GET') return null;
      const body = await r.json().catch(() => null);
      return body && typeof body === 'object' ? {success: false, ...body} : null;
    }
    return await r.json();
  } catch {
    return null;
  }
}

// ── Locked: no token, a wrong one, or the server can't load its own ──

let _locked = false;

async function lockIfRefused(r) {
  if (r.status !== 401 && r.status !== 503) {
    if (r.ok && _locked) hideLock();
    return false;
  }
  let why = '';
  if (r.status === 503) {
    try { why = ((await r.json()) || {}).message || ''; } catch { /* ignore */ }
  }
  showLock(r.status === 503
    ? 'The dashboard server can\'t use its token file, so it is refusing every request. ' + why
    : signInFailed && !authToken()
      ? 'This sign-in link was used already or has expired. Ask your agent to open the dashboard again.'
    : authToken()
      ? 'The saved token was not accepted (the dashboard may have signed this tab out).'
      : 'This tab doesn\'t have the dashboard token yet.');
  return true;
}

function showLock(reason) {
  _locked = true;
  const el = document.getElementById('lock-screen');
  if (!el) return;
  document.getElementById('lock-reason').textContent = reason;
  el.style.display = 'flex';
  const dot = document.getElementById('header-dot');
  const text = document.getElementById('header-status-text');
  if (dot) dot.className = 'status-dot offline';
  if (text) text.textContent = 'Locked';
}

function hideLock() {
  _locked = false;
  const el = document.getElementById('lock-screen');
  if (el) el.style.display = 'none';
}

function unlockWithToken(event) {
  event.preventDefault();
  const input = document.getElementById('lock-token');
  const value = (input.value || '').trim();
  input.value = '';
  if (!setAuthToken(value)) {
    document.getElementById('lock-reason').textContent =
      'That doesn\'t look like a dashboard token. Copy it again from the link or data/dashboard-token.';
    return;
  }
  hideLock();
  loadCurrentTab();
  loadSellbirdStatus();
}

// Downloads go through the same authorised fetch and are handed to the
// browser as a local blob, so no download URL ever carries the token.
async function downloadCsv(path, filename, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await authFetch(path);
    if (await lockIfRefused(r)) return;
    if (!r.ok) { showToast('Export failed.', 'error'); return; }
    const href = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10000);
  } catch {
    showToast('Export failed. Is the dashboard still running?', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function showToast(msg, type) {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

function toggleVisibility(inputId) {
  const el = document.getElementById(inputId);
  el.type = el.type === 'password' ? 'text' : 'password';
}

// ── Tabs ──

// Seven places in the dock. Each screen belongs to one place: a place with
// several views shows them as quiet tabs (Outbound, Inbound, People,
// Numbers), and Set up is a list that opens each of its screens with a way back.
const SCREENS = {
  today:         {place: 'today'},
  outbox:        {place: 'outbound', pill: 'Waiting for you', count: 'nav-outbox'},
  conversations: {place: 'outbound', pill: 'Replies', count: 'nav-conversations'},
  campaigns:     {place: 'outbound', pill: 'Campaigns'},
  discover:      {place: 'outbound', pill: 'Find businesses'},
  signals:       {place: 'outbound', pill: 'Signals', count: 'nav-signals'},
  social:        {place: 'outbound', pill: 'Social', count: 'nav-social'},
  leads:         {place: 'inbound', pill: 'Leads', count: 'nav-leads'},
  texts:         {place: 'inbound', pill: 'Texts', count: 'nav-texts'},
  mentions:      {place: 'inbound', pill: 'Mentions', count: 'nav-mentions'},
  mentionsetup:  {place: 'inbound', parent: 'mentions'},
  prospects:     {place: 'people', pill: 'People'},
  companies:     {place: 'people', pill: 'Companies'},
  person:        {place: 'people', parent: 'prospects'},
  calendar:      {place: 'calendar'},
  numbers:       {place: 'numbers', pill: 'Overview'},
  usage:         {place: 'numbers', pill: 'Model usage'},
  setup:         {place: 'setup'},
  suite:         {place: 'setup', parent: 'setup'},
  company:       {place: 'setup', parent: 'setup'},
  inboxes:       {place: 'setup', parent: 'setup'},
  settings:      {place: 'setup', parent: 'setup'},
  controls:      {place: 'setup', parent: 'setup'},
  activity:      {place: 'setup', parent: 'setup'},
  events:        {place: 'setup', parent: 'setup'},
  texting:       {place: 'setup', parent: 'setup'},
  records:       {place: 'setup', parent: 'setup'},
  neveremail:    {place: 'setup', parent: 'setup'},
  limits:        {place: 'setup', parent: 'setup'},
  agent:         {place: 'setup', parent: 'setup'},
  help:          {place: 'setup', parent: 'setup'},
};
// The dock's own names, and the old tab names links may still carry.
const SCREEN_ALIASES = {outbound: 'outbox', inbound: 'leads', inbox: 'conversations', people: 'prospects',
                        contacts: 'prospects', replies: 'conversations'};
// Screens that are one decision or one form stay chat width.
const CARD_SCREENS = ['company', 'settings', 'controls', 'help'];
const PARENT_NAMES = {setup: 'Set up', prospects: 'People', mentions: 'Mentions'};
let _personId = '';     // whose page the person screen shows

// A fragment is a screen, or "person/<id>" for one person's page.
function fromHash() {
  const raw = (window.location.hash || '').slice(1);
  if (raw.slice(0, 7) === 'person/') {
    try { _personId = decodeURIComponent(raw.slice(7)); } catch { _personId = ''; }
    return _personId ? 'person' : 'prospects';
  }
  if (raw === 'person' && !_personId) return 'prospects';
  return raw || 'today';
}
let _lastScreen = {};   // the view each place was last on, so the dock returns to it
let _counts = {};       // badge numbers by element id, kept across re-renders

function screenId(id) {
  const key = String(id || '').toLowerCase();
  if (own(SCREENS, key)) return key;
  return own(SCREEN_ALIASES, key) || 'today';
}

function renderScreenNav(id) {
  const el = document.getElementById('screen-nav');
  if (!el) return;
  const s = SCREENS[id];
  let html = '';
  if (s.parent) {
    html += '<button type="button" class="back" onclick="goTab(' + jsq(s.parent) + ')">' +
      '<svg class="icon" aria-hidden="true" viewBox="0 0 16 16"><path d="M10 3 5 8l5 5"/></svg>' +
      escHtml(own(PARENT_NAMES, s.parent) || 'Back') + '</button>';
  }
  const views = Object.keys(SCREENS).filter(k => SCREENS[k].place === s.place && SCREENS[k].pill);
  if (views.length > 1 && s.pill) {
    html += '<div class="pills" role="tablist" aria-label="Views">' + views.map(k =>
      '<button type="button" role="tab" class="pill' + (k === id ? ' on' : '') + '" aria-selected="' + (k === id) +
      '" onclick="goTab(' + jsq(k) + ')">' + escHtml(SCREENS[k].pill) +
      (SCREENS[k].count ? '<span class="nav-count' + (_counts[SCREENS[k].count] > 0 ? ' on' : '') + '" id="' +
        SCREENS[k].count + '">' + (_counts[SCREENS[k].count] > 0 ? _counts[SCREENS[k].count] : '') + '</span>' : '') +
      '</button>').join('') + '</div>';
  }
  el.innerHTML = html;
  // A way back goes above the page head; a place's views go under its answer.
  const head = document.querySelector('#' + id + ' .section-head, #' + id + ' .person-head');
  if (head && !s.parent && s.pill) head.after(el);
  else if (head) head.before(el);
}

const _scrollAt = {};   // where each screen was scrolled to, for Back
function showTab(id, opts) {
  opts = opts || {};
  id = screenId(id);
  const changed = id !== currentTab;
  if (changed) _scrollAt[currentTab] = window.scrollY;
  currentTab = id;
  const s = SCREENS[id];
  _lastScreen[s.place] = id;
  if (id === 'companies') companyDrill = false;
  document.querySelectorAll('.section').forEach(x => x.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.querySelectorAll('.navitem').forEach(b => {
    const on = b.dataset.place === s.place;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const inner = document.getElementById('inner');
  if (inner) inner.classList.toggle('is-card', CARD_SCREENS.includes(id));
  renderScreenNav(id);
  if (!opts.fromHash) {
    const frag = '#' + (id === 'person' && _personId ? 'person/' + encodeURIComponent(_personId) : id);
    try { if (window.location.hash !== frag) history.pushState(null, '', frag); } catch { /* ignore */ }
  }
  // After the first screen, a page change is a 150ms fade, never a slide.
  if (changed && !opts.initial) {
    document.body.classList.remove('first-load');
    document.body.classList.remove('routed');
    void document.body.offsetWidth;
    document.body.classList.add('routed');
  }
  if (changed && opts.fromHash && _scrollAt[id] !== undefined) {
    window.scrollTo(0, _scrollAt[id]);
  } else if (changed && !opts.keepScroll) {
    window.scrollTo(0, 0);
    const title = document.querySelector('#' + id + ' .section-head h1');
    if (title && opts.focus !== false) title.focus({preventScroll: true});
  }
  loadCurrentTab();
}

// Go to a screen by name. The dock passes a place ("outbound"), which opens the
// view that place was last on.
function goTab(id) {
  const key = String(id || '').toLowerCase();
  const place = ['outbound', 'inbound', 'people', 'numbers'].includes(key) ? key : null;
  showTab(place && _lastScreen[place] ? _lastScreen[place] : id);
}

window.addEventListener('popstate', () => showTab(fromHash(), {fromHash: true}));

function loadCurrentTab() {
  switch (currentTab) {
    case 'calendar': loadCalendar(); break;
    case 'numbers': loadNumbers(); break;
    case 'setup': loadSetup(); break;
    case 'events': loadEvents(); break;
    case 'leads': loadLeads(); break;
    case 'texts': loadTexts(); break;
    case 'suite': loadSuite(); break;
    case 'mentions': loadMentions(); break;
    case 'mentionsetup': loadMentionSetup(); break;
    case 'social': loadSocial(); break;
    case 'texting': loadTexting(); break;
    case 'records': loadRecords(); break;
    case 'neveremail': loadNeverEmail(); break;
    case 'limits': loadLimits(); break;
    case 'agent': loadAgent(); break;
    case 'person': loadPerson(); break;
    case 'today': loadLiveStatus(); loadRenameNotice(); loadToday(); loadTrend(); loadFunnel(); loadSetupStatus(); loadTodaySuite(); loadRuns(); loadTodayActivity(); break;
    case 'signals': loadSignals(); break;
    case 'discover': loadDiscoverProviders(); break;
    case 'companies': if (!companyDrill) loadCompanies(); break;
    case 'prospects': loadProspects(); break;
    case 'campaigns': loadCampaigns(); break;
    case 'outbox': loadOutbox(); break;
    case 'conversations': loadConversations(); break;
    case 'activity': loadActivity(); break;
    case 'inboxes': loadInboxes(); break;
    case 'usage': loadUsage(); break;
    case 'settings': loadSettings(); loadSendingModeCard(); break;
    case 'company': loadCompany(); break;
    case 'controls': loadSellbirdStatus(); loadLogs(); break;
  }
}

// ── Today: what needs a human ──

async function loadToday() {
  const data = await api('/api/today');
  const el = document.getElementById('today-queue');
  if (!data) { el.innerHTML = offlineState(); return; }
  if (data.error) {
    // A failed check must never read as "Nothing needs you".
    el.innerHTML = emptyState(icon('alert'), 'Couldn\'t check what needs you',
      'The dashboard hit an error reading Sellbird\'s data: ' + escHtml(data.error));
    return;
  }

  applyCounts(data);
  _todayStats = data.stats || {};
  renderFigures(_todayStats);

  const items = data.items || [];
  const needs = items.filter(i => i.tone !== 'good').length;
  await todayAnswer(data, needs);
  const panel = document.getElementById('today-needs');
  if (panel) {
    panel.classList.toggle('attn', needs > 0);
    panel.querySelector('h2').innerHTML = 'Needs you' + (needs ? '<span class="h-right">' + onlyYou() + '</span>' : '');
  }
  if (!items.length) {
    el.innerHTML = '<div class="w"><div class="row">' +
      '<span class="who tone-good" aria-hidden="true">' + icon('check') + '</span><div class="grow">' +
      '<p class="t">Nothing needs you</p>' +
      '<p class="s">Sellbird has everything it needs. Anything that takes a decision, ' +
      'like an email to approve or a signal to confirm, shows up here.</p>' +
      '</div></div></div>';
    return;
  }

  const glyph = {bad: 'alert', warn: 'flag', good: 'check'};
  el.innerHTML = '<div class="w">' + items.map(it => {
    const tone = own(glyph, it.tone) ? it.tone : 'warn';
    const head = '<span class="who tone-' + tone + '" aria-hidden="true">' + icon(glyph[tone]) + '</span>' +
      '<div class="grow">' +
        '<p class="t">' + escHtml(it.title) + '</p>' +
        '<p class="s">' + escHtml(it.detail) + '</p>' +
      '</div>';
    // A decision (review, approve, confirm, resume) keeps its button; a row
    // that only opens a screen is the link itself.
    if (!isDecision(it.action)) return linkRow(it.tab, head, it.action);
    return '<div class="row">' + head +
      '<button class="btn btn-sm rowbtn ' + (tone === 'good' ? 'btn-secondary' : 'btn-primary') +
        '" onclick="goTab(' + jsq(it.tab) + ')">' + escHtml(it.action) + '</button>' +
    '</div>';
  }).join('') + '<p class="w-f">Nothing sends until you approve it, unless you turned on autopilot.</p></div>';
}

// Words on a button that ask for a decision. Anything else only opens a screen.
const DECISION_WORDS = /^(review|approve|confirm|connect|change|resume|fix|turn|set up|finish|reply)/i;
function isDecision(action) { return DECISION_WORDS.test(String(action || '').trim()); }

// A row that only opens something: the whole row is the link, with a quiet chevron.
function linkRow(tab, inner, label) {
  return '<button type="button" class="row link" onclick="goTab(' + jsq(tab) + ')"' +
    (label ? ' aria-label="' + escHtml(label) + '"' : '') + '>' + inner + icon('chevron', 'chev') + '</button>';
}

// Badge numbers from /api/today: the dock and the pills read the same ones.
function applyCounts(data) {
  const st = (data && data.stats) || {};
  navCount('nav-today', ((data && data.items) || []).filter(i => i.tone !== 'good').length);
  navCount('nav-outbox', st.outbox_pending || 0);
  navCount('nav-conversations', st.needs_human || 0);
  navCount('nav-leads', st.leads_needing_you || 0);
  navCount('nav-mentions', st.mentions_new || 0);
  navCount('nav-signals', st.signals_proposed || 0);
  navCount('nav-social', st.social_waiting || 0);
  navCount('nav-outbound', (st.outbox_pending || 0) + (st.needs_human || 0) + (st.social_waiting || 0));
  navCount('nav-inbound', (st.leads_needing_you || 0) + (st.mentions_new || 0));
}

// ── Live status: the "what's happening?" answer, kept on screen ──

async function loadLiveStatus() {
  const el = document.getElementById('live-status');
  if (!el) return;
  const d = await api('/api/live-status');
  if (!d || !Array.isArray(d.steps)) {
    // Keep the last good numbers on screen, but never let them pass for live.
    const flag = el.querySelector('.live-flag');
    if (flag) flag.textContent = "Can't reach Sellbird right now. The numbers below may be old.";
    else el.innerHTML = '<p class="muted live-flag">Can\'t reach Sellbird right now. ' +
      'Is the dashboard window still open?</p>';
    return;
  }
  const glyph = {done: icon('check'), running: '<span class="pulse"></span>', partial: '', waiting: ''};
  const fill = {done: 'var(--good)', running: 'var(--accent)', partial: 'var(--accent)', waiting: 'var(--line-strong)'};
  const rows = d.steps.map(s => {
    const st = Object.prototype.hasOwnProperty.call(glyph, s.state) ? s.state : 'waiting';
    const pct = s.total ? Math.min(100, Math.round(100 * s.done / s.total)) : 0;
    const bar = s.total
      ? '<div class="bar"><span style="width:' + pct + '%;background:' + fill[st] + '"></span></div>'
      : '';
    return '<div class="step">' +
      '<span class="step-icon ' + st + '">' + glyph[st] + '</span>' +
      '<span class="step-label">' + escHtml(s.label) + '</span>' +
      '<span class="step-detail">' + escHtml(s.detail) + '</span>' + bar +
    '</div>';
  }).join('');
  const jobName = r => r.stage === 'profile' ? 'Reading websites'
    : r.stage === 'discover' ? 'Searching for businesses (' + (r.provider || '') + ')'
    : String(r.stage || 'Job');
  const running = d.running || [];
  const runningHtml = running.length
    ? running.map(r => '<span class="live-now"><span class="pulse"></span>' + escHtml(jobName(r)) +
        ' · ' + r.elapsed_min + ' min' + (r.eta_text ? ' · ' + escHtml(r.eta_text) : '') + '</span>').join('')
    : '<span class="live-now">Nothing running right now</span>';
  const stoppedHtml = (d.stopped || []).length
    ? '<div class="banner bad" style="margin:8px 0 0">' + icon('alert') + '<p style="color:inherit">' +
      (d.stopped || []).map(r => escHtml(jobName(r))).join(', ') + ' stopped before finishing.</p></div>'
    : '';
  el.innerHTML =
    '<div class="live-head">' + runningHtml +
      '<span class="setup-pct">Cost so far $' + Number(d.cost_usd || 0).toFixed(2) + '</span></div>' +
    stoppedHtml +
    '<div class="steps">' + rows + '</div>' +
    (d.next ? '<div class="live-next">' + icon('arrow') + '<span><b>Next</b> · ' + escHtml(d.next) + '</span>' +
      (d.next_tab ? '<button class="btn btn-secondary btn-sm" onclick="goTab(' + jsq(d.next_tab) + ')">Go</button>' : '') +
      '</div>' : '') +
    '<div class="live-flag">Updated ' + new Date().toLocaleTimeString() + '. Refreshes every 10 seconds.</div>';
}

// KPI cards. Totals come from /api/today; the 14-day bars from /api/trend.
function renderFigures(stats) {
  const el = document.getElementById('today-kpis');
  if (!el) return;
  const t = _trend || {};
  const sum = a => (a || []).reduce((x, y) => x + (Number(y) || 0), 0);
  const last7 = a => sum((a || []).slice(-7));
  const card = (label, value, spark, note) =>
    '<div class="stat"><span>' + label + '</span>' +
    '<div class="stat-main"><b class="v' + (value ? '' : ' zero') + '">' + value + '</b>' + spark + '</div>' +
    '<span>' + note + '</span></div>';

  // Instantly sends from its own servers, so the Outbox never sees them.
  const sent = stats.email_provider === 'instantly'
    ? card('Emails sent', 'n/a', '', 'Instantly tracks sends')
    : card('Emails sent', sum(t.sent), sparkBars(t.sent, 'Emails sent per day, last 14 days'),
           'last 14 days · <b>' + (stats.outbox_approved || 0) + '</b> scheduled');
  const waiting = (stats.outbox_pending || 0) + (stats.needs_human || 0);
  const waitNote = [
    stats.outbox_pending ? stats.outbox_pending + ' to approve' : '',
    stats.needs_human ? stats.needs_human + ' handed to you' : '',
  ].filter(Boolean).join(' · ') || 'nothing to approve';
  const facts = document.getElementById('today-facts');
  if (facts) facts.innerHTML =
    '<span><b>' + (stats.companies || 0) + '</b> companies</span>' +
    '<span><b>' + (stats.unprofiled || 0) + '</b> sites not read yet</span>' +
    '<span><b>' + (stats.signals_confirmed || 0) + '</b> signals on</span>';

  el.innerHTML = '<div class="stats">' +
    card('People found', stats.prospects || 0, sparkBars(t.found, 'Contacts found per day, last 14 days'),
         '<b>+' + last7(t.found) + '</b> this week') +
    sent +
    card('Conversations', stats.open_conversations || 0, sparkBars(t.replies, 'New replies per day, last 14 days'),
         '<b>' + sum(t.replies) + '</b> new in 14 days') +
    card('Waiting on you', waiting, '', waitNote) +
  '</div>';
}

let _todayStats = {};
let _trend = null;

async function loadTrend() {
  const t = await api('/api/trend?days=14&tz=' + -new Date().getTimezoneOffset());
  if (t && Array.isArray(t.days)) { _trend = t; renderFigures(_todayStats); }
}

// Contacts by stage: one bar, one legend, from /api/stats.
async function loadFunnel() {
  const el = document.getElementById('today-figures');
  if (!el) return;
  const data = await api('/api/stats');
  if (!data) return;  // offline: keep the last numbers; Today's queue says so
  if (data.error) { el.innerHTML = '<p class="muted" style="font-size:13px">Couldn\'t read the pipeline.</p>'; return; }
  const total = (data.prospects || {}).total || 0;
  const pipe = data.pipeline || {};
  const stages = [
    ['To write', pipe.to_write || 0, 'c-accent-soft'],
    ['Contacted', pipe.contacted || 0, 'c-accent'],
    ['Replied', pipe.replied || 0, 'c-active'],
    ['Interested', pipe.interested || 0, 'c-good'],
    ['Ready to meet', pipe.ready_to_meet || 0, 'c-note'],
    ['Closed out', pipe.closed_out || 0, 'c-idle'],
  ];
  if (!total) {
    el.innerHTML = '<p class="muted" style="font-size:13px">No contacts yet. Scout adds them as it finds people.</p>';
    return;
  }
  el.innerHTML =
    '<div class="funnel-bar" role="img" aria-label="Contacts by stage">' +
      stages.filter(s => s[1] > 0).map(s =>
        '<span class="seg ' + s[2] + '" style="flex:' + s[1] + '" title="' + s[0] + ': ' + s[1] + '"></span>').join('') +
    '</div>' +
    '<div class="legend-rows">' + stages.map(s =>
      '<div class="legend-row"><span class="legend-key"><i class="' + s[2] + '"></i>' + s[0] + '</span>' +
      '<span class="legend-val">' + s[1] + '</span>' +
      '<span class="legend-pct">' + Math.round(100 * s[1] / total) + '%</span></div>'
    ).join('') + '</div>';
}

// Today's sentence: what the agent did since yesterday, then what needs you.
async function todayAnswer(data, needs) {
  const r = _report || await loadAgentReport();
  const st = data.stats || {};
  const day = (r && r.day) || {};
  const did = [];
  if (day.found) did.push('found ' + plural(day.found, 'person', 'people'));
  if (day.written) did.push('wrote ' + plural(day.written, 'email', 'emails'));
  if (day.sent) did.push('sent ' + plural(day.sent, 'email', 'emails') + ' you approved');
  const first = did.length
    ? agentWho() + ' ' + did.join(', ').replace(/, ([^,]*)$/, ' and $1') + ' in the last day.'
    : (r && r.engine_running ? agentWho() + ' is working; nothing new since yesterday.'
                             : 'Nothing new since yesterday.');
  const waiting = st.outbox_pending || 0;
  const then = waiting
    ? ' ' + plural(waiting, 'email is', 'emails are') + ' waiting for your OK.'
    : needs ? ' ' + plural(needs, 'thing needs', 'things need') + ' you.' : ' Nothing needs you.';
  const date = new Date().toLocaleDateString(undefined, {weekday: 'long', month: 'long', day: 'numeric'});
  setAnswer('today', needs ? toneBadge('warn', needs + ' need you') : toneBadge('good', 'All clear'), first + then, date);
}

// What the agent did, mixed with what you did: every line from a record.
async function loadTodayActivity() {
  const el = document.getElementById('today-activity');
  if (!el) return;
  const r = await loadAgentReport();
  const title = document.getElementById('today-log-title');
  if (title) title.textContent = 'What ' + agentName() + ' did';
  if (!r) return;  // offline: Today's queue says so
  el.innerHTML = logHtml(r.log.slice(0, 8), 'Nothing yet. Everything ' + agentName() +
    ' does through Sellbird, and everything you decide, shows up here.');
}

function navCount(id, n) {
  _counts[id] = n;
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = n > 0 ? n : '';
  el.className = 'nav-count' + (n > 0 ? ' on' : '');
  // In the dock the words can be hidden, so the button's name carries the count.
  const item = el.closest('.navitem');
  if (item) {
    el.setAttribute('aria-hidden', 'true');
    const name = (item.querySelector('.lbl') || {}).textContent || '';
    item.setAttribute('aria-label', name + (n > 0 ? ', ' + n + ' waiting' : ''));
  }
}

async function loadRuns() {
  const el = document.getElementById('today-runs');
  const block = document.getElementById('today-runs-block');
  if (!el) return;
  const runs = await api('/api/runs');
  if (!Array.isArray(runs) || !runs.length) {
    if (block) block.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  if (block) block.style.display = '';
  el.innerHTML = '<div class="runs">' + runs.slice(0, 5).map(r =>
    '<div class="run">' +
      '<span class="name">' + escHtml(r.stage) + '</span>' + badge(r.status) +
      '<span class="when">' + relTime(r.started_at) + '</span>' +
      '<span class="stats">' + (r.records || 0) + ' records · ' +
        (r.cost_usd ? '$' + Number(r.cost_usd).toFixed(4) : 'free') + '</span>' +
    '</div>').join('') + '</div>';
}

// ── Setup checklist (lives on Today, and disappears once it's done) ──

// Shown once after an upgrade from Harvey moved this install's files.
async function loadRenameNotice() {
  const el = document.getElementById('today-renamed');
  if (!el) return;
  const data = await api('/api/rename-notice');
  if (!data || !data.show) { el.innerHTML = ''; return; }
  el.innerHTML =
    '<div class="card rename-card">' +
      '<div><h3>Harvey is now Sellbird</h3>' +
        '<p class="muted">Same project, new name. Your settings, data and sign-in came with you. ' +
        'The <code>harvey</code> command still works for now; use <code>sellbird</code> from here on.</p></div>' +
      '<div class="rename-actions">' +
        '<a class="btn btn-ghost" href="https://github.com/ethanplusai/sellbird#upgrading-from-harvey" target="_blank" rel="noopener">What changed</a>' +
        '<button class="btn btn-secondary" onclick="dismissRenameNotice()">Got it</button>' +
      '</div></div>';
}

async function dismissRenameNotice() {
  document.getElementById('today-renamed').innerHTML = '';
  await api('/api/rename-notice/dismiss', {method: 'POST'});
}

async function loadSetupStatus() {
  const el = document.getElementById('today-setup');
  if (!el) return;
  const data = await api('/api/setup-status');
  const sec = document.getElementById('today-setup-sec');
  const pct = (data && data.percent) || 0;
  // Finished setup disappears completely rather than greeting you forever.
  // A suggestion still open (how to find businesses and people) stays, alone.
  const extra = data && data.checks ? data.checks.filter(c => c.shown && !c.required && !c.done) : [];
  const gone = !data || !data.checks || (pct === 100 && !extra.length);
  if (sec) sec.hidden = gone;
  if (gone) { el.innerHTML = ''; return; }
  if (pct === 100) {
    el.innerHTML = '<div class="w pad setup-card">' + extra.map(c =>
      '<div class="check-item current"><span class="check-icon pending"></span><div class="check-info">' +
        '<div class="check-label">' + escHtml(c.label) + '<span class="optional-tag">optional</span></div>' +
        '<div class="check-help">' + escHtml(c.help) + '</div>' + recommendHtml(c) + '</div></div>').join('') + '</div>';
    return;
  }

  // The first unfinished required step is the one to do now.
  const next = data.checks.find(c => c.required && !c.done);
  const renderCheck = (c, optional) =>
    '<div class="check-item' + (c === next ? ' current' : '') + '">' +
      (c.done ? '<span class="check-icon done">' + icon('check') + '</span>'
              : '<span class="check-icon pending"></span>') +
      '<div class="check-info">' +
        '<div class="check-label ' + (c.done ? 'done' : '') + '">' + escHtml(c.label) +
          (optional ? '<span class="optional-tag">optional</span>' : '') + '</div>' +
        (!c.done ? '<div class="check-help">' + escHtml(c.help) + '</div>' : '') +
        (!c.done && c.id === 'warmup_service' ? warmupServiceActions(c) : '') +
        (!c.done && c.recommend ? recommendHtml(c) : '') +
      '</div></div>';

  const required = data.checks.filter(c => c.required);
  const shown = data.checks.filter(c => !c.required && c.shown && !c.done);
  const optional = data.checks.filter(c => !c.required && !shown.includes(c));
  const done = required.filter(c => c.done).length;

  el.innerHTML =
    '<div class="w pad setup-card">' +
      '<div class="setup-head"><div>' +
        '<p class="s">Sellbird starts finding prospects and sending once these are done.</p></div>' +
        '<span class="setup-pct">' + done + ' of ' + required.length + ' done</span></div>' +
      '<div class="bar thick" style="margin-bottom:8px"><span style="width:' + pct + '%;background:var(--accent)"></span></div>' +
      required.map(c => renderCheck(c, false)).join('') +
      shown.map(c => renderCheck(c, true)).join('') +
      (optional.length
        ? '<details style="margin-top:10px"><summary class="muted" ' +
          'style="font-size:12px">' + optional.length + ' optional</summary>' +
          '<div style="margin-top:6px">' +
          optional.map(c => renderCheck(c, true)).join('') + '</div></details>'
        : '') +
    '</div>';
}

// A recommended service for a job: what is free, the one we recommend and why,
// and the disclosure when a link is an affiliate one.
function recLink(j, cls) {
  return '<a class="' + (cls || 'btn btn-secondary btn-sm') + '" href="' + safeHref(j.url) + '" target="_blank" rel="noopener ' +
    (j.affiliate ? 'sponsored' : 'noreferrer') + '">' + escHtml(j.name) + '</a>';
}

function recommendHtml(c) {
  const jobs = c.recommend || [];
  // The step's own help already says what is free; each job adds one line.
  const rows = jobs.map(j => '<p class="rec-line"><b>' + escHtml(j.label) + ':</b> ' + escHtml(j.name) + '. ' +
    escHtml(j.why) + '</p>').join('');
  const any = jobs.some(j => j.affiliate);
  return '<div class="rec">' + rows + '<div class="btn-group">' +
    (c.id === 'find_sources' ? '<button class="btn btn-primary btn-sm" onclick="useFreeFinding()">Use the free ones</button>' : '') +
    jobs.map(j => recLink(j)).join('') + '</div>' +
    (any && c.disclosure ? '<p class="rec-note">' + escHtml(c.disclosure) + '</p>' : '') + '</div>';
}

async function useFreeFinding() {
  const res = await api('/api/finding-choice', {method: 'POST'});
  if (res && res.success) showToast('Using the free sources. You can add a paid one any time.', 'success');
  loadSetupStatus();
}

let _recommended = null;
async function recommendedJobs() {
  if (!_recommended) _recommended = await api('/api/recommended');
  return _recommended;
}

// The line under a Set up screen: the one service we recommend for each job here.
async function fillRecommended(elId, names) {
  const el = document.getElementById(elId);
  const d = await recommendedJobs();
  if (!el || !d || !d.jobs) return;
  const jobs = names.map(n => d.jobs[n]).filter(Boolean);
  el.innerHTML = jobs.map(j => '<p class="rec-line"><b>' + escHtml(j.label) + '.</b> ' + escHtml(j.why) + ' ' +
      recLink(j, 'rec-a') + '</p>').join('') +
    (jobs.some(j => j.affiliate) && d.disclosure ? '<p class="rec-note">' + escHtml(d.disclosure) + '</p>' : '');
}

// The warmup step: get TrulyInbox, paste its key, or say you use another service.
function warmupServiceActions(c) {
  return '<div class="btn-group warmup-actions">' +
      '<a class="btn btn-primary btn-sm" href="' + safeHref(c.link) + '" target="_blank" ' +
        'rel="noopener sponsored">Get TrulyInbox</a>' +
      '<input class="form-input" id="trulyinbox-key" type="password" autocomplete="off" ' +
        'placeholder="Paste your TrulyInbox API key" aria-label="TrulyInbox API key" ' +
        'onkeydown="if (event.key === \'Enter\') connectTrulyInbox()">' +
      '<button class="btn btn-secondary btn-sm" id="trulyinbox-go" onclick="connectTrulyInbox()">Connect</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="useOtherWarmup()">I use another service</button>' +
    '</div>';
}

async function connectTrulyInbox() {
  const input = document.getElementById('trulyinbox-key');
  const go = document.getElementById('trulyinbox-go');
  if (!input || !input.value.trim()) return;
  if (go) go.disabled = true;
  const data = await api('/api/trulyinbox/connect', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({key: input.value.trim()}),
  });
  if (go) go.disabled = false;
  if (data && data.success) {
    input.value = '';
    showToast(data.message || 'TrulyInbox connected', 'success');
    loadSetupStatus();
  } else {
    showToast((data && data.message) || 'Could not connect TrulyInbox', 'error');
  }
}

async function useOtherWarmup() {
  const data = await api('/api/trulyinbox/other', {method: 'POST'});
  if (data && data.success) loadSetupStatus();
}

// ── Signals: Sellbird proposes, you confirm ──

async function loadSignals() {
  const data = await api('/api/signals');
  const sumEl = document.getElementById('signals-summary');
  const grpEl = document.getElementById('signals-groups');
  if (!data || data.error) { grpEl.innerHTML = offlineState(); sumEl.innerHTML = ''; return; }
  _signals = data;

  const s = data.summary || {};
  navCount('nav-signals', s.proposed || 0);
  const parts = [['Confirmed', s.confirmed || 0, 'c-good'], ['Waiting on you', s.proposed || 0, 'c-wait'],
                 ['Turned off', s.rejected || 0, 'c-idle']];
  const all = parts.reduce((x, p) => x + p[1], 0) || 1;
  sumEl.innerHTML = '<div class="card sig-summary"><div class="funnel-bar">' +
    parts.filter(p => p[1]).map(p => '<span class="seg ' + p[2] + '" style="flex:' + p[1] + '"></span>').join('') +
    '</div><div class="funnel-legend">' + parts.map(p =>
      '<div class="legend-item"><span class="legend-key"><i class="' + p[2] + '"></i>' + p[0] + '</span>' +
      '<span class="legend-val">' + p[1] + '<small>' + Math.round(100 * p[1] / all) + '%</small></span></div>'
    ).join('') + '</div></div>';

  grpEl.innerHTML = (data.groups || []).map(g => {
    // Only the undecided ones: "Confirm all" must never re-enable a signal
    // you turned off (or "Skip all" turn off one you confirmed).
    const pending = escHtml(JSON.stringify(g.signals.filter(x => x.status === 'proposed').map(x => x.code)));
    const undecided = g.signals.filter(x => x.status === 'proposed').length;
    return '<div class="sig-group">' +
      '<div class="sig-group-head"><div>' +
        '<h3>' + escHtml(g.label) + '</h3><p>' + escHtml(g.blurb) + '</p>' +
      '</div>' +
      (undecided
        ? '<div style="display:flex;gap:6px;flex-shrink:0">' +
            '<button class="btn btn-primary btn-sm" onclick="setSignals(' + pending +
              ', \'confirmed\')">Confirm all ' + undecided + '</button>' +
            '<button class="btn btn-secondary btn-sm" onclick="setSignals(' + pending +
              ', \'rejected\')">Skip all ' + undecided + '</button>' +
          '</div>'
        : '') +
      '</div>' +
      '<div class="card flush">' + g.signals.map(sigRow).join('') + '</div>' +
    '</div>';
  }).join('');

  renderCohortBuilder();
}

function sigRow(sig) {
  const free = /free|included/i.test(sig.cost_note || '');
  const costCls = free ? 'free' : (/\$/.test(sig.cost_note || '') ? 'paid' : '');
  const seen = sig.companies
    ? '<span class="cost-chip">seen on ' + sig.companies +
      (sig.companies === 1 ? ' company' : ' companies') + ' so far</span>' : '';
  const floor = sig.confidence_floor > 0
    ? '<span class="cost-chip">only recorded above ' +
      Math.round(sig.confidence_floor * 100) + '% confidence</span>' : '';

  const decide = sig.status === 'confirmed'
    ? '<button class="btn btn-secondary btn-sm" onclick="setSignals([' + jsq(sig.code) +
        '],\'rejected\')">Turn off</button>'
    : sig.status === 'rejected'
      ? '<button class="btn btn-secondary btn-sm" onclick="setSignals([' + jsq(sig.code) +
          '],\'confirmed\')">Turn on</button>'
      : '<button class="btn btn-primary btn-sm" onclick="setSignals([' + jsq(sig.code) +
          '],\'confirmed\')">Confirm</button>' +
        '<button class="btn btn-secondary btn-sm" onclick="setSignals([' + jsq(sig.code) +
          '],\'rejected\')">Skip</button>';

  return '<div class="sig-row ' + (sig.status === 'rejected' ? 'rejected' : '') + '">' +
    '<div class="sig-main">' +
      '<div class="sig-label">' + escHtml(sig.label || sig.code) +
        '<span class="sig-code">' + escHtml(sig.code) + '</span></div>' +
      '<div class="sig-desc">' + escHtml(sig.description) + '</div>' +
      '<div class="sig-meta">' +
        '<span class="cost-chip ' + costCls + '">' + escHtml(sig.cost_note || 'cost unknown') + '</span>' +
        floor + seen + badge(sig.status) +
      '</div>' +
    '</div>' +
    '<div class="sig-decide">' + decide + '</div>' +
  '</div>';
}

async function setSignals(codes, status) {
  const data = await api('/api/signals/status', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({codes: codes, status: status}),
  });
  if (data && data.success) {
    showToast(
      status === 'confirmed'
        ? 'Confirmed ' + data.changed + ' signal' + (data.changed === 1 ? '' : 's') +
          '. Sellbird will collect ' + (data.changed === 1 ? 'it' : 'them') + ' from now on.'
        : data.changed + ' signal' + (data.changed === 1 ? '' : 's') + ' turned off.',
      'success');
  } else {
    showToast(failMsg(data, 'Could not update that signal.'), 'error');
  }
  loadSignals();
}

// ── Discover: pick a source, price it, then run it ──

let _provider = null;
let _discoverPoll = null;

async function loadDiscoverProviders() {
  fillRecommended('discover-recommended', ['businesses', 'people']);
  const el = document.getElementById('discover-providers');
  const data = await api('/api/discover/providers');
  if (!data || !data.providers) { el.innerHTML = offlineState(); return; }

  _provider = _provider || data.selected || data.default;
  el.innerHTML = '<div class="prov-grid">' + data.providers.map(p => {
    const ready = p.configured
      ? '<span class="badge t-good">ready</span>'
      : '<span class="badge t-waiting">needs a key</span>';
    return '<div class="prov-card ' + (p.key === _provider ? 'selected' : '') +
      '" onclick="pickProvider(' + jsq(p.key) + ')">' +
      '<div class="prov-head"><h3>' + escHtml(p.label) + '</h3>' + ready + '</div>' +
      '<div class="blurb">' + escHtml(p.blurb) + '</div>' +
      '<div class="row"><span class="k">Cost</span><span class="v">' +
        escHtml(p.cost_note) + '</span></div>' +
      '<div class="row"><span class="k">Free</span><span class="v">' +
        escHtml(p.free_tier) + '</span></div>' +
      (p.needs_key
        ? '<div class="row"><span class="k">Setup</span><span class="v">' +
          escHtml(p.env_keys.join(', ')) + ' in .env &middot; ' +
          '<a href="' + safeHref(p.signup_url) + '" target="_blank" rel="noopener noreferrer">get a key</a>' +
          '</span></div>'
        : '') +
      (p.caveat ? '<div class="caveat">' + escHtml(p.caveat) + '</div>' : '') +
    '</div>';
  }).join('') + '</div>';

  const running = data.running;
  // Reading sites can't be stopped part-way; only a discovery run can.
  document.getElementById('disc-stop').style.display = running && data.running_kind !== 'profile' ? '' : 'none';
  renderProfileCard(data.unprofiled || 0, running);
  if (running && !_discoverPoll) {
    _discoverPoll = setInterval(loadDiscoverProviders, 4000);
  } else if (!running && _discoverPoll) {
    clearInterval(_discoverPoll);
    _discoverPoll = null;
    // A finished run leaves the button stuck on "Running…" otherwise.
    const btn = document.getElementById('disc-run');
    btn.disabled = true;
    btn.textContent = 'Estimate first';
    showToast(data.running_kind === 'profile' ? 'Finished reading websites.' : 'Discovery finished.', 'success');
  }
  renderDiscoverResult(data.last_report, running);
}

function pickProvider(key) {
  _provider = key;
  document.getElementById('disc-run').disabled = true;
  document.getElementById('disc-run').textContent = 'Estimate first';
  document.getElementById('discover-estimate').innerHTML = '';
  loadDiscoverProviders();
}

function discoverBody() {
  const raw = document.getElementById('disc-cities').value.trim();
  return {
    provider: _provider,
    // Semicolons or newlines, never commas: "Denver, CO" is one city.
    cities: raw ? raw.split(/[;\n]/).map(c => c.trim()).filter(Boolean) : [],
    depth: Number(document.getElementById('disc-depth').value) || 30,
    limit: Number(document.getElementById('disc-limit').value) || 100,
    max_spend: Number(document.getElementById('disc-cap').value) || 1,
    preset: (document.getElementById('disc-preset') || {}).value || '',
  };
}

async function estimateDiscovery() {
  const el = document.getElementById('discover-estimate');
  el.innerHTML = '<p class="muted" style="font-size:13px">Pricing it…</p>';
  const data = await api('/api/discover/estimate', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(discoverBody()),
  });
  if (!data || data.error) {
    el.innerHTML = '<div class="test-result error">' +
      escHtml((data && data.error) || 'Could not estimate.') + '</div>';
    return;
  }

  const cap = discoverBody().max_spend;
  const over = data.estimated_cost > cap;
  el.innerHTML = '<div class="estimate-box">' +
    '<div class="amount ' + (data.free ? 'free' : 'paid') + '">' +
      (data.free ? 'Free' : '$' + data.estimated_cost.toFixed(4)) + '</div>' +
    '<div class="muted" style="font-size:13px;margin-top:2px">' +
      data.query_count + ' quer' + (data.query_count === 1 ? 'y' : 'ies') +
      (data.free ? '' : ' &middot; cap is $' + cap.toFixed(2)) + '</div>' +
    (over ? '<div class="test-result error" style="margin-top:12px">' +
      'Over your cap. Raise the cap or narrow the search.</div>' : '') +
    '<div class="query-list">' +
      data.queries.slice(0, 40).map(escHtml).join('<br>') +
      (data.queries.length > 40 ? '<br>… and ' + (data.queries.length - 40) + ' more' : '') +
    '</div></div>';

  const btn = document.getElementById('disc-run');
  btn.disabled = over;
  btn.textContent = over ? 'Over cap'
    : (data.free ? 'Run, free' : 'Run, spend up to $' + data.estimated_cost.toFixed(2));
}

async function runDiscovery() {
  const btn = document.getElementById('disc-run');
  btn.disabled = true;
  btn.textContent = 'Running…';
  const data = await api('/api/discover/run', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(discoverBody()),
  });
  if (data && data.success) {
    showToast('Discovery started: ' + data.queries + ' queries.', 'success');
  } else {
    showToast((data && data.message) || 'Could not start.', 'error');
    btn.disabled = false;
  }
  loadDiscoverProviders();
}

async function stopDiscovery() {
  const data = await api('/api/discover/stop', {method: 'POST'});
  showToast(data && data.success ? 'Stopping after the current query.'
                                 : failMsg(data, 'Could not stop.'), data && data.success ? 'success' : 'error');
  loadDiscoverProviders();
}

// Companies found but not looked at: reading their sites is free and
// model-free, and it is what makes an email specific.
function renderProfileCard(pending, running) {
  const el = document.getElementById('discover-profile');
  if (!el) return;
  if (!pending) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="subhead">Read websites</div><div class="w"><div class="row">' +
    '<div class="grow"><p class="t">' + pending + ' compan' + (pending === 1 ? 'y' : 'ies') +
    ' not looked at yet</p><p class="s">Free, no account needed. Sellbird reads each site for ' +
    'who their agency is, what they are missing, and whether they run ads. Up to 200 per run.</p></div>' +
    '<button class="btn btn-primary btn-sm rowbtn" onclick="runProfile(this)"' + (running ? ' disabled' : '') + '>' +
    (running ? 'Busy…' : 'Read their sites') + '</button></div></div>';
}

async function runProfile(btn) {
  btn.disabled = true;
  btn.textContent = 'Starting…';
  const data = await api('/api/profile/run', {method: 'POST'});
  if (data && data.success) {
    showToast(data.pending ? 'Reading ' + Math.min(data.pending, 200) + ' websites.' : 'Every site is already read.', 'success');
    if (data.pending && !_discoverPoll) _discoverPoll = setInterval(loadDiscoverProviders, 4000);
  } else {
    showToast(failMsg(data, 'Could not start.'), 'error');
  }
  loadDiscoverProviders();
}

function renderDiscoverResult(report, running) {
  const el = document.getElementById('discover-result');
  if (running) {
    el.innerHTML = '<div class="card"><h2>Running…</h2>' +
      '<p class="muted" style="font-size:13px">Sellbird is working through the ' +
      'queries. Results land under People, Companies, and the run log is on Today.</p></div>';
    return;
  }
  if (!report) { el.innerHTML = ''; return; }

  const stat = (label, value, tone) =>
    '<div class="stat-card"><div class="label">' + label + '</div>' +
    '<div class="value"' + (tone ? ' style="color:var(--' + tone + ')"' : '') + '>' +
    value + '</div></div>';

  if (report.profiled_companies !== undefined && report.new_companies === undefined) {
    el.innerHTML = '<div class="subhead">Last run</div><div class="stats-grid">' +
      stat('Websites read', report.profiled_companies || 0, 'accent') +
      stat('Facts recorded', report.profile_observations || 0) +
      stat('Cost', 'free') + '</div>' +
      (report.stopped ? '<div class="test-result error" style="margin-top:14px">Stopped early: ' + escHtml(report.stopped) + '</div>' : '');
    return;
  }
  el.innerHTML = '<div class="subhead">Last run</div>' +
    '<div class="stats-grid">' +
      stat('New companies', report.new_companies || 0, 'accent') +
      stat('Already known', report.known_companies || 0) +
      stat('Observations', report.observations || 0) +
      stat('Filtered as junk', report.junk || 0) +
      (report.profiled_companies ? stat('Websites read', report.profiled_companies) : '') +
      stat('Actual cost', report.actual_cost ? '$' + report.actual_cost.toFixed(4) : 'free') +
    '</div>' +
    (report.stopped ? '<div class="test-result error" style="margin-top:14px">' +
      'Stopped early: ' + escHtml(report.stopped) + '</div>' : '') +
    ((report.errors || []).length
      ? '<div class="card" style="margin-top:14px"><h2>Problems</h2>' +
        (report.errors || []).slice(0, 8).map(e =>
          '<div class="check-help">' + escHtml(e) + '</div>').join('') + '</div>'
      : '');
}

// ── Cohort builder: a prospect list is a query ──

let _cohort = { require: new Set(), exclude: new Set(), ranges: {} };
let _cohortOffset = 0;
let _cohortGeneration = 0;
const COHORT_PAGE = 50;

function renderCohortBuilder() {
  const el = document.getElementById('cohort-builder');
  if (!el || !_signals) return;

  const confirmed = (_signals.groups || [])
    .flatMap(g => g.signals)
    .filter(s => s.status === 'confirmed');

  if (!confirmed.length) {
    el.innerHTML = '<p class="muted" style="font-size:13px">' +
      'Confirm some signals above and they become the building blocks here.</p>';
    document.getElementById('cohort-result').innerHTML = '';
    return;
  }

  const col = (title, key, hint) =>
    '<div><div class="subhead" style="margin-top:0">' + title +
      ' <span class="muted" style="font-weight:400;text-transform:none;letter-spacing:0">' +
      hint + '</span></div><div class="cohort-grid">' +
    confirmed.map(s =>
      '<label class="cohort-pick"><input type="checkbox" ' +
        (_cohort[key].has(s.code) ? 'checked ' : '') +
        'onchange="toggleCohort(\'' + key + '\',' + jsq(s.code) + ',this.checked)">' +
        '<span>' + escHtml(s.label || s.code) + '</span>' +
        '<span class="n">' + (s.companies || 0) + '</span></label>'
    ).join('') + '</div></div>';

  // Numeric signals (ranks, ratings) take a range: "organic rank 11-30".
  const numeric = confirmed.filter(s => s.value_type === 'num');
  const bound = (code, side) => {
    const v = (_cohort.ranges[code] || {})[side];
    return '<input type="number" class="cohort-bound" placeholder="' + side + '" ' +
      'value="' + (v === undefined || v === null ? '' : escHtml(String(v))) + '" ' +
      'aria-label="' + escHtml(code) + ' ' + side + '" ' +
      'onchange="setCohortRange(' + jsq(code) + ',' + jsq(side) + ',this.value)">';
  };
  const rangeCol = numeric.length ?
    '<div style="height:18px"></div><div><div class="subhead" style="margin-top:0">In range ' +
      '<span class="muted" style="font-weight:400;text-transform:none;letter-spacing:0">' +
      'for example organic rank 11 to 30; leave a side blank for no limit</span></div>' +
      '<div class="cohort-grid">' +
      numeric.map(s =>
        '<div class="cohort-pick cohort-range"><span>' + escHtml(s.label || s.code) + '</span>' +
          bound(s.code, 'min') + '<span class="muted">to</span>' + bound(s.code, 'max') + '</div>'
      ).join('') + '</div></div>' : '';

  el.innerHTML = col('Must have', 'require', 'every company in the cohort carries all of these') +
    '<div style="height:18px"></div>' +
    col('Must not have', 'exclude', 'disqualifiers') + rangeCol;
}

function setCohortRange(code, side, value) {
  const r = _cohort.ranges[code] || {min: null, max: null};
  r[side] = value === '' || isNaN(Number(value)) ? null : Number(value);
  if (r.min === null && r.max === null) delete _cohort.ranges[code];
  else _cohort.ranges[code] = r;
  _cohortOffset = 0;
  runCohort();
}

function toggleCohort(key, code, on) {
  if (on) _cohort[key].add(code); else _cohort[key].delete(code);
  // A company can't be both required and excluded on the same signal.
  const other = key === 'require' ? 'exclude' : 'require';
  if (on) _cohort[other].delete(code);
  _cohortOffset = 0;  // a new cohort starts on its first page
  runCohort();
  renderCohortBuilder();
}

async function runCohort() {
  const generation = ++_cohortGeneration;
  const offset = _cohortOffset;
  const el = document.getElementById('cohort-result');
  if (!el) return;
  const require = [..._cohort.require], exclude = [..._cohort.exclude];
  const ranges = _cohortRanges();
  if (!require.length && !ranges.length) { el.innerHTML = ''; return; }
  // Remove the prior export button as soon as its criteria become stale.
  el.innerHTML = '<p class="muted">Loading cohort…</p>';

  const data = await api('/api/cohort', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({require: require, exclude: exclude, ranges: ranges,
                          offset: offset, limit: COHORT_PAGE}),
  });
  if (generation !== _cohortGeneration) return;
  if (!data || data.error) {
    el.innerHTML = data ? '<div class="test-result error">' + escHtml(data.error) + '</div>' : '';
    return;
  }

  let html = '<div style="border-top:1px solid var(--border);margin-top:20px;padding-top:20px">' +
    '<div class="cohort-size">' + data.size + '</div>' +
    '<div class="muted" style="font-size:13px;margin-top:2px">compan' +
      (data.size === 1 ? 'y matches' : 'ies match') + ' this cohort right now</div>';

  if (data.companies && data.companies.length) {
    html += '<div class="table-card" style="margin-top:16px"><table><thead><tr>' +
      '<th>Company</th><th>Domain</th><th>Industry</th><th>Location</th>' +
      '</tr></thead><tbody>' +
      data.companies.map(c =>
        '<tr><td>' + escHtml(c.name) + '</td><td class="muted">' + escHtml(c.domain) + '</td>' +
        '<td class="muted">' + escHtml(c.industry) + '</td>' +
        '<td class="muted">' + escHtml(c.location) + '</td></tr>'
      ).join('') + '</tbody></table></div>';

    const first = data.offset + 1, last = data.offset + data.companies.length;
    const hasPrev = data.offset > 0, hasNext = last < data.size;
    html += '<div style="display:flex;align-items:center;gap:8px;margin-top:10px">' +
      '<span class="muted" style="font-size:12px">Showing ' + first + '&ndash;' + last +
        ' of ' + data.size + '</span>' +
      '<span style="flex:1"></span>' +
      '<button class="btn btn-secondary btn-sm" onclick="pageCohort(-1)"' +
        (hasPrev ? '' : ' disabled') + '>Prev</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="pageCohort(1)"' +
        (hasNext ? '' : ' disabled') + '>Next</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="exportCohort(this)">Export CSV</button>' +
      '</div>';
  } else if (data.size === 0) {
    html += '<p class="muted" style="font-size:13px;margin-top:12px">' +
      'No company carries all of those yet. Either loosen the cohort, or run ' +
      'prospecting to collect more.</p>';
  } else if (_cohortOffset > 0) {
    // The cohort shrank under us (a re-profile, a delete): back to page one.
    _cohortOffset = 0;
    return runCohort();
  }
  el.innerHTML = html + '</div>';
}

function _cohortRanges() {
  return Object.entries(_cohort.ranges || {})
    .filter(([, r]) => r.min !== null || r.max !== null)
    .map(([code, r]) => ({code: code, min: r.min, max: r.max}));
}

async function exportCohort(button) {
  const qs = new URLSearchParams({require: [..._cohort.require].join(','),
                                  exclude: [..._cohort.exclude].join(',')});
  // Ranges travel as "CODE:min:max", a blank side meaning no limit.
  const ranges = Object.entries(_cohort.ranges || {})
    .map(([code, r]) => code + ':' + (r.min ?? '') + ':' + (r.max ?? ''));
  if (ranges.length) qs.set('ranges', ranges.join(','));
  button.disabled = true;
  button.textContent = 'Exporting…';
  let url;
  let link;
  try {
    const response = await authFetch('/api/cohort.csv?' + qs);
    if (await lockIfRefused(response)) throw new Error('Dashboard authorization required');
    if (!response.ok) throw new Error('Export failed (HTTP ' + response.status + ')');
    url = URL.createObjectURL(await response.blob());
    link = document.createElement('a');
    link.href = url;
    link.download = 'cohort.csv';
    document.body.appendChild(link);
    link.click();
    button.textContent = 'Export CSV';
  } catch (error) {
    button.textContent = 'Export failed. Retry';
  } finally {
    if (link) link.remove();
    // Give the browser time to start consuming the download before revoking.
    if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
    button.disabled = false;
  }
}

function pageCohort(dir) {
  _cohortOffset = Math.max(0, _cohortOffset + dir * COHORT_PAGE);
  runCohort();
}

// ── Settings ──

async function loadSettings() {
  fillRecommended('verify-recommended', ['verify', 'verify_catchall']);
  const data = await api('/api/settings');
  if (!data) return;

  // Active provider indicator
  const prov = data.provider || 'instantly';
  const provEl = document.getElementById('active-provider');
  if (provEl) provEl.textContent = prov;

  // Secret fields never echo a value — show a "saved" placeholder instead.
  const savedPh = (id, isSet, base) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = '';
    el.placeholder = isSet ? 'Saved. Enter a new value to change it.' : base;
  };
  const tag = (id, ok, okLabel) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'email-tag ' + (ok ? 'verified' : 'guess');
    el.textContent = ok ? okLabel : 'not set';
  };

  // Non-secret values repopulate
  document.getElementById('gmail-id').value = data.gmail_client_id || '';
  document.getElementById('smtp-host').value = data.smtp_host || '';
  document.getElementById('smtp-port').value = data.smtp_port || '';
  document.getElementById('smtp-user').value = data.smtp_username || '';
  document.getElementById('imap-host').value = data.imap_host || '';
  document.getElementById('imap-port').value = data.imap_port || '';
  document.getElementById('imap-user').value = data.imap_username || '';
  document.getElementById('m365-client').value = data.m365_client_id || '';
  document.getElementById('m365-tenant').value = data.m365_tenant_id || '';
  document.getElementById('linkedin-email').value = data.linkedin_email || '';
  document.getElementById('cf-account-id').value = data.cloudflare_account_id || '';

  savedPh('gmail-secret', data.gmail_client_secret_set, 'Enter client secret');
  savedPh('smtp-pass', data.smtp_password_set, 'Enter password / app password');
  savedPh('imap-pass', data.imap_password_set, 'Same as SMTP password');
  document.getElementById('imap-same-pass').checked = !data.imap_password_set;
  savedPh('instantly-key', data.instantly_api_key_set, 'Enter your Instantly API key');
  savedPh('reoon-key', data.reoon_api_key_set, '600 free/mo, reoon.com/email-verifier');
  savedPh('zerobounce-key', data.zerobounce_api_key_set, '100 free/mo, best for M365/Workspace catch-alls');
  savedPh('hunter-key', data.hunter_api_key_set, '50 free/mo + email-pattern lookup');
  savedPh('linkedin-password', data.linkedin_password_set, 'Enter password');
  savedPh('cf-api-token', data.cloudflare_api_token_set, 'Your Cloudflare API Token');

  // Gmail auth status chip
  const g = document.getElementById('gmail-status');
  if (g) {
    const realId = /^\d+-[0-9a-z]+\.apps\.googleusercontent\.com$/.test((data.gmail_client_id || '').trim());
    if (data.gmail_client_id && !realId) { g.className = 'email-tag invalid'; g.textContent = 'client ID isn\'t real'; }
    else if (data.gmail_authorized) { g.className = 'email-tag verified'; g.textContent = 'authorized'; }
    else if (data.gmail_client_secret_set) { g.className = 'email-tag risky'; g.textContent = 'sign in under Inboxes'; }
    else { g.className = 'email-tag guess'; g.textContent = 'not set up'; }
  }
  const m = document.getElementById('m365-status');
  if (m) {
    const realM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test((data.m365_client_id || '').trim());
    if (data.m365_client_id && !realM) { m.className = 'email-tag invalid'; m.textContent = 'client ID isn\'t real'; }
    else if (data.m365_authorized) { m.className = 'email-tag verified'; m.textContent = 'authorized'; }
    else if (data.m365_client_id) { m.className = 'email-tag risky'; m.textContent = 'sign in under Inboxes'; }
    else { m.className = 'email-tag guess'; m.textContent = 'not set up'; }
  }
  tag('reoon-status', data.reoon_api_key_set, 'set');
  tag('zerobounce-status', data.zerobounce_api_key_set, 'set');
  tag('hunter-status', data.hunter_api_key_set, 'set');
}

function saveGmail() {
  const payload = {GMAIL_CLIENT_ID: document.getElementById('gmail-id').value.trim()};
  const sec = document.getElementById('gmail-secret').value;
  if (sec) payload.GMAIL_CLIENT_SECRET = sec;
  saveEnv(payload, 'Saved. Now sign in under Set up, Inboxes.').then(loadSettings);
}

function saveSmtp() {
  const payload = {
    SMTP_HOST: document.getElementById('smtp-host').value.trim(),
    SMTP_PORT: document.getElementById('smtp-port').value.trim(),
    SMTP_USERNAME: document.getElementById('smtp-user').value.trim(),
  };
  const pass = document.getElementById('smtp-pass').value;
  if (pass) payload.SMTP_PASSWORD = pass;
  // Blank IMAP fields fall back to the SMTP ones. A typed IMAP password wins;
  // otherwise the checkbox clears it back to the SMTP one, and an unticked
  // empty box keeps whatever IMAP password is saved.
  payload.IMAP_HOST = document.getElementById('imap-host').value.trim();
  payload.IMAP_PORT = document.getElementById('imap-port').value.trim();
  payload.IMAP_USERNAME = document.getElementById('imap-user').value.trim();
  const imapPass = document.getElementById('imap-pass').value;
  if (imapPass) payload.IMAP_PASSWORD = imapPass;
  else if (document.getElementById('imap-same-pass').checked) payload.IMAP_PASSWORD = '';
  saveEnv(payload, 'SMTP settings saved.').then(loadSettings);
}

function saveMicrosoft() {
  const client = document.getElementById('m365-client').value.trim();
  if (!client) { showToast('Paste the Application (client) ID first.', 'error'); return; }
  saveEnv({M365_CLIENT_ID: client, M365_TENANT_ID: document.getElementById('m365-tenant').value.trim()},
          'Saved. Now sign in under Set up, Inboxes.').then(loadSettings);
}

function saveVerifiers() {
  const payload = {};
  const r = document.getElementById('reoon-key').value;
  const z = document.getElementById('zerobounce-key').value;
  const h = document.getElementById('hunter-key').value;
  if (r) payload.REOON_API_KEY = r;
  if (z) payload.ZEROBOUNCE_API_KEY = z;
  if (h) payload.HUNTER_API_KEY = h;
  if (!Object.keys(payload).length) { showToast('Enter at least one key first.', 'error'); return; }
  saveEnv(payload, 'Verification keys saved.').then(loadSettings);
}

async function saveEnv(payload, okMsg) {
  const data = await api('/api/settings/env', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload)
  });
  if (data && data.success) showToast(okMsg, 'success');
  else showToast((data && data.message) || 'Save failed. Is the dashboard still running?', 'error');
}

// Secrets are only sent when typed: an empty box means "keep the saved one".
function saveInstantly() {
  const key = document.getElementById('instantly-key').value.trim();
  if (!key) { showToast('Enter a new key first. The saved one is kept.', 'error'); return; }
  saveEnv({INSTANTLY_API_KEY: key}, 'Instantly API key saved.');
}

function saveLinkedIn() {
  const payload = {LINKEDIN_EMAIL: document.getElementById('linkedin-email').value.trim()};
  const pass = document.getElementById('linkedin-password').value;
  if (pass) payload.LINKEDIN_PASSWORD = pass;
  saveEnv(payload, 'LinkedIn credentials saved.');
}

function saveCloudflare() {
  const payload = {CLOUDFLARE_ACCOUNT_ID: document.getElementById('cf-account-id').value.trim()};
  const token = document.getElementById('cf-api-token').value.trim();
  if (token) payload.CLOUDFLARE_API_TOKEN = token;
  saveEnv(payload, 'Cloudflare credentials saved.');
}

async function testInstantly() {
  const key = document.getElementById('instantly-key').value.trim();
  const el = document.getElementById('instantly-test-result');
  el.innerHTML = '<div class="test-result pending">Testing&hellip;</div>';
  const data = await api('/api/settings/test-instantly', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({api_key: key})
  });
  if (!data) {
    el.innerHTML = '<div class="test-result error">Could not reach the dashboard server.</div>';
    return;
  }
  el.innerHTML = '<div class="test-result ' + (data.success ? 'success' : 'error') + '">' + escHtml(failMsg(data, '')) + '</div>';
}

// ── Controls ──

async function loadSellbirdStatus() {
  const data = await api('/api/sellbird/status');
  const headerDot = document.getElementById('header-dot');
  const headerText = document.getElementById('header-status-text');

  if (_locked) return;  // the header already says "Locked"
  if (!data) {
    headerDot.className = 'status-dot offline';
    headerText.textContent = 'Offline';
    return;
  }
  const running = !!data.running;

  headerDot.className = 'status-dot ' + (running ? 'running' : 'stopped');
  headerText.textContent = running ? 'Running' : 'Stopped';
  document.getElementById('header-status').title = running ? 'Sellbird is running. Open the engine controls.' : 'Sellbird is stopped. Open the engine controls.';
  document.getElementById('control-dot').className = 'dot ' + (running ? 'running' : 'stopped');
  const label = document.getElementById('control-label');
  label.className = 'label ' + (running ? 'running' : 'stopped');
  label.textContent = running ? 'Running' : 'Stopped';

  const meta = document.getElementById('control-meta');
  if (running && data.pid) {
    let info = 'PID ' + escHtml(String(data.pid));
    if (data.started_at) info += ' &middot; started ' + formatDate(data.started_at);
    meta.innerHTML = info;
  } else {
    meta.innerHTML = 'Sellbird wakes every few minutes, does what needs doing, and sleeps.';
  }

  document.getElementById('btn-start').style.display = running ? 'none' : '';
  document.getElementById('btn-stop').style.display = running ? '' : 'none';
}

async function startSellbird() {
  const btn = document.getElementById('btn-start');
  btn.disabled = true;
  const data = await api('/api/sellbird/start', {method: 'POST'});
  if (data && data.success) showToast('Sellbird started.', 'success');
  else showToast((data && data.message) || 'Failed to start.', 'error');
  btn.disabled = false;
  loadSellbirdStatus();
}

async function stopSellbird() {
  const btn = document.getElementById('btn-stop');
  btn.disabled = true;
  const data = await api('/api/sellbird/stop', {method: 'POST'});
  if (data && data.success) showToast('Sellbird stopped.', 'success');
  else showToast((data && data.message) || 'Failed to stop.', 'error');
  btn.disabled = false;
  loadSellbirdStatus();
}

async function loadLogs() {
  const data = await api('/api/sellbird/logs');
  const el = document.getElementById('log-viewer');
  if (data && data.lines && data.lines.length) {
    const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    el.textContent = data.lines.join('\n');
    if (stick) el.scrollTop = el.scrollHeight;
  } else {
    el.textContent = 'No logs yet. Start Sellbird to see activity.';
  }
}

// ── Pipeline data ──

// Calls today per subscription — each labelled with the provider it ran on.
function brainCallChips(data) {
  const chip = (label, n) => '<span class="chip">' + label + ' calls today <b>' + escHtml(String(n || 0)) + '</b></span>';
  const codex = data.codex_calls_today || 0;
  const st = data.brain_status || {};
  // A paused brain must not look healthy: say so, and why.
  const paused = st.status === 'paused'
    ? '<span class="chip" title="' + escHtml(st.reason || '') + '">' +
      escHtml(st.provider === 'codex' ? 'Codex' : 'Brain') + ' <b>paused</b>: ' +
      escHtml((st.reason || '').slice(0, 120)) + '</span>'
    : '';
  if (data.brain_provider === 'codex') {
    return paused + chip('Codex', codex) + (data.claude_calls_today ? chip('Claude', data.claude_calls_today) : '');
  }
  return paused + chip('Claude', data.claude_calls_today) + (codex ? chip('Codex', codex) : '');
}

function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}


function emailTag(p) {
  if (!p.email) return '';
  // Fall back to the legacy boolean for rows predating email_status.
  const status = p.email_status || (p.email_verified ? 'verified' : 'guess');
  if (!own(STATUS, status)) return '';
  const m = statusMeta(status);
  return ' <span class="mini t-' + m.tone + '" title="Email ' + escHtml(m.label.toLowerCase()) + '">' +
    escHtml(m.label) + '</span>';
}

// Quota gauges for the ACTIVE provider only: Claude's are the numbers
// `/usage` shows in Claude Code; Codex's are the ChatGPT plan's limits.
// When they can't be read, say so rather than hiding the card.
function quotaCardHtml(data) {
  const provider = data && data.quota_provider;
  if (!provider) return '';
  const title = provider === 'codex' ? 'Codex (ChatGPT plan) Quota' : 'Claude Subscription Quota';
  let html = '<h2>' + escHtml(title) + '</h2>';
  if (!data.quota || !Object.keys(data.quota).length) {
    const why = provider === 'codex'
      ? "Quota unavailable: Sellbird couldn't read your ChatGPT plan's limits (check codex login, the Codex CLI version, and network)."
      : "Quota unavailable: Sellbird couldn't read your Claude subscription's limits (check claude login and network).";
    return html + '<p class="muted">' + escHtml(why) + ' Until it can, budgets count Sellbird\'s own calls.</p>';
  }
  const labels = {five_hour: '5-hour window', seven_day: 'Weekly', primary: 'Primary window',
                  secondary: 'Secondary window', limit_reached: 'Usage limit reached'};
  for (const [key, w] of Object.entries(data.quota)) {
    const pct = Math.min(100, Math.max(0, w.utilization || 0));
    const color = pct >= 80 ? 'yellow' : 'green';
    const resets = w.resets_at ? 'resets ' + formatDate(w.resets_at) : '';
    html += '<div class="progress-wrap">' +
      '<div class="progress-label">' +
        '<span class="text">' + escHtml(labels[key] || key) + (resets ? ' &middot; ' + escHtml(resets) : '') + '</span>' +
        '<span class="pct">' + pct.toFixed(0) + '%</span>' +
      '</div>' +
      '<div class="progress-bar"><div class="progress-fill ' + color + '" style="width:' + pct + '%"></div></div>' +
    '</div>';
  }
  return html;
}

async function loadUsage() {
  const data = await api('/api/usage');
  const statsEl = document.getElementById('usage-stats');
  if (!data) { statsEl.innerHTML = offlineState(); return; }

  const quotaEl = document.getElementById('usage-quota');
  const qHtml = quotaCardHtml(data);
  quotaEl.innerHTML = qHtml;
  quotaEl.style.display = qHtml ? 'block' : 'none';

  // Totals cards — usage-first (calls is the headline; tokens as chips).
  // No dollars: on a subscription plan usage isn't billed per token.
  const t = data.totals || {};
  const card = (label, p) => {
    p = p || {};
    return '<div class="stat-card"><div class="label">' + label + '</div>' +
      '<div class="value">' + (p.calls || 0) + '</div>' +
      '<div class="breakdown">' +
        '<span class="chip">calls</span>' +
        '<span class="chip">out <b>' + fmtTokens(p.output_tokens) + '</b></span>' +
        '<span class="chip">in <b>' + fmtTokens(p.input_tokens) + '</b></span>' +
        '<span class="chip">cached <b>' + fmtTokens(p.cache_read_tokens) + '</b></span>' +
      '</div></div>';
  };
  statsEl.innerHTML = card('Today', t.today) + card('Last 7 Days', t.week) + card('Last 30 Days', t.month);

  // Daily columns — output tokens per day (the work done)
  const dailyEl = document.getElementById('usage-daily');
  const days = (data.by_day || []).slice(-30);
  if (days.length) {
    const maxOut = Math.max(...days.map(d => d.output_tokens || 0), 1);
    dailyEl.innerHTML = '<h2>Output tokens per day <span class="hint muted" style="font-weight:400">last ' +
      days.length + ' days · peak ' + fmtTokens(maxOut) + '</span></h2>' +
      '<div class="chart-cols" role="img" aria-label="Output tokens per day">' + days.map(d =>
        '<span class="col" title="' + escHtml(d.day || '') + ': ' + fmtTokens(d.output_tokens) + ' out, ' +
          (d.calls || 0) + ' calls"><i style="height:' + Math.max(2, (d.output_tokens || 0) / maxOut * 100) + '%"></i></span>'
      ).join('') + '</div>' +
      '<div class="chart-axis"><span>' + escHtml(days[0].day || '') + '</span><span>' +
        escHtml(days[days.length - 1].day || '') + '</span></div>';
    dailyEl.style.display = 'block';
  } else {
    dailyEl.style.display = 'none';
  }

  // Breakdown tables — calls + tokens, no cost column
  const tablesEl = document.getElementById('usage-tables');
  const table = (title, rows, keyName) => {
    if (!rows || !rows.length) return '';
    const max = Math.max(...rows.map(r => r.calls || 0), 1);
    let h = '<div class="card flush"><div class="card-head"><h3>' + title + '</h3></div><table><thead><tr>' +
      '<th>' + keyName + '</th><th>Calls</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache read</th>' +
      '</tr></thead><tbody>';
    for (const r of rows) {
      h += '<tr><td class="cell-main">' + escHtml(String(r[keyName.toLowerCase()] || '')) + '</td>' +
        '<td><span class="meter-row"><span class="bar" style="width:120px"><span style="width:' +
          (100 * (r.calls || 0) / max) + '%;background:var(--accent)"></span></span><span class="v">' + (r.calls || 0) + '</span></span></td>' +
        '<td class="num muted">' + fmtTokens(r.input_tokens) + '</td>' +
        '<td class="num">' + fmtTokens(r.output_tokens) + '</td>' +
        '<td class="num muted">' + fmtTokens(r.cache_read_tokens) + '</td></tr>';
    }
    return h + '</tbody></table></div>';
  };

  const anyRows = (data.by_agent || []).length || (data.by_task || []).length;
  if (!anyRows) {
    tablesEl.innerHTML = emptyState(icon('usage'), 'No usage recorded yet',
      'Once Sellbird starts making model calls (Claude or Codex), every one is logged here with exact calls and tokens by provider, agent and task.');
  } else {
    const providers = data.by_provider || [];
    const showProviders = providers.length > 1 || (providers.length === 1 && providers[0].provider !== 'claude');
    tablesEl.innerHTML =
      (showProviders ? table('By Provider (30 days)', providers, 'Provider') : '') +
      table('By Agent (30 days)', data.by_agent, 'Agent') +
      table('By Task (30 days)', data.by_task, 'Task') +
      table('By Model (30 days)', data.by_model, 'Model');
  }
}

// ── Outbox: a decisions desk, not a wall of drafts ──
//
// Approving mail is a queue of one-at-a-time judgements. Showing all of them
// stacked invites a single "approve all" reflex, which is exactly the review
// the approval ladder exists to prevent. One email fills the pane; the rest
// wait in the rail.

async function loadOutbox() {
  const [data, mode] = await Promise.all([api('/api/outbox'), api('/api/sending-mode')]);
  _sendingMode = mode && !mode.error ? mode : null;
  const banner = document.getElementById('outbox-banner');
  const desk = document.getElementById('outbox-desk');
  const list = document.getElementById('outbox-list');
  const actions = document.getElementById('outbox-actions');
  if (!data) { desk.innerHTML = offlineState(); list.innerHTML = ''; return; }
  if (data.error) {
    // Never let a failed read pass for "Nothing to review".
    desk.innerHTML = emptyState(icon('alert'), 'Couldn\'t read the Outbox', escHtml(data.error));
    list.innerHTML = '';
    return;
  }

  const pending = data.pending || [];
  _desk.items = pending;
  _desk.footer = data.footer || '';
  // Keep the desk on the draft being edited even if the list shifted.
  const editingAt = _desk.editing ? pending.findIndex(p => p.id === _desk.editing) : -1;
  if (editingAt >= 0) _desk.i = editingAt;
  else if (_desk.editing) {
    _desk.editing = null;
    _desk.unsaved = null;
  }
  if (_desk.i >= pending.length) _desk.i = Math.max(0, pending.length - 1);
  _desk.paused = !!data.paused;
  _desk.total = Math.max(pending.length, Number(data.pending_total) || 0);
  navCount('nav-outbox', _desk.total);
  if (!_report) await loadAgentReport();
  outboxAnswer(_desk.total);

  actions.innerHTML = data.paused
    ? onlyYou() + '<button class="btn btn-primary btn-sm" onclick="sendingToggle(\'resume\')">Resume sending</button>'
    : '<button class="btn btn-secondary btn-sm" onclick="sendingToggle(\'pause\')">Pause all sending</button>';

  // The kill switch gets a banner only when it's actually on — a permanent
  // bar for a thing that isn't happening is just noise.
  banner.innerHTML = sendingModeBanner(_sendingMode) + (data.paused
    ? '<div class="banner bad">' + icon('alert') + '<div><b>Sending is paused</b>' +
        '<p>' + escHtml(data.paused) + '. Approved mail stays queued until you resume.</p></div></div>'
    : '');
  // Only once there is mail to warn about: a fresh install sends nothing.
  const anyMail = pending.length || (data.approved || []).length || (data.sent || []).length;
  if (data.compliance_notice && anyMail) {
    banner.innerHTML +=
      '<div class="banner wait">' + icon('alert') + '<div><b>Add your postal address</b>' +
        '<p>' + escHtml(data.compliance_notice) + '</p></div></div>';
  }

  outboxLog();
  desk.innerHTML = pending.length ? renderDesk(pending) :
    '<div class="card">' + emptyState(icon('check'), 'Nothing to review',
      _sendingMode && _sendingMode.mode === 'autopilot'
        ? 'Autopilot is on, so Sellbird sends on its own. Anything it holds for you shows up here.'
        : 'Every draft Sellbird writes lands here first. Approve one and it sends on schedule.') +
    '</div>';

  const table = (title, rows, cols) => {
    if (!rows || !rows.length) return '';
    let h = '<div class="subhead">' + title + ' <span class="hint">' + rows.length + '</span></div>' +
      '<div class="table-card"><table class="nowrap clip"><thead><tr>' +
      cols.map(c => '<th>' + c[0] + '</th>').join('') + '</tr></thead><tbody>';
    for (const r of rows) {
      h += '<tr>' + cols.map(c => '<td' + (c[2] ? ' class="muted"' : '') + '>' +
        (c[3] ? c[1](r) : escHtml(String(c[1](r) ?? ''))) + '</td>').join('') + '</tr>';
    }
    return h + '</tbody></table></div>';
  };

  list.innerHTML =
    table('Approved &amp; scheduled', data.approved, [
      ['To', r => r.to_email], ['Step', r => r.step], ['Subject', r => r.subject],
      ['Sends', r => r.status === 'sending' ? badge(r.status) : escHtml(formatDate(r.send_at)), true, true],
    ]) +
    table('Recently sent', data.sent, [
      ['To', r => r.to_email], ['Step', r => r.step], ['Subject', r => r.subject],
      ['Sent', r => formatDate(r.sent_at), true],
    ]) +
    table('Didn\'t send', data.failed, [
      ['To', r => r.to_email], ['Status', r => badge(r.status), false, true],
      ['Reason', r => r.error, true], ['Updated', r => formatDate(r.updated_at), true],
    ]);
}

// A short "What [agent] did here": the writing and sending lines of the log.
const OUTBOUND_ACTIONS = /^(write_|stage_campaign|email_sent|outbox|campaign|approve|reply_queued|send)/;
function outboxLog() {
  const el = document.getElementById('outbox-log');
  if (!el || !_report) return;
  const rows = (_report.log || []).filter(e => OUTBOUND_ACTIONS.test(e.action_type || '')).slice(0, 4);
  el.innerHTML = '<section class="sec" style="margin-top:24px"><h2>What ' + escHtml(agentName()) + ' did here</h2>' +
    logHtml(rows, 'Nothing yet. When ' + agentName() + ' writes or sends, it shows up here.') + '</section>';
}

const CONTACT_SOURCES = {
  known_company_backfill: 'team page on their site',
  company_website: 'team page on their site',
  scraped_mailto: 'address published on their site',
  linkedin_search: 'LinkedIn search',
  hunter_domain_search: 'Hunter domain search',
  job_board: 'job board',
  web_search: 'web search',
};

// What the draft is built on, so every claim can be checked against it.
function renderDeskContext(ctx) {
  if (!ctx) return '';
  const row = (k, v) => v ? '<div class="k">' + k + '</div><div class="v">' + v + '</div>' : '';
  const href = safeHref(ctx.website);
  const site = href
    ? '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' +
        escHtml(ctx.website.replace(/^https?:\/\//i, '')) + ' &#8599;</a>'
    : '';
  const who = [ctx.contact, ctx.contact_title].filter(Boolean).map(escHtml).join(' &middot; ');
  const email = [ctx.email_status, ctx.score ? 'score ' + ctx.score : '']
    .filter(Boolean).map(escHtml).join(' &middot; ');
  const signals = Object.entries(ctx.signals || {})
    .map(([k, v]) => escHtml(k) + ': <b>' + escHtml(v) + '</b>').join('<br>');
  return '<div class="desk-context">' +
    row('Company', escHtml(ctx.company)) +
    row('Website', site) +
    row('About', escHtml(ctx.description)) +
    row('Contact', who) +
    row('Found via', escHtml(Object.prototype.hasOwnProperty.call(CONTACT_SOURCES, ctx.contact_source)
      ? CONTACT_SOURCES[ctx.contact_source] : ctx.contact_source)) +
    row('Email', email) +
    row('Signals', signals) +
    row('Campaign', ctx.campaign ? escHtml(ctx.campaign) +
      ' <span class="muted">(how they were found, not a fact about them)</span>' : '') +
    row('Writer notes', escHtml(ctx.notes)) +
  '</div>';
}

// ── Approval or autopilot ──
// Approval (the default): every email waits in the Outbox for you.
// Autopilot (channels.email.require_approval: false): Sellbird sends on its
// own, and still holds what gate.autopilot_review flags. Turning autopilot
// on takes typing the word; turning it off is one click and works at once.
let _sendingMode = null, _autopilotArmed = false, _modeBusy = false;

function sendingModeBanner(m) {
  if (!m) return '';
  if (m.mode === 'autopilot') {
    return '<div class="banner wait mode-banner">' + icon('alert') + '<div><b>Autopilot is on</b>' +
      '<p>Sellbird sends email on its own. It holds anything that links to a site that isn’t yours or ' +
      'quotes its own instructions; those wait here' + (m.held ? ' (' + m.held + ' now)' : '') + '.</p></div>' +
      '<button class="btn btn-secondary btn-sm" onclick="setSendingMode(\'approval\')"' +
        (_modeBusy ? ' disabled' : '') + '>Turn off autopilot</button></div>';
  }
  const instantly = m.provider === 'instantly';
  return '<div class="banner mode-banner">' + icon('check') + '<div><b>Approval mode</b>' +
    '<p>' + (instantly
      ? 'Instantly can’t hold single emails, so campaigns aren’t sent to Instantly until you turn on autopilot.'
      : 'Every email Sellbird writes waits here until you approve it.') +
    ' <a href="#" onclick="goTab(\'settings\');return false">About autopilot</a></p></div></div>';
}

function sendingModeCard(m) {
  if (!m) return '<div class="card muted">Couldn’t read the sending mode.</div>';
  const auto = m.mode === 'autopilot';
  const instantly = m.provider === 'instantly';
  const domains = (m.your_domains || []).map(escHtml).join(', ') || 'none yet';
  let html = '<div class="card mode-card"><h3>Sending mode: ' + (auto ? 'Autopilot' : 'Approval') + '</h3>' +
    '<p><b>Approval</b> (the default): every email Sellbird writes, first emails, follow-ups and replies, ' +
      'waits in the Outbox until you approve it.' +
      (instantly ? ' On Instantly, which can’t hold single emails, that means campaigns aren’t deployed.' : '') + '</p>' +
    '<p><b>Autopilot</b>: Sellbird sends on its own, on schedule, within your daily limit and quiet hours. ' +
      'Opt-outs, bounces and Pause all sending work the same. It still holds an email for you when it links ' +
      'to, or gives an address at, a site that isn’t yours, or quotes Sellbird’s own instructions: text from ' +
      'websites and replies can try to steer what it writes. The first reply after you undo an opt-out waits too.</p>' +
    '<p class="muted">Counted as yours: ' + domains + (m.booking_page ? '; your booking page ' + escHtml(m.booking_page) : '') +
      '. Add others under <code>channels.email.link_domains</code> in <code>' + escHtml(m.file) + '</code>.</p>';
  if (auto) {
    html += '<div class="convo-actions"><span class="muted">Turning it off works at once: emails autopilot ' +
      'approved that haven’t gone out come back to the Outbox.' +
      (instantly ? ' Campaigns already on Instantly keep running until you pause them there.' : '') + '</span>' +
      '<button class="btn btn-primary btn-sm" onclick="setSendingMode(\'approval\')"' +
        (_modeBusy ? ' disabled' : '') + '>Turn off autopilot</button></div>';
  } else if (_autopilotArmed) {
    html += '<div class="convo-actions mode-confirm"><span class="muted">Approve a batch or two by hand first ' +
      'and read what Sellbird writes. Type <b>autopilot</b> to turn it on. It starts from Sellbird’s next cycle.</span>' +
      '<input class="form-input" id="autopilot-confirm" autocomplete="off" aria-label="Type autopilot to confirm" ' +
        'oninput="document.getElementById(\'autopilot-go\').disabled = this.value.trim().toLowerCase() !== \'autopilot\'" ' +
        'onkeydown="if (event.key === \'Enter\' && this.value.trim().toLowerCase() === \'autopilot\') setSendingMode(\'autopilot\')">' +
      '<button class="btn btn-primary btn-sm" id="autopilot-go" disabled onclick="setSendingMode(\'autopilot\')">Turn on autopilot</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="_autopilotArmed=false;renderSendingModeCard()">Cancel</button></div>';
  } else {
    html += '<div class="convo-actions"><button class="btn btn-secondary btn-sm" ' +
      'onclick="_autopilotArmed=true;renderSendingModeCard()">Turn on autopilot…</button></div>';
  }
  return html + '</div>';
}

function renderSendingModeCard() {
  const el = document.getElementById('sending-mode-card');
  if (el) el.innerHTML = sendingModeCard(_sendingMode);
  const input = document.getElementById('autopilot-confirm');
  if (input) input.focus();
}

async function loadSendingModeCard() {
  const m = await api('/api/sending-mode');
  _sendingMode = m && !m.error ? m : null;
  renderSendingModeCard();
}

async function setSendingMode(mode) {
  if (_modeBusy) return;
  const body = {mode};
  if (mode === 'autopilot') {
    const input = document.getElementById('autopilot-confirm');
    body.confirm = input ? input.value.trim().toLowerCase() : '';
  }
  _modeBusy = true;
  document.querySelectorAll('.mode-banner button, .mode-card button').forEach(b => { b.disabled = true; });
  try {
    const res = await api('/api/sending-mode', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    });
    if (res && res.success) {
      _autopilotArmed = false;
      showToast(mode === 'autopilot'
        ? 'Autopilot is on from Sellbird’s next cycle. Held emails still wait for you.'
        : 'Autopilot is off. Every email waits for you' +
          (res.requeued ? '; ' + res.requeued + ' queued by autopilot came back to the Outbox.' : '.') +
          (_sendingMode && _sendingMode.provider === 'instantly'
            ? ' Campaigns already on Instantly keep running: pause them in Instantly.' : ''), 'success');
    } else {
      showToast(failMsg(res, 'Couldn’t change the sending mode.'), 'error');
    }
  } finally {
    _modeBusy = false;
  }
  loadSendingModeCard();
  loadOutbox();
}

// Why autopilot sent this back for a human (sender: gate.autopilot_review).
const HELD_PREFIX = 'held for your review: ';   // state.HELD_FOR_REVIEW
function heldReason(item) {
  const e = String((item && item.error) || '');
  const why = e.startsWith(HELD_PREFIX) ? e.slice(HELD_PREFIX.length) : '';
  return why.charAt(0).toUpperCase() + why.slice(1);
}

// The Outbox as the mockup draws it: a list of drafts, each opening in place
// with the reason the person was picked, then Approve, Ask your agent, Skip.
function draftWhy(it) {
  const c = it.context || {};
  const signals = Object.entries(c.signals || {}).slice(0, 3).map(([k, v]) => k + ': ' + v);
  const text = c.notes || signals.join('; ');
  const role = [c.contact_title, c.company].filter(Boolean).join(' at ');
  return {text, role};
}

function renderDraft(it) {
  const c = it.context || {};
  const name = c.contact || it.to_email || '';
  const parts = String(name).split(/[\s@.]+/);
  const open = _desk.open === it.id;
  const held = heldReason(it);
  const editing = _desk.editing === it.id;
  const why = draftWhy(it);
  const first = String(c.contact || '').split(' ')[0] || 'this person';
  const unsaved = (editing && _desk.unsaved) || {subject: it.subject || '', body: it.body || ''};
  const fixedSubject = it.kind === 'reply' ? ' readonly title="A reply keeps its subject so it stays in the thread"' : '';
  const added = it.kind === 'sequence' && !(it.body || '').trimEnd().endsWith(_desk.footer) ? _desk.footer : '';
  const kind = held ? '<span class="tag t-bad" title="Sellbird held this instead of sending it">Held</span>'
    : '<span class="tag">' + (it.kind === 'reply' ? 'Reply' : 'Email ' + escHtml(String(it.step || 1))) + '</span>';
  const draft = editing
    ? '<input id="desk-subject" class="desk-edit-subject" aria-label="Subject" value="' + escHtml(unsaved.subject) + '"' +
        fixedSubject + ' oninput="deskKeep()">' +
      '<textarea id="desk-body" class="desk-edit-body" aria-label="Email" rows="10" oninput="deskKeep()">' + escHtml(unsaved.body) + '</textarea>'
    : '<div><div class="subject">' + escHtml(it.subject || '(no subject)') + '</div>' +
      '<div class="body">' + escHtml(it.body) + '</div></div>';
  const acts = editing
    ? '<button class="btn btn-primary btn-sm" onclick="deskSave(' + jsq(it.id) + ')">Save</button>' +
      '<button class="btn btn-sm" onclick="deskEdit(null)">Cancel</button>'
    : '<button class="btn btn-primary btn-sm" onclick="outboxAct(' + jsq(it.id) + ',\'approve\')">Approve <kbd>A</kbd></button>' +
      '<button class="btn btn-sm" onclick="askAboutDraft(' + jsq(it.id) + ')">Ask ' + escHtml(agentName()) + ' to change it</button>' +
      '<button class="btn btn-sm" onclick="deskEdit(' + jsq(it.id) + ')">Edit <kbd>E</kbd></button>' +
      '<button class="btn btn-ghost btn-sm" onclick="outboxAct(' + jsq(it.id) + ',\'reject\')">Skip <kbd>R</kbd></button>' +
      onlyYou();
  return '<div class="draft' + (open ? ' open' : '') + '" data-id="' + escHtml(it.id) + '"><div class="draft-in">' +
    '<button type="button" class="draft-head" aria-expanded="' + open + '" aria-controls="dm-' + escHtml(it.id) + '" ' +
      'onclick="toggleDraft(' + jsq(it.id) + ')">' +
      '<span class="who" aria-hidden="true">' + initials(parts[0], parts[1]) + '</span>' +
      '<span class="grow"><span class="t" style="display:block">' + escHtml(name) +
        (c.company ? ' <span class="muted" style="font-weight:400">· ' + escHtml(c.company) + '</span>' : '') + '</span>' +
        '<span class="s" style="display:block">' + escHtml(it.subject || '(no subject)') + '</span></span>' +
      kind + icon('chevron', 'chev') + '</button>' +
    '<div class="draft-body" id="dm-' + escHtml(it.id) + '"><div><div class="draft-mail">' +
      '<div class="agentnote">' + SPARK_SVG + '<div><b>Why ' + escHtml(first) + ':</b> ' +
        (why.text ? escHtml(why.text) : 'no reason was recorded for this one, so check their site before you approve.') +
        (why.role ? ' ' + escHtml(why.role) + '.' : '') + '</div></div>' +
      (held ? '<div class="banner wait">' + icon('alert') + '<div><b>Sellbird held this instead of sending it</b>' +
        '<p>' + escHtml(held) + '. Read it first: text from a website or an email can try to steer what Sellbird writes.</p></div></div>' : '') +
      '<p class="draft-to">To ' + escHtml(it.to_email) + ' · sends ' + escHtml(formatDate(it.send_at)) + '</p>' +
      draft + (added ? '<div class="desk-footer" title="Added when it sends">' + escHtml(added) + '</div>' : '') +
      '<div class="draft-acts">' + acts + '</div>' +
    '</div></div></div></div></div>';
}

function renderDesk(items) {
  if (!_desk.open || !items.some(x => x.id === _desk.open)) _desk.open = items.length ? items[0].id : null;
  const free = approvable();
  return '<section class="sec"><h2>Drafts' + (_desk.total > items.length
      ? ' <span class="hint" style="margin-left:0">the first ' + items.length + ' of ' + _desk.total + '</span>' : '') +
    ' <span class="h-right">' + onlyYou() +
      (free && !_desk.paused ? '<button class="btn btn-primary btn-sm" onclick="outboxApproveAll()" ' +
        'title="Emails Sellbird held are left for you to approve one by one">Approve all ' + free + '</button>' : '') +
    '</span></h2><div class="drafts">' + items.map(renderDraft).join('') + '</div>' +
    '<p class="w-f" style="margin:0;padding:10px 20px 12px;border-top:1px solid var(--line)">Keys: <kbd>J</kbd> <kbd>K</kbd> move, ' +
      '<kbd>A</kbd> approve, <kbd>E</kbd> edit, <kbd>R</kbd> skip.</p></section>';
}

function paintDesk() {
  const el = document.getElementById('outbox-desk');
  if (el && _desk.items.length) el.innerHTML = renderDesk(_desk.items);
}

// How many Approve all would approve: every one waiting, less those Sellbird held.
function approvable() {
  const shown = _desk.items.length - _desk.items.filter(p => heldReason(p)).length;
  return Math.max(shown, (_desk.total || 0) - _desk.items.filter(p => heldReason(p)).length);
}

// Open or close one draft in place. A second click mid-way reverses it:
// the height is a transition, so it turns around from wherever it is.
function toggleDraft(id) {
  if (_desk.editing && _desk.editing !== id) { deskBusy(); return; }
  openDraft(_desk.open === id ? null : id);
}
function openDraft(id) {
  _desk.open = id;
  document.querySelectorAll('#outbox-desk .draft').forEach(d => {
    const on = d.dataset.id === _desk.open;
    d.classList.toggle('open', on);
    d.querySelector('.draft-head').setAttribute('aria-expanded', String(on));
  });
}

function askAboutDraft(id) {
  const it = _desk.items.find(x => x.id === id);
  if (!it) return;
  const c = it.context || {};
  copyPrompt('In Sellbird, rewrite the draft to ' + (c.contact || it.to_email) + (c.company ? ' at ' + c.company : '') +
    ' (outbox id ' + id + '). Keep the reason it found, keep it short, and leave it waiting for my approval.');
}

function deskEdit(id) {
  _desk.editing = id;
  _desk.unsaved = null;
  if (id) _desk.open = id;
  paintDesk();
  if (id) document.getElementById('desk-body').focus();
}

// What's typed survives a re-render (switching tabs and back reloads the desk).
function deskKeep() {
  _desk.unsaved = {
    subject: document.getElementById('desk-subject').value,
    body: document.getElementById('desk-body').value,
  };
}

// While a draft is being edited, nothing else may act on the stored version
// of it: Save or Cancel first.
function deskBusy() {
  if (!_desk.editing) return false;
  showToast('Save or cancel your edit first.', 'error');
  return true;
}

async function deskSave(id) {
  const subject = document.getElementById('desk-subject').value.trim();
  const body = document.getElementById('desk-body').value.trim();
  if (!subject || !body) { showToast('Subject and body are both required.', 'error'); return; }
  let data = null;
  try {
    const r = await authFetch('/api/outbox/' + encodeURIComponent(id) + '/edit', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({subject: subject, body: body}),
    });
    if (await lockIfRefused(r)) return;
    data = await r.json();
  } catch {}
  if (data && data.success) {
    _desk.editing = null;
    _desk.unsaved = null;
    showToast('Saved. Still waiting for your approval.', 'success');
    loadOutbox();
  } else {
    showToast((data && data.message) || 'Save failed.', 'error');
  }
}

function deskGo(n) {
  if (n < 0 || n >= _desk.items.length || deskBusy()) return;
  _desk.i = n;
  openDraft(_desk.items[n].id);
  const row = document.querySelector('#outbox-desk .draft[data-id="' + CSS.escape(_desk.items[n].id) + '"] .draft-head');
  if (row) row.focus({preventScroll: false});
}

// Keyboard review. Ignored while typing into a field, so Settings still works.
document.addEventListener('keydown', e => {
  if (currentTab !== 'outbox' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (_desk.editing) {
    const typing = /^(input|textarea)$/i.test(e.target.tagName || '');
    if (e.key === 'Escape') { e.preventDefault(); deskEdit(null); }
    else if (!typing && 'jkare'.includes(e.key.toLowerCase())) { e.preventDefault(); deskBusy(); }
    return;
  }
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
  const at = Math.max(0, _desk.items.findIndex(x => x.id === _desk.open));
  const cur = _desk.items[at];
  const k = e.key.toLowerCase();
  if (k === 'j') { e.preventDefault(); deskGo(at + 1); }
  else if (k === 'k') { e.preventDefault(); deskGo(at - 1); }
  else if (k === 'a' && cur) { e.preventDefault(); outboxAct(cur.id, 'approve'); }
  else if (k === 'r' && cur) { e.preventDefault(); outboxAct(cur.id, 'reject'); }
  else if (k === 'e' && cur) { e.preventDefault(); deskEdit(cur.id); }
});

// Approve or skip: the row folds away, the next draft opens, and the dock,
// the tab count and the answer line change at the same moment.
async function outboxAct(id, action) {
  if (deskBusy()) return;
  const data = await api('/api/outbox/' + encodeURIComponent(id) + '/' + action, {method: 'POST'});
  if (!(data && data.success)) { showToast(failMsg(data, 'Action failed.'), 'error'); loadOutbox(); return; }
  const at = _desk.items.findIndex(x => x.id === id);
  const next = _desk.items[at + 1] || _desk.items[at - 1];
  _desk.items = _desk.items.filter(x => x.id !== id);
  const row = document.querySelector('#outbox-desk .draft[data-id="' + CSS.escape(id) + '"]');
  showToast(action === 'approve' ? 'Approved. It sends on schedule.' : 'Skipped. This email won\'t go out.', 'success');
  _desk.total = Math.max(_desk.items.length, (_desk.total || 0) - 1);
  outboxCounts(_desk.total);
  if (next) openDraft(next.id);
  if (row) {
    row.classList.add('leaving');
    let gone = false;
    const done = () => { if (gone) return; gone = true; row.remove(); loadOutbox(); };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) setTimeout(done, 150);
    else setTimeout(done, 220);
  } else loadOutbox();
}

// The Outbox's numbers everywhere they show, from one place.
function outboxCounts(pending) {
  const before = _counts['nav-outbox'] || 0;
  navCount('nav-outbox', pending);
  navCount('nav-outbound', Math.max(0, (_counts['nav-outbound'] || 0) - (before - pending)));
  outboxAnswer(pending);
  const approveAll = document.querySelector('#outbox-desk .sec > h2 .btn-primary');
  const free = approvable();
  if (approveAll) { if (free) approveAll.textContent = 'Approve all ' + free; else approveAll.remove(); }
}

function outboxAnswer(pending) {
  setAnswer('outbox', pending ? toneBadge('warn', pending + ' waiting') : toneBadge('good', 'All approved'),
    pending
      ? agentWho() + ' wrote ' + plural(pending, 'email', 'emails') + ' that ' + (pending === 1 ? 'is' : 'are') +
        ' waiting for you. Each one says why that person, so you can decide in a minute.'
      : 'Nothing is waiting for you. ' + agentName() + ' adds drafts here as it writes them.',
    'Outbound');
}

async function outboxApproveAll() {
  if (deskBusy()) return;
  const data = await api('/api/outbox/approve-all', {method: 'POST'});
  if (data && data.success) showToast('Approved ' + data.approved + ' email(s).' + (data.held
    ? ' ' + data.held + ' Sellbird held ' + (data.held === 1 ? 'is' : 'are') + ' left for you to read and approve one by one.'
    : ''), 'success');
  else showToast(failMsg(data, 'Approve-all failed.'), 'error');
  loadOutbox();
}

async function sendingToggle(action) {
  const data = await api('/api/sending/' + action, {method: 'POST'});
  if (data && data.success) showToast(action === 'pause' ? 'Sending paused.' : 'Sending resumed.', 'success');
  else showToast(failMsg(data, action === 'pause' ? 'Could not pause sending.' : 'Could not resume sending.'), 'error');
  loadOutbox();
}

const COMPANIES_PER_PAGE = 50;
let _companiesPage = 0;

async function loadCompanies() {
  companyDrill = false;
  const el = document.getElementById('companies-list');
  const data = await api('/api/companies');
  if (!data) { el.innerHTML = offlineState(); return; }
  _companies = data;
  if (!data.length) {
    el.innerHTML = emptyState(icon('companies'), 'No companies yet',
      'Confirm your <b>Signals</b>, then <b>Find businesses</b>, both under Set up. ' +
      'OpenStreetMap is free and needs no account.');
    return;
  }
  renderCompaniesPage(_companiesPage);
}

function renderCompaniesPage(page) {
  const el = document.getElementById('companies-list');
  const data = _companies;
  const pages = Math.max(1, Math.ceil(data.length / COMPANIES_PER_PAGE));
  _companiesPage = Math.min(Math.max(0, page), pages - 1);
  const start = _companiesPage * COMPANIES_PER_PAGE;
  let html = '<div class="table-card"><table class="nowrap"><thead><tr><th>Company</th>' +
    '<th title="Company fit, 0-100: sector, decision maker, reachability, buying signal. Hover a score for why.">Fit</th>' +
    '<th title="Hover a status for why the company was or wasn\'t contacted">Status</th>' +
    '<th>Industry</th><th>Location</th><th class="num">Contacts</th><th>Added</th></tr></thead><tbody>';
  data.slice(start, start + COMPANIES_PER_PAGE).forEach((c, j) => {
    const i = start + j;
    const website = c.website || (c.domain ? 'https://' + c.domain : '');
    const domain = safeHref(website)
      ? '<a href="' + safeHref(website) + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">' +
        escHtml(c.domain || website.replace(/^https?:\/\//i, '')) + '</a>'
      : escHtml(c.domain);
    html += '<tr class="clickable" onclick="showCompanyContacts(' + i + ')">' +
      '<td><div class="cell-stack"><span class="cell-main">' + escHtml(c.name) + '</span>' +
        '<span class="cell-sub">' + domain + '</span></div></td>' +
      '<td title="' + escHtml((c.fit_reasons || []).join(' · ')) + '">' +
        (typeof c.fit === 'number' ? meterHtml(c.fit) : '') + '</td>' +
      '<td title="' + escHtml(c.register_why || '') + '">' + escHtml(c.register_status || '') + '</td>' +
      '<td>' + (c.industry ? '<span class="tag">' + escHtml(c.industry) + '</span>' : '') + '</td>' +
      '<td>' + escHtml(c.location) + '</td>' +
      '<td class="num">' + (c.contact_count || 0) + '</td>' +
      '<td class="muted">' + relTime(c.created_at) + '</td></tr>';
  });
  const pager = pages > 1
    ? ' &nbsp; <button class="btn btn-ghost btn-sm" ' + (_companiesPage === 0 ? 'disabled ' : '') +
        'onclick="renderCompaniesPage(' + (_companiesPage - 1) + ')">&larr; Prev</button> ' +
      'Page ' + (_companiesPage + 1) + ' of ' + pages +
      ' <button class="btn btn-ghost btn-sm" ' + (_companiesPage >= pages - 1 ? 'disabled ' : '') +
        'onclick="renderCompaniesPage(' + (_companiesPage + 1) + ')">Next &rarr;</button>'
    : '';
  el.innerHTML = html + '</tbody></table></div>' +
    '<div class="table-foot">' + (start + 1) + '–' + Math.min(start + COMPANIES_PER_PAGE, data.length) +
    ' of ' + data.length + ' compan' + (data.length === 1 ? 'y' : 'ies') + pager + '</div>';
}

// Basic facts about one company, above its contacts: where it came from,
// why it fits, what's been done, and what Sellbird saw on its own site.
function companyInfoCard(company, profile) {
  const c = (profile && profile.company) || company;
  const reg = (profile && profile.register) || {};
  const obs = (profile && profile.observations) || [];
  const link = (url, text) => safeHref(url)
    ? '<a href="' + safeHref(url) + '" target="_blank" rel="noopener noreferrer">' + escHtml(text || url) + '</a>'
    : escHtml(text || url || '');
  const website = c.website || (c.domain ? 'https://' + c.domain : '');
  const row = (k, v) => v ? '<tr><td class="muted" style="width:170px;vertical-align:top">' + k +
    '</td><td style="white-space:normal">' + v + '</td></tr>' : '';
  const latest = {};
  for (const o of obs) {
    const key = o.signal_code + '|' + (o.value_text || o.value_num);
    if (!latest[key] && (o.value_text || o.value_num !== null)) latest[key] = o;
  }
  const by = code => Object.values(latest).filter(o => o.signal_code === code);
  const list = (items, max) => items.slice(0, max).map(o =>
    (o.evidence_url ? link(o.evidence_url, o.value_text || String(o.value_num)) : escHtml(o.value_text || String(o.value_num)))
  ).join('<br>');
  const people = by('DECISION_MAKER_TITLE').length ? by('DECISION_MAKER_TITLE') : by('CONTACT_FOUND');
  const form = by('CONTACT_FORM_URL')[0];
  const shown = new Set(['DECISION_MAKER_TITLE', 'CONTACT_FOUND', 'CONTACT_FORM_URL', 'HIRING_ROLE', 'FOUND_IN_SERP', 'TECH_STACK']);
  const other = Object.values(latest).filter(o => !shown.has(o.signal_code));
  let html = '<div class="card" style="margin-bottom:16px"><div class="card-head"><h3>' + escHtml(c.name || c.domain) + '</h3>' +
    '<span class="meta">' + (typeof company.fit === 'number' ? 'Fit ' + company.fit + ' / 100' : '') + '</span></div>' +
    '<table><tbody>' +
    row('Website', link(website, c.domain || website)) +
    row('Sector', escHtml(c.industry)) +
    row('Area', escHtml(c.location)) +
    row('Why selected', escHtml(reg.why_selected || (company.fit_reasons || []).join(' · '))) +
    row('Status', '<b>' + escHtml(reg.status || company.register_status || '') + '</b>' +
      (reg.why_not_contacted || company.register_why ? ': ' + escHtml(reg.why_not_contacted || company.register_why) : '')) +
    row('People named on site', list(people, 8)) +
    row('Contact form', form ? link(form.value_text, form.value_text) : '') +
    row('Hiring', list(by('HIRING_ROLE'), 6)) +
    row('Tech on website', escHtml(by('TECH_STACK').map(o => o.value_text).slice(0, 1).join(''))) +
    row('Other signals', other.slice(0, 8).map(o => escHtml(o.label) + ': ' +
      escHtml(o.value_text || String(o.value_num))).join('<br>')) +
    row('Found via', c.source_url ? link(c.source_url, 'search result') + ' · ' + escHtml(c.source || '') : escHtml(c.source || '')) +
    row('First found', escHtml((c.created_at || '').slice(0, 10))) +
    '</tbody></table></div>';
  return html;
}

async function showCompanyContacts(index) {
  const company = _companies[index];
  if (!company) return;
  companyDrill = true;
  const el = document.getElementById('companies-list');
  const [data, profile] = await Promise.all([
    api('/api/companies/' + encodeURIComponent(company.id) + '/contacts'),
    api('/api/companies/' + encodeURIComponent(company.id) + '/profile'),
  ]);
  let html = '<button class="btn btn-ghost btn-sm" onclick="loadCompanies()" style="margin-bottom:12px">' +
    '&larr; All companies</button>' + companyInfoCard(company, profile) +
    '<div class="card flush"><div class="card-head"><h3>Contacts</h3>' +
    '<span class="meta">' + escHtml([company.industry, company.location].filter(Boolean).join(' · ')) + '</span></div>';
  if (!data || !data.length) {
    html += '<div class="empty"><div class="copy">No contacts found at this company yet.</div></div></div>';
  } else {
    html += '<table><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>LinkedIn</th><th>Status</th><th>Source</th></tr></thead><tbody>';
    for (const p of data) {
      const phoneIcon = p.phone_verified ? ' <span class="muted">&#10003;</span>' : '';
      html += '<tr><td><div class="cell-row"><span class="avatar">' + initials(p.first_name, p.last_name) + '</span>' +
          '<div class="cell-stack"><span class="cell-main">' + escHtml(p.first_name) + ' ' + escHtml(p.last_name) + '</span>' +
          '<span class="cell-sub">' + escHtml(p.title) + '</span></div></div></td>' +
        '<td>' + escHtml(p.email) + emailTag(p) + '</td>' +
        '<td>' + escHtml(p.phone) + phoneIcon + '</td>' +
        '<td>' + (safeHref(p.linkedin_url) ? '<a href="' + safeHref(p.linkedin_url) + '" target="_blank" rel="noopener noreferrer">Profile</a>' : '') + '</td>' +
        '<td>' + badge(p.status) + '</td><td class="muted">' + sourceLabel(p.source) + '</td></tr>';
    }
    html += '</tbody></table></div>';
  }
  el.innerHTML = html;
}

async function submitFeedback(entityType, entityId, promptText) {
  const comment = prompt(promptText || 'Add your feedback:');
  if (!comment) return;
  const data = await api('/api/feedback', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({entity_type: entityType, entity_id: entityId, comment: comment})
  });
  if (data && data.success) showToast(entityType === 'campaign'
    ? 'Saved. Sellbird follows it in the emails it writes from now on.'
    : 'Saved. Sellbird uses it if it writes this person\'s first email (Gmail, SMTP or Microsoft 365).', 'success');
  else showToast((data && data.message) || 'Could not save feedback.', 'error');
}

function fbProspect(i) {
  const p = _prospects[i];
  if (p) submitFeedback('contact', p.id, 'Anything Sellbird should know before writing to this person?');
}

function fbCampaign(i) {
  const c = _campaigns[i];
  if (c) submitFeedback('campaign', c.id, 'What should Sellbird do differently in the emails it writes next? (e.g. "shorter; don\'t mention reviews")');
}

// Search and the stage filter live outside the list, so the 15-second refresh
// re-renders rows without losing what you typed.
let _contactQuery = '', _contactFilter = 'all', _contactSource = 'all';
let _pipeline = null;   // /api/pipeline: stage and source names, sequence length
const STAGE_FALLBACK = {new: 'New', talking: 'Talking', meeting_booked: 'Meeting booked',
                        proposal: 'Proposal', won: 'Won', lost: 'Lost'};
const STAGE_TONES = {talking: 'acc', meeting_booked: 'good', proposal: 'wait', won: 'good', lost: ''};

function stageNames() { return (_pipeline && _pipeline.stage_labels) || STAGE_FALLBACK; }
function stageOf(p) { return own(stageNames(), p.stage) ? p.stage : 'new'; }
function sourceOf(p) { return p.lead_source || 'cold_email'; }
function sourceName(key) {
  const names = (_pipeline && _pipeline.source_labels) || {};
  return own(names, key) || String(key || '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}

async function loadProspects() {
  const el = document.getElementById('prospects-table');
  const [data, pipe] = await Promise.all([api('/api/prospects'), api('/api/pipeline')]);
  if (!data) { el.innerHTML = offlineState(); return; }
  _prospects = data;
  if (pipe && !pipe.error) _pipeline = pipe;
  if (Array.isArray(data)) {
    const companies = new Set(data.map(x => x.company_id || x.company).filter(Boolean)).size;
    const talking = data.filter(x => ['talking', 'meeting_booked', 'proposal'].includes(x.stage)).length;
    setAnswer('prospects', toneBadge('info', plural(data.length, 'person', 'people')),
      data.length
        ? plural(data.length, 'person', 'people') + (companies ? ' at ' + plural(companies, 'company', 'companies') : '') + '. ' +
          (talking ? talking + (talking === 1 ? ' is' : ' are') + ' talking to you.' : 'Nobody is talking to you yet.')
        : agentName() + ' hasn\'t found anyone yet.',
      'People');
  }
  if (!data.length) {
    el.innerHTML = emptyState(icon('contacts'), 'No one here yet',
      'Sellbird hasn\'t found any prospects. Once it\'s running, the Scout agent searches the web for people matching your ideal customer profile in <b>sellbird.yaml</b>.');
    return;
  }
  if (!document.getElementById('contact-rows')) {
    el.innerHTML = '<div class="stages" id="contact-filters" role="group" aria-label="Filter by stage"></div>' +
      '<div class="toolbar">' +
      '<label class="search">' + icon('discover') +
        '<input class="form-input" id="contact-search" type="search" placeholder="Search name, company, email" ' +
        'aria-label="Search people" oninput="_contactQuery=this.value;renderContacts()"></label>' +
      '<div class="chips" id="contact-sources" role="group" aria-label="Filter by source"></div>' +
      '</div><div id="contact-rows"></div>';
    // A rebuild after an offline blip must show the search still applied.
    document.getElementById('contact-search').value = _contactQuery;
  }
  renderContacts();
}

function contactMatches(p, f) {
  return f === 'all' || stageOf(p) === f;
}

function setContactFilter(f) { _contactFilter = f; renderContacts(); }
function setContactSource(s) { _contactSource = s; renderContacts(); }

// Move someone to another stage. It sends nothing; a booking goes through
// markMeeting, which also stops their follow-ups.
async function setStage(i, stage) {
  const p = _prospects[i];
  if (!p || !stage) return;
  if (stage === 'meeting_booked') { markMeeting(i); return; }
  const res = await api('/api/prospects/' + encodeURIComponent(p.id) + '/stage', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({stage}),
  });
  if (res && res.success) showToast('Moved to ' + (own(stageNames(), stage) || stage) + '.', 'success');
  else showToast(failMsg(res, 'Could not move them.'), 'error');
  loadProspects();
}

async function markMeeting(i) {
  const p = _prospects[i];
  if (!p) return;
  const when = prompt('A meeting is booked with ' + ([p.first_name, p.last_name].filter(Boolean).join(' ') || p.email) +
    '. Their follow-ups stop.\n\nWhen is it? Optional, for example 2026-03-10 15:00', '');
  if (when === null) { loadProspects(); return; }
  let starts = '';
  if (when.trim()) {
    const dt = new Date(when.trim().replace(' ', 'T'));
    if (isNaN(dt)) { showToast('That time was not understood. Try 2026-03-10 15:00.', 'error'); return; }
    starts = dt.toISOString();
  }
  const res = await api('/api/prospects/' + encodeURIComponent(p.id) + '/meeting', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({starts_at: starts}),
  });
  if (res && res.success) {
    const n = (res.meeting && res.meeting.cancelled) || 0;
    showToast('Meeting recorded.' + (n ? ' ' + n + ' queued email' + (n === 1 ? '' : 's') + ' cancelled.' : ' Follow-ups stop.'), 'success');
  } else showToast(failMsg(res, 'Could not record the meeting.'), 'error');
  loadProspects();
}

// One person as a row: who they are, where they stand, what you can do.
function contactRow(p, i) {
  const name = [p.first_name, p.last_name].filter(Boolean).map(escHtml).join(' ') || escHtml(p.email);
  const role = [p.title, p.company].filter(Boolean).map(escHtml).join(', ');
  const reach = [escHtml(p.email) + emailTag(p), p.phone ? escHtml(p.phone) +
    (p.phone_verified ? ' <span class="verified" title="Phone verified">&#10003;</span>' : '') : '']
    .filter(x => x.trim()).join(' · ');
  const meta = [sourceLabel(p.source), p.score || p.score === 0 ? 'score ' + escHtml(String(p.score)) : '',
    relTime(p.created_at)].filter(Boolean).join(' · ');
  const optOut = p.status === 'opted_out' || p.opt_out_undone || _optOut.id === p.id
    ? '<button class="btn btn-ghost btn-sm" onclick="toggleOptOut(' + i + ')" ' +
      'aria-expanded="' + (_optOut.id === p.id) + '" title="What made Sellbird stop emailing them">' +
      (p.status === 'opted_out' ? 'Why?' : 'Opt-out history') + '</button>' : '';
  return '<div class="row">' +
    '<span class="who" aria-hidden="true">' + initials(p.first_name, p.last_name) + '</span>' +
    '<div class="grow"><p class="t"><button type="button" class="linklike" onclick="openPerson(' + jsq(p.id) + ')">' + name + '</button></p>' +
      (role ? '<p class="s">' + role + '</p>' : '') +
      (reach ? '<p class="s">' + reach + '</p>' : '') +
      (p.next_step ? '<p class="s">Next: ' + escHtml(p.next_step) + '</p>' : '') +
      '<p class="time">' + meta + '</p></div>' +
    '<span class="tag' + (STAGE_TONES[stageOf(p)] ? ' ' + STAGE_TONES[stageOf(p)] : '') + '" title="Stage">' +
      escHtml(stageNames()[stageOf(p)]) + '</span>' +
    '<span class="tag" title="Where they came from">' + escHtml(sourceName(sourceOf(p))) + '</span>' +
    badge(p.status) +
    '<div class="row-acts">' + optOut +
      (p.status === 'opted_out' ? '' :
        '<select class="form-input stage-move" aria-label="Move ' + name + ' to a stage" onchange="setStage(' + i + ',this.value)">' +
        '<option value="">Move to</option>' + Object.keys(stageNames()).filter(k => k !== stageOf(p)).map(k =>
          '<option value="' + k + '">' + escHtml(stageNames()[k]) + '</option>').join('') + '</select>') +
      '<button class="btn btn-ghost btn-sm" onclick="fbProspect(' + i + ')" ' +
      'title="Tell Sellbird something before it writes to this person">Feedback</button></div>' +
    '</div>' +
    (_optOut.id === p.id ? '<div class="row-detail">' + optOutPanel(p) + '</div>' : '');
}

const CONTACTS_SHOWN = 200;   // rows drawn at once; search narrows the rest

function renderContacts() {
  const rowsEl = document.getElementById('contact-rows');
  const filtersEl = document.getElementById('contact-filters');
  if (!rowsEl) return;
  const q = _contactQuery.trim().toLowerCase();
  const found = p => !q || [p.first_name, p.last_name, p.company, p.email, p.title].join(' ').toLowerCase().includes(q);
  const inSource = p => _contactSource === 'all' || sourceOf(p) === _contactSource;
  const stages = [['all', 'Everyone']].concat(Object.keys(stageNames()).map(k => [k, stageNames()[k]]));
  filtersEl.innerHTML = stages.map(f =>
    '<button type="button" class="stage' + (f[0] === _contactFilter ? ' on' : '') + '" aria-pressed="' + (f[0] === _contactFilter) +
      '" onclick="setContactFilter(\'' + f[0] + '\')"><b>' +
      _prospects.filter(p => contactMatches(p, f[0]) && found(p) && inSource(p)).length + '</b><span>' + escHtml(f[1]) + '</span></button>'
  ).join('');
  const sources = [...new Set(_prospects.map(sourceOf))].sort();
  const sourcesEl = document.getElementById('contact-sources');
  if (sourcesEl) sourcesEl.innerHTML = [['all', 'All sources']].concat(sources.map(s => [s, sourceName(s)])).map(s =>
    '<button type="button" class="chip-btn' + (s[0] === _contactSource ? ' on' : '') + '" aria-pressed="' + (s[0] === _contactSource) +
      '" onclick="setContactSource(' + jsq(s[0]) + ')">' + escHtml(s[1]) + ' <b>' +
      _prospects.filter(p => (s[0] === 'all' || sourceOf(p) === s[0]) && found(p)).length + '</b></button>').join('');

  const rows = _prospects.map((p, i) => [p, i]).filter(([p]) => contactMatches(p, _contactFilter) && found(p) && inSource(p));
  if (!rows.length) {
    rowsEl.innerHTML = '<div class="w">' + emptyState(icon('discover'), 'No matches',
      'Nothing matches that search and filter.') + '</div>';
    return;
  }
  rowsEl.innerHTML = '<div class="w">' + rows.slice(0, CONTACTS_SHOWN).map(([p, i]) => contactRow(p, i)).join('') +
    '<p class="w-f">' + (rows.length > CONTACTS_SHOWN ? 'Showing the first ' + CONTACTS_SHOWN + ' of ' : '') +
    rows.length + ' of ' + _prospects.length + ' people' +
    (rows.length > CONTACTS_SHOWN ? '. Search to narrow it down.' : '') + '</p></div>';
}

// Why someone is opted out, and undoing it. Sellbird never moves anyone off
// "opted out" on its own, so a mistaken one (a bare "stop" that meant
// something else) needs you: see what triggered it, then undo it here.
let _optOut = {id: null, data: null, armed: false, busy: false};
const OPT_OUT_RULES = {
  phrase: 'Matched an opt-out phrase',
  no_thanks: 'Matched “no thanks”',
  only_words: 'Their reply was only an opt-out word',
  model: 'The model’s judgement (no phrase matched)',
};

async function toggleOptOut(i) {
  const p = _prospects[i];
  if (!p) return;
  if (_optOut.id === p.id) { _optOut = {id: null, data: null, armed: false, busy: false}; renderContacts(); return; }
  _optOut = {id: p.id, data: null, armed: false, busy: false};
  renderContacts();
  const data = await api('/api/prospects/' + encodeURIComponent(p.id) + '/opt-out');
  if (_optOut.id !== p.id) return;   // closed or switched meanwhile
  _optOut.data = data || {error: true};
  renderContacts();
}

function optOutPanel(p) {
  const d = _optOut.data;
  const name = escHtml([p.first_name, p.last_name].filter(Boolean).join(' ') || p.email);
  if (!d) return '<div class="optout-panel muted">Loading…</div>';
  if (d.error) return '<div class="optout-panel muted">Couldn’t load the opt-out record. Try again.</div>';
  let html = '<div class="optout-panel"><h4>' + (d.opted_out ? 'Why Sellbird stopped emailing ' : 'Opt-out history for ') +
    name + '</h4>';
  if (d.recorded) {
    html += '<p>' + escHtml(d.why) + '</p><div class="optout-meta">' +
      escHtml(own(OPT_OUT_RULES, d.rule) || d.rule || '') + (d.at ? ' · ' + relTime(d.at) : '') + '</div>';
  } else if (d.opted_out || (d.history || []).length) {
    html += '<p>They opted out before Sellbird kept a record of why.' +
      (d.message ? ' The last thing they wrote:' : ' There’s no reply from them on file.') + '</p>';
  }
  if (d.message) {
    html += '<div class="thread-msg received"><div class="sender">' + escHtml(p.first_name || 'They') +
      (d.at ? ' &middot; ' + relTime(d.at) : '') + '</div>' + escHtml(d.message) + '</div>';
  }
  const undone = (d.history || []).filter(h => h.action === 'opt_out_undone');
  if (undone.length) {
    html += '<div class="optout-meta">' + undone.map(h => 'You undid an opt-out ' + relTime(h.at)).join(' · ') + '</div>';
  }
  if (!d.opted_out) {
    html += '<div class="convo-actions"><span class="muted">Not opted out now (' +
      escHtml(statusMeta(d.status).label) + ').</span></div>';
  } else if (_optOut.armed) {
    html += '<div class="convo-actions"><span class="muted">Sellbird will treat them as having replied. Nothing is ' +
      'sent automatically, emails the opt-out cancelled stay cancelled, and Sellbird’s answer to their next ' +
      'reply waits for your approval, even on autopilot. Only undo it if they didn’t mean to opt out.</span>' +
      '<button class="btn btn-primary btn-sm" onclick="undoOptOut()"' + (_optOut.busy ? ' disabled' : '') +
        '>Confirm undo</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="_optOut.armed=false;renderContacts()">Cancel</button></div>';
  } else {
    html += '<div class="convo-actions"><button class="btn btn-secondary btn-sm" ' +
      'onclick="_optOut.armed=true;renderContacts()">Undo opt-out</button></div>';
  }
  return html + '</div>';
}

async function undoOptOut() {
  const id = _optOut.id;
  if (!id || _optOut.busy) return;
  _optOut.busy = true;
  renderContacts();
  const res = await api('/api/prospects/' + encodeURIComponent(id) + '/opt-out/undo', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({confirm: true}),
  });
  if (res && res.success) showToast('Opt-out undone. They’re marked as replied; Sellbird sends nothing on its own.', 'success');
  else showToast(failMsg(res, 'Could not undo the opt-out. Try again.'), 'error');
  if (_optOut.id !== id) return;
  _optOut.armed = false;
  _optOut.busy = false;
  _optOut.data = await api('/api/prospects/' + encodeURIComponent(id) + '/opt-out') || {error: true};
  loadProspects();
}

// From a conversation: the contact, with the opt-out record open.
async function showOptOut(prospectId, email) {
  goTab('prospects');
  _contactQuery = email || '';
  const search = document.getElementById('contact-search');
  if (search) search.value = _contactQuery;
  await loadProspects();
  const i = _prospects.findIndex(p => p.id === prospectId);
  if (i >= 0 && _optOut.id !== prospectId) toggleOptOut(i);
}

// Opens a filled-in compose window in whatever Gmail account the browser is
// logged into. Nothing is sent from here — the user reads it and presses Send.
// Same values as the Sender's _render, so a hand-sent email reads the same.
function fillMergeVars(text, r) {
  const inbox = r.source === 'company_inbox';
  const vals = {
    first_name: r.first_name || (inbox ? 'there' : ''), last_name: r.last_name || '',
    company: r.company || '', title: r.title || '',
    personalization: r.personalization_notes || '',
  };
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => {
    k = k.toLowerCase();
    return Object.prototype.hasOwnProperty.call(vals, k) ? vals[k] : m;
  });
}

let _gmailBusy = false;  // one compose window per click, never two

async function openInGmail(ci, si, ri) {
  if (_gmailBusy) return;
  const c = _campaigns[ci];
  const step = c && (c.sequence || [])[si];
  const r = c && (c.recipients || [])[ri];
  if (!step || !r) return;
  // Cold email carries the postal address and opt-out line, sent by hand too.
  const filled = fillMergeVars(step.body, r).trimEnd();
  const body = filled + (c.footer && !filled.endsWith(c.footer) ? '\n\n' + c.footer : '');
  // authuser picks the Google account Sellbird sends as, not just whichever
  // one the browser happens to be signed into.
  const url = 'https://mail.google.com/mail/?view=cm&fs=1' +
    (c.send_as ? '&authuser=' + encodeURIComponent(c.send_as) : '') +
    '&to=' + encodeURIComponent(r.email) +
    '&su=' + encodeURIComponent(fillMergeVars(step.subject, r)) +
    '&body=' + encodeURIComponent(body);
  const left = /\{\{\s*\w+\s*\}\}/.test(fillMergeVars(step.subject, r) + fillMergeVars(step.body, r));
  // No 'noopener' feature string: with it window.open always returns null,
  // so a blocked pop-up could not be told apart from a successful one. The
  // tab opens blank right away (inside the click, so it isn't blocked) and
  // only gets the draft once the send is recorded.
  const w = window.open('', '_blank');
  if (!w) {
    showToast('Your browser blocked the Gmail tab. Allow pop-ups for this page and click again.', 'error');
    return;
  }
  w.opener = null;
  // Record the send BEFORE the user can press Send in Gmail, so Sellbird can
  // never email them as well — not even if they forget to tick the box.
  _gmailBusy = true;
  let claimed = r.sent_by_hand;
  try { if (!claimed) claimed = await markSent(ci, ri, true); } finally { _gmailBusy = false; }
  if (!claimed) { w.close(); return; }
  w.location.href = url;
  if (left) showToast('This draft still has a {{placeholder}} in it. Fix it in Gmail before sending.', 'error');
}

async function markSent(ci, ri, sent) {
  const r = (_campaigns[ci] && _campaigns[ci].recipients || [])[ri];
  if (!r) return;
  let res = null;
  try {
    const resp = await authFetch('/api/prospects/' + encodeURIComponent(r.id) + '/sent', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({sent}),
    });
    if (await lockIfRefused(resp)) return;
    res = await resp.json();
  } catch {}
  const ok = !!(res && res.success);
  if (!ok) showToast((res && res.message) || 'Could not save that. Try again.', 'error');
  else if (!sent && res.sent) showToast('They already replied, so this stays marked as sent.');
  else showToast(sent ? 'Marked as sent by you.' : 'Unmarked.', 'success');
  loadCampaigns();
  // True only when this call changed it: a status means they replied or
  // opted out, 'already' means another click or tab got there first.
  return ok && sent === !!res.sent && !res.status && !res.already;
}

// Where a campaign's people stand, as one stacked bar.
function campaignProgress(c) {
  const rs = c.recipients || [];
  if (!rs.length) return '';
  const count = st => rs.filter(r => st.includes(r.status)).length;
  const parts = [
    ['Contacted', count(['contacted']), 'c-accent'],
    ['Replied', count(['replied']), 'c-active'],
    ['Interested', count(['interested', 'meeting']), 'c-good'],
    ['Waiting', count(['new', 'queued']), 'c-accent-soft'],
  ];
  const closed = rs.length - parts.reduce((x, p) => x + p[1], 0);
  if (closed > 0) parts.push(['Closed out', closed, 'c-idle']);
  return '<div class="campaign-progress"><div class="bar" role="img" aria-label="Where this campaign\'s people stand">' +
    parts.filter(p => p[1]).map(p => '<span class="' + p[2] + '" style="width:' + (100 * p[1] / rs.length) +
      '%" title="' + p[0] + ': ' + p[1] + '"></span>').join('') + '</div>' +
    '<div class="campaign-legend">' + parts.filter(p => p[1]).map(p =>
      '<span><i class="' + p[2] + '"></i>' + p[0] + ' <b>' + p[1] + '</b></span>').join('') + '</div></div>';
}

async function loadCampaigns() {
  const el = document.getElementById('campaigns-list');
  const data = await api('/api/campaigns');
  if (!data) { el.innerHTML = offlineState(); return; }
  _campaigns = data;
  if (!data.length) {
    el.innerHTML = emptyState(icon('campaigns'), 'No campaigns yet',
      'The Writer agent hasn\'t drafted any sequences. It kicks in automatically once Sellbird has scored prospects to write for.');
    return;
  }
  const pipe = await api('/api/pipeline');
  if (pipe && !pipe.error) _pipeline = pipe;
  const len = (_pipeline && _pipeline.sequence_length) || 3;
  let html = '<p class="ask" style="margin:0 0 16px">New sequences are <b>' + len + ' email' + (len === 1 ? '' : 's') +
    '</b> long. There is no fixed limit: set <code>writer.sequence_length</code> in sellbird.yaml, or ask your coding agent. ' +
    'Follow-ups to a person stop on a reply, a booked meeting or an opt-out.</p>';
  data.forEach((c, i) => {
    let stepsHtml = '';
    (c.sequence || []).forEach((step, s) => {
      const sendBtns = (c.recipients || []).map((r, ri) => {
        // Only offered when Sellbird can't send itself and this person can
        // still be emailed (the server decides: can_send_by_hand).
        if (r.sent_by_hand) {
          const tick = '<label style="display:inline-flex;align-items:center;gap:4px;font-size:13px;cursor:pointer">' +
            '<input type="checkbox" checked onchange="markSent(' + i + ',' + ri + ',this.checked)"> ' +
            '&#10003; Sent by you</label>';
          if (s === 0) return '<span class="rcpt-who">' + escHtml(r.email) + '</span>' + tick;
          // Follow-ups are the user's too: Sellbird never emails someone they emailed.
          return '<span class="rcpt-who">' + escHtml(r.email) + '</span>' +
            '<button class="btn btn-secondary btn-sm" onclick="openInGmail(' + i + ',' + s + ',' + ri + ')">' +
            'Open in Gmail</button>' +
            '<span class="muted" style="font-size:12px">Sellbird won\'t send follow-ups to people you emailed yourself.</span>';
        }
        if (s !== 0) return '';
        if (!r.can_send_by_hand) {
          // Sellbird sends here; this only records an email the user already sent.
          return r.can_mark_sent
            ? '<label class="muted" style="display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">' +
              '<input type="checkbox" onchange="markSent(' + i + ',' + ri + ',this.checked)"> ' +
              'I already emailed ' + escHtml(r.email) + ' myself</label>'
            : '';
        }
        const risky = r.email_status === 'risky'
          ? ' <span class="mini t-waiting">Catch-all, may bounce</span>' : '';
        return '<span class="rcpt-who">' + escHtml(r.email) + risky + '</span>' +
          '<button class="btn btn-secondary btn-sm" onclick="openInGmail(' + i + ',' + s + ',' + ri + ')">' +
          'Open in Gmail</button>' +
          '<label><input type="checkbox" onchange="markSent(' + i + ',' + ri + ',this.checked)"> Mark as sent</label>'
      }).filter(Boolean).map(x => '<div class="rcpt">' + x + '</div>').join('');
      stepsHtml += '<div class="email-step"><span class="step-dot">' + escHtml(String(step.step || '?')) + '</span>' +
        '<div><div class="step-num">' + (s === 0 ? 'First email' : 'Follow-up') +
        (step.delay_days ? ' &middot; ' + escHtml(String(step.delay_days)) + ' days after the last' : '') + '</div>' +
        '<div class="subject">' + escHtml(step.subject) + '</div>' +
        '<div class="body">' + escHtml(step.body) + '</div>' +
        (sendBtns ? '<div class="step-actions">' + sendBtns + '</div>' : '') +
        '</div></div>';
    });
    const pc = (c.prospect_ids || []).length;
    html += '<div class="campaign-card"><div class="campaign-top">' +
      '<div class="campaign-title"><h3>' + escHtml(c.name || 'Untitled Campaign') + '</h3>' +
        '<button class="btn btn-ghost btn-sm" onclick="fbCampaign(' + i + ')">Feedback</button></div>' +
      '<div class="meta">' + badge(c.status) + '<span>' + pc + ' prospect' + (pc !== 1 ? 's' : '') + '</span>' +
        '<span>' + (c.sequence || []).length + ' emails</span><span>Created ' + relTime(c.created_at) + '</span></div>' +
      campaignProgress(c) + '</div>' +
      '<div class="sequence">' +
      (stepsHtml || '<p class="muted" style="font-size:13px;padding-top:16px">No email steps in this campaign.</p>') + '</div></div>';
  });
  el.innerHTML = html;
}

// The whole exchange in order: Sellbird's cold emails (from the Outbox), the
// replies, Sellbird's answers, and any answer still waiting for approval.
let _convos = [], _convoFilter = 'needs';
const STAGE_LABELS = {
  initial_outreach: 'Outreach', engaged: 'Engaged', qualifying: 'Qualifying', presenting: 'Presenting',
  negotiating: 'Negotiating', closing: 'Closing', closed_won: 'Won', closed_lost: 'Lost',
};
const CONVO_FILTERS = [
  ['needs', 'Needs you', c => !!c.draft || c.status === 'needs_human'],
  ['open', 'Open', c => c.status !== 'closed' && c.status !== 'awaiting_reply'],
  ['awaiting', 'Awaiting reply', c => c.status === 'awaiting_reply'],
  ['closed', 'Closed', c => c.status === 'closed'],
  ['all', 'All', () => true],
];

async function loadConversations() {
  const el = document.getElementById('conversations-list');
  const data = await api('/api/conversations?awaiting=1');
  if (!data) { el.innerHTML = offlineState(); return; }
  _convos = data;
  if (!data.length) {
    el.innerHTML = emptyState(icon('conversations'), 'No conversations yet',
      'No prospects have replied so far. When they do, the Handler agent classifies each reply and responds. Every thread shows up here.');
    return;
  }
  // Open on "Needs you" only when something needs you.
  if (_convoFilter === 'needs' && !data.some(CONVO_FILTERS[0][2]))
    _convoFilter = data.some(CONVO_FILTERS[1][2]) ? 'open' : 'all';
  renderConversations();
}

function setConvoFilter(f) { _convoFilter = f; renderConversations(); }

function renderConversations() {
  const el = document.getElementById('conversations-list');
  const filter = CONVO_FILTERS.find(f => f[0] === _convoFilter) || CONVO_FILTERS[CONVO_FILTERS.length - 1];
  const bar = '<div class="toolbar"><div class="chips" role="group" aria-label="Filter conversations">' +
    CONVO_FILTERS.map(f => '<button type="button" class="chip-btn' + (f[0] === filter[0] ? ' on' : '') + '" aria-pressed="' + (f[0] === filter[0]) +
      '" onclick="setConvoFilter(\'' + f[0] + '\')">' + f[1] + ' <b>' +
      _convos.filter(f[2]).length + '</b></button>').join('') + '</div></div>';
  // Handed-to-you first, then drafts waiting; otherwise newest first (as served).
  const rank = c => c.status === 'needs_human' ? 0 : c.draft ? 1 : 2;
  const shown = _convos.filter(filter[2]).map((c, i) => [c, i])
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0]);
  if (!shown.length) {
    el.innerHTML = bar + '<div class="card">' + emptyState(icon('check'), 'Nothing here',
      'No conversation matches this filter.') + '</div>';
    return;
  }
  el.innerHTML = bar + shown.map(convoCard).join('');
}

function convoCard(c) {
  const items = (c.emails || []).map(e => ({ts: e.sent_at, email: e}))
    .concat((c.thread || []).map(m => ({ts: m.timestamp, msg: m})))
    .map(it => ({...it, key: +parseTs(it.ts)}))
    // An item with no time goes last instead of scrambling the order.
    .sort((a, b) => (isNaN(a.key) ? Infinity : a.key) - (isNaN(b.key) ? Infinity : b.key) || 0);
  const first = c.first_name || 'Them';
  const thread = items.map(it => {
    if (it.email) {
      return '<div class="thread-email"><div class="te-head">' + icon('campaigns') +
        '<b>Email ' + escHtml(String(it.email.step)) + '</b><span>' + escHtml(it.email.subject) + '</span>' +
        '<span class="te-when">' + relTime(it.email.sent_at) + '</span></div>' +
        '<div class="te-body">' + escHtml(it.email.body) + '</div></div>';
    }
    const m = it.msg, sent = m.sender !== 'prospect';  // 'harvey' (the old name) is ours too
    return '<div class="thread-msg ' + (sent ? 'sent' : 'received') + '"><div class="sender">' +
      (sent ? 'Sellbird' : escHtml(first)) + ' &middot; ' + relTime(m.timestamp) + '</div>' +
      escHtml(m.content) + '</div>';
  }).join('');
  const draft = c.draft
    ? '<div class="thread-draft"><div class="sender">' + icon('pen') + 'Sellbird drafted a reply · waiting for you</div>' +
      '<div class="td-body">' + escHtml(c.draft.body) + '</div>' +
      '<button class="btn btn-primary btn-sm" onclick="goTab(\'outbox\')">Review in Outbox' + icon('arrow') + '</button></div>'
    : '';
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company || 'Unknown';
  const stage = own(STAGE_LABELS, c.stage) ? '<span class="tag">' + STAGE_LABELS[c.stage] + '</span>' : '';
  return '<div class="convo-card"><div class="convo-head">' +
    '<span class="avatar">' + initials(c.first_name, c.last_name) + '</span>' +
    '<div><h3>' + escHtml(name) + '</h3><div class="sub">' +
      escHtml([c.company, c.prospect_email].filter(Boolean).join(' · ')) + ' · ' + relTime(c.updated_at) + '</div></div>' +
    // An escalation's intent badge says the same as its status: show one.
    '<div class="tags">' + (c.intent && !(c.status === 'needs_human' && c.intent === 'escalate') ? badge(c.intent) : '') +
      stage + badge(c.status) + '</div></div>' +
    '<div class="thread">' + (thread || '<p class="muted" style="font-size:13px">No messages in this thread yet.</p>') +
    draft + '</div>' + convoActions(c) + '</div>';
}

// Sellbird answers new replies only on open conversations: an escalated one
// waits for you to reply yourself, then close it or hand it back.
function convoActions(c) {
  if (c.status === 'needs_human' && c.prospect_status === 'opted_out') {
    // A complaint or legal threat from someone who opted out: handing it
    // back wouldn't help, Sellbird never answers them.
    return '<div class="convo-actions"><span class="muted">' + icon('alert') +
      'Opted out, and Sellbird handed this to you. Reply from your inbox if you need to, then:</span>' +
      '<button class="btn btn-secondary btn-sm" onclick="setConvoStatus(' + jsq(c.id) + ',\'closed\')">Close</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="showOptOut(' + jsq(c.prospect_id) + ',' + jsq(c.prospect_email) +
      ')">Why opted out?</button></div>';
  }
  if (c.status === 'needs_human') {
    return '<div class="convo-actions"><span class="muted">' + icon('alert') +
      'Sellbird handed this to you. Reply from your inbox, then:</span>' +
      '<button class="btn btn-secondary btn-sm" onclick="setConvoStatus(' + jsq(c.id) + ',\'open\')">Hand back to Sellbird</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="setConvoStatus(' + jsq(c.id) + ',\'closed\')">Close</button></div>';
  }
  if (c.status === 'open') {
    return '<div class="convo-actions"><button class="btn btn-ghost btn-sm" onclick="setConvoStatus(' +
      jsq(c.id) + ',\'closed\')">Close conversation</button></div>';
  }
  if (c.status === 'closed' && c.prospect_status === 'opted_out') {
    // Reopening wouldn't help: Sellbird never answers someone who opted out.
    return '<div class="convo-actions"><span class="muted">' + icon('alert') + 'Opted out. Sellbird won’t write to them.</span>' +
      '<button class="btn btn-secondary btn-sm" onclick="showOptOut(' + jsq(c.prospect_id) + ',' + jsq(c.prospect_email) +
      ')">Why opted out?</button></div>';
  }
  if (c.status === 'closed') {
    return '<div class="convo-actions"><button class="btn btn-ghost btn-sm" onclick="setConvoStatus(' +
      jsq(c.id) + ',\'open\')">Reopen</button></div>';
  }
  return '';
}

async function setConvoStatus(id, status) {
  const data = await api('/api/conversations/' + encodeURIComponent(id) + '/status', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({status: status}),
  });
  if (data && data.success) showToast(status === 'open' ? 'Open again. Sellbird will answer the next reply.' : 'Closed. A new reply starts a new conversation.', 'success');
  else showToast(failMsg(data, 'Could not update that conversation.'), 'error');
  loadConversations();
  loadToday();
}

// ── Inboxes: the main mailbox and the extra ones you connected ──

const INBOX_STATE = {
  sending: ['Sending', 't-good'],
  paused: ['Paused', 't-waiting'],
  not_connected: ['Not connected', 't-bad'],
};
const INBOX_KINDS = {
  gmail: ['Gmail', 'Google Workspace or Gmail. Sign in with Google in your browser.'],
  microsoft: ['Microsoft 365', 'Outlook or Microsoft 365. Sign in with Microsoft in your browser.'],
  smtp: ['Other (SMTP)', 'Any other email host, with its SMTP server and password.'],
};
let _inboxes = null;
let _inboxPoll = null;

function inboxBadge(ib) {
  const [label, tone] = INBOX_STATE[ib.state] || [ib.state, 't-idle'];
  return '<span class="badge ' + tone + '">' + escHtml(label) + '</span>';
}

function inboxMeter(ib) {
  const cap = Math.max(1, Number(ib.cold_cap) || 0);
  const sent = Number(ib.cold_sent_today) || 0;
  const pct = Math.min(100, Math.round(sent / cap * 100));
  return '<div class="inbox-meter"><div class="line"><span>Cold emails today</span><span>' +
    sent + ' / ' + Number(ib.cold_cap) + '</span></div>' +
    '<div class="progress-bar"><div class="progress-fill ' + (pct >= 100 ? 'yellow' : 'green') +
    '" style="width:' + pct + '%"></div></div></div>';
}

function inboxDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
  return isNaN(d) ? iso : d.toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
}

async function loadInboxes() {
  const el = document.getElementById('inboxes-list');
  const actions = document.getElementById('inboxes-actions');
  const data = await api('/api/inboxes');
  if (!data) { el.innerHTML = offlineState(); return; }
  _inboxes = data;
  if (!data.native) {
    actions.innerHTML = '';
    el.innerHTML = emptyState(icon('inboxes'), 'Instantly sends for you',
      'Sending through several of your own inboxes works with Gmail, Microsoft 365 or SMTP. ' +
      'Set channels.email.provider in sellbird.yaml to one of those to use it.');
    return;
  }
  actions.innerHTML = '<button class="btn btn-primary" onclick="openAddInbox()">' + icon('plus') +
    'Add inbox</button>';

  let html = '';
  if (data.sending_paused) {
    html += '<div class="notice wait"><b>All sending is paused:</b> ' + escHtml(data.sending_paused) +
      '. Resume it in the Outbox.</div>';
  }
  const list = data.inboxes || [];
  const sending = list.filter(i => i.state === 'sending');
  const capToday = sending.reduce((n, i) => n + (Number(i.cold_cap) || 0), 0);
  const sentToday = list.reduce((n, i) => n + (Number(i.cold_sent_today) || 0), 0);
  const waiting = list.reduce((n, i) => n + (Number(i.first_emails_waiting) || 0), 0);
  html += '<div class="inbox-summary">' +
    '<span><b>' + list.length + '</b> ' + (list.length === 1 ? 'inbox' : 'inboxes') + ', <b>' + sending.length + '</b> sending</span>' +
    '<span><b>' + sentToday + '</b>' + (capToday ? ' of <b>' + Math.min(capToday, Number(data.max_daily_sends)) + '</b>' : '') + ' cold emails sent today</span>' +
    '<span><b>' + waiting + '</b> first emails waiting to go</span></div>';

  html += '<div class="inbox-list">';
  list.forEach((ib, i) => {
    const letter = (ib.address || '?').charAt(0).toUpperCase();
    const sub = [ib.name, ib.main ? 'Main mailbox' : (INBOX_KINDS[ib.provider === 'google' ? 'gmail' : ib.provider] || [ib.provider])[0]]
      .filter(Boolean).join(' · ');
    html += '<button class="inbox-row" onclick="openInbox(' + i + ')" aria-label="Open ' + escHtml(ib.address || 'main mailbox') + '">' +
      '<span class="inbox-avatar" aria-hidden="true">' + escHtml(letter) + '</span>' +
      '<span class="inbox-who"><div class="addr">' + escHtml(ib.address || '(main mailbox)') + '</div>' +
      '<div class="sub">' + escHtml(sub) + '</div></span>' +
      inboxBadge(ib) + inboxMeter(ib) +
      '<span class="inbox-waiting"><b>' + Number(ib.first_emails_waiting) + '</b>waiting</span>' +
      icon('chevron', 'chev') + '</button>';
  });
  html += '</div>';

  if (!data.several) {
    html += '<div class="card"><div class="card-title">Why add another inbox?</div><div class="inbox-help">' +
      '<div class="inset"><h4>Send more each day</h4><p>Each inbox sends up to ' + Number(data.per_inbox_daily_cap) +
      ' cold emails a day. Two inboxes, twice as many, all under your daily total of ' + Number(data.max_daily_sends) + '.</p></div>' +
      '<div class="inset"><h4>Protect your main address</h4><p>Send cold email from a second domain, so a bad week never touches your everyday mail.</p></div>' +
      '<div class="inset"><h4>Pick per campaign</h4><p>Choose which inboxes each campaign sends from. Replies always come back to the inbox that started the thread.</p></div>' +
      '</div><div class="btn-group"><button class="btn btn-secondary" onclick="openAddInbox()">' + icon('plus') + 'Add inbox</button></div></div>';
  }
  el.innerHTML = html;
}

// The dialog: one inbox's detail, or adding one.

function inboxDialog(html) {
  const d = document.getElementById('inbox-dialog');
  d.innerHTML = html;
  if (!d.open) d.showModal();
  return d;
}

function closeInboxDialog() {
  if (_inboxPoll) { clearInterval(_inboxPoll); _inboxPoll = null; }
  const d = document.getElementById('inbox-dialog');
  if (d.open) d.close();
}

function inboxDialogHead(title, sub, extra) {
  return '<div class="modal-head"><div><h3 id="inbox-dialog-title">' + title + '</h3>' +
    (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>' + (extra || '') +
    '<button class="btn btn-ghost btn-sm btn-icon" onclick="closeInboxDialog()" aria-label="Close">' + icon('close') + '</button></div>';
}

function openInbox(i) {
  const ib = (_inboxes && _inboxes.inboxes || [])[i];
  if (!ib) return;
  const campaigns = (_inboxes.campaigns || []);
  const pools = _inboxes.pools || {};
  const using = campaigns.filter(c => (pools[c.id] || []).includes(ib.id));
  const everyInbox = campaigns.filter(c => !pools[c.id]);
  let body = '';
  if (ib.state === 'not_connected') {
    body += '<div class="notice bad"><b>Not connected.</b> ' +
      escHtml(ib.connect_hint || 'Sellbird can\'t sign in to it from this computer. Check the connection to see why, or remove it and add it again.') + '</div>';
  }
  if (ib.paused_reason) {
    body += '<div class="notice wait"><b>Paused:</b> ' + escHtml(ib.paused_reason) + '</div>';
  }
  body += '<div class="modal-stats">' +
    '<div class="inset"><div class="k">Cold today</div><div class="v">' + Number(ib.cold_sent_today) + ' / ' + Number(ib.cold_cap) + '</div></div>' +
    '<div class="inset"><div class="k">First emails waiting</div><div class="v">' + Number(ib.first_emails_waiting) + '</div></div>' +
    '<div class="inset"><div class="k">Warming up since</div><div class="v">' + (ib.warmup_started_at ? escHtml(inboxDate(ib.warmup_started_at)) : '<span class="muted">Established</span>') + '</div></div>' +
    '</div>';
  body += '<div class="modal-section"><h4>Campaigns sending from it</h4>';
  if (!campaigns.length) body += '<p>No campaigns yet.</p>';
  else {
    const names = using.concat(everyInbox).map(c => escHtml(c.name || 'Untitled'));
    const shown = names.slice(0, 6).join(', ') + (names.length > 6 ? ', and ' + (names.length - 6) + ' more' : '');
    body += names.length ? '<p>' + shown + '</p>' : '<p>None. Every campaign has chosen other inboxes.</p>';
    if (everyInbox.length) body += '<p class="form-hint">Campaigns that haven\'t chosen inboxes send from all of them.</p>';
  }
  body += '</div>';

  if (ib.main) {
    const kind = ib.provider === 'gmail' || ib.provider === 'microsoft' ? ib.provider : '';
    if (ib.state === 'not_connected' && kind) {
      const can = (_inboxes.can_connect || {})[kind];
      body = '<div id="main-status"></div>' + (can
        ? '<div class="notice bad"><b>Not connected.</b> Sign in to the mailbox Sellbird sends from.</div>' +
          '<button class="btn btn-primary" id="main-go" onclick="connectMainMailbox(\'' + kind + '\')">Sign in with ' +
          (kind === 'gmail' ? 'Google' : 'Microsoft') + '</button><div style="height:16px"></div>'
        : connectSetupNotice(kind)) + body.replace(/<div class="notice bad"><b>Not connected.<\/b>[\s\S]*?<\/div>/, '');
    }
    body += '<div class="modal-section"><h4>Settings</h4><p>Your main mailbox comes from sellbird.yaml: ' +
      'its address is persona.email, its daily cap is channels.email.per_inbox_daily_cap, and pausing it pauses ' +
      'all sending, in the Outbox.</p></div>';
    inboxDialog(inboxDialogHead(escHtml(ib.address || 'Main mailbox'), inboxBadge(ib) + ' Main mailbox') +
      '<div class="modal-body">' + body + '</div>');
    return;
  }
  const id = jsq(ib.id);
  body += '<div class="modal-section"><h4>Daily cold-email cap</h4>' +
    '<div class="inline-edit"><input class="form-input" id="ib-cap" type="number" min="1" max="500" inputmode="numeric" placeholder="Default (' +
    Number(_inboxes.per_inbox_daily_cap) + ')" value="' + (ib.cap_is_yours ? Number(ib.cold_cap) : '') + '">' +
    '<button class="btn btn-secondary" onclick="saveInboxCap(' + id + ')">Save</button></div>' +
    '<div class="form-hint">Leave empty for the default. Warming inboxes start lower on their own.</div></div>';
  body += '<div class="modal-section"><h4>Sender name</h4>' +
    '<div class="inline-edit"><input class="form-input" id="ib-name" maxlength="100" placeholder="Your persona name" value="' + escHtml(ib.name || '') + '">' +
    '<button class="btn btn-secondary" onclick="saveInboxName(' + id + ')">Save</button></div>' +
    '<div class="form-hint">The name people see in From.</div></div>';
  body += '<div class="modal-section"><h4>Remove this inbox</h4><p>Sellbird stops sending from it, and threads it started end. Its sign-in stays in your keychain.</p>' +
    '<div class="inline-edit" style="margin-top:8px"><input class="form-input" id="ib-confirm" placeholder="Type ' + escHtml(ib.address) + ' to confirm">' +
    '<button class="btn btn-danger" onclick="removeInbox(' + id + ')">Remove</button></div></div>';

  const pauseBtn = ib.paused_reason
    ? '<button class="btn btn-primary" onclick="inboxAction(' + id + ',\'resume\')">Resume sending</button>'
    : '<button class="btn btn-secondary" onclick="inboxAction(' + id + ',\'pause\')"' + (ib.state === 'not_connected' ? ' disabled' : '') + '>Pause</button>';
  inboxDialog(inboxDialogHead(escHtml(ib.address), inboxBadge(ib) + ' ' + escHtml(ib.name || '')) +
    '<div class="modal-body">' + body + '</div>' +
    '<div class="modal-foot"><button class="btn btn-ghost" onclick="testInbox(' + id + ')">Check connection</button>' + pauseBtn + '</div>');
}

async function inboxPost(path, body, done, keepOpen) {
  const r = await api(path, {method: 'POST', headers: {'Content-Type': 'application/json'},
                             body: JSON.stringify(body || {})});
  if (r && r.success) {
    if (done) showToast(done, 'success');
    if (!keepOpen) closeInboxDialog();
    loadInboxes();
  } else showToast((r && r.message) || 'That didn\'t work.', 'error');
  return r;
}

function inboxAction(id, action) {
  inboxPost('/api/inboxes/' + encodeURIComponent(id) + '/' + action, {},
            action === 'pause' ? 'Inbox paused' : 'Inbox sends again');
}

function saveInboxCap(id) {
  const v = document.getElementById('ib-cap').value.trim();
  inboxPost('/api/inboxes/' + encodeURIComponent(id) + '/cap', {cap: v === '' ? null : Number(v)}, 'Cap saved');
}

function saveInboxName(id) {
  inboxPost('/api/inboxes/' + encodeURIComponent(id) + '/name',
            {name: document.getElementById('ib-name').value.trim()}, 'Name saved');
}

function removeInbox(id) {
  inboxPost('/api/inboxes/' + encodeURIComponent(id) + '/remove',
            {confirm: document.getElementById('ib-confirm').value.trim().toLowerCase()}, 'Inbox removed');
}

async function testInbox(id) {
  showToast('Checking the connection...', 'info');
  const r = await api('/api/inboxes/' + encodeURIComponent(id) + '/test', {method: 'POST'});
  if (r && r.success) showToast(r.detail || (r.ok ? 'Connected' : 'Not connected'), r.ok ? 'success' : 'error');
  else showToast((r && r.message) || 'Couldn\'t check it.', 'error');
}

// Adding an inbox

let _addKind = 'gmail';

function openAddInbox(kind) {
  if (kind) _addKind = kind;
  const can = (_inboxes && _inboxes.can_connect) || {};
  const picks = Object.keys(INBOX_KINDS).map(k =>
    '<button class="provider-pick' + (k === _addKind ? ' on' : '') + '" onclick="openAddInbox(\'' + k + '\')" aria-pressed="' + (k === _addKind) + '">' +
    '<b>' + INBOX_KINDS[k][0] + '</b><span>' + INBOX_KINDS[k][1] + '</span></button>').join('');
  let form = '<div class="form-group"><label class="form-label" for="add-address">Email address</label>' +
    '<input class="form-input" id="add-address" type="email" autocomplete="off" placeholder="you@yourdomain.com" oninput="updateAddCommand()"></div>' +
    '<div class="form-row"><div class="form-group"><label class="form-label" for="add-name">Sender name <span class="optional-tag">optional</span></label>' +
    '<input class="form-input" id="add-name" maxlength="100" placeholder="Your persona name"></div>' +
    '<div class="form-group"><label class="form-label" for="add-warmup">Warming up since <span class="optional-tag">optional</span></label>' +
    '<input class="form-input" id="add-warmup" type="date"></div></div>' +
    '<div class="form-hint" style="margin:-8px 0 16px">Leave the date empty if this inbox has been sending normally for a while.</div>';
  let note = '';
  if (_addKind === 'smtp') {
    form += '<div class="form-row"><div class="form-group"><label class="form-label" for="add-host">SMTP server</label>' +
      '<input class="form-input" id="add-host" placeholder="smtp.yourhost.com"></div>' +
      '<div class="form-group" style="max-width:110px"><label class="form-label" for="add-port">Port</label>' +
      '<input class="form-input" id="add-port" type="number" value="587"></div></div>' +
      '<div class="form-group"><label class="form-label" for="add-password">Password or app password</label>' +
      '<input class="form-input" id="add-password" type="password" autocomplete="new-password"></div>' +
      '<details class="more-fields"><summary>Username and IMAP (for reading replies)</summary>' +
      '<div class="form-group"><label class="form-label" for="add-user">Username</label><input class="form-input" id="add-user" placeholder="Same as the address"></div>' +
      '<div class="form-row"><div class="form-group"><label class="form-label" for="add-imap">IMAP server</label><input class="form-input" id="add-imap" placeholder="Same as the SMTP server"></div>' +
      '<div class="form-group" style="max-width:110px"><label class="form-label" for="add-imap-port">Port</label><input class="form-input" id="add-imap-port" type="number" value="993"></div></div></details>';
    note = '<p class="form-hint">The password goes straight to your system keychain. Sellbird never shows it again.</p>';
  } else if (!can[_addKind]) {
    note = connectSetupNotice(_addKind);
  } else {
    note = '<p class="form-hint">A ' + INBOX_KINDS[_addKind][0] + ' sign-in opens in the browser on the computer running Sellbird. Sign in as the address above.</p>';
  }
  note += '<div class="modal-section"><h4>Or from your terminal</h4><div class="cmd-copy"><code id="add-cmd"></code>' +
    '<button class="btn btn-secondary btn-sm" onclick="copyAddCommand()">Copy</button></div></div>';
  const disabled = _addKind !== 'smtp' && !can[_addKind];
  inboxDialog(inboxDialogHead('Add an inbox', 'Connect an inbox you already own. Sellbird sends from it and reads its replies.') +
    '<div class="modal-body"><div class="provider-picks">' + picks + '</div><div style="height:16px"></div>' +
    '<div id="add-status"></div>' + form + note + '</div>' +
    '<div class="modal-foot"><button class="btn btn-ghost" onclick="closeInboxDialog()">Cancel</button>' +
    '<button class="btn btn-primary" id="add-go" onclick="submitAddInbox()"' + (disabled ? ' disabled' : '') + '>' +
    (_addKind === 'smtp' ? 'Connect' : 'Sign in with ' + (_addKind === 'gmail' ? 'Google' : 'Microsoft')) + '</button></div>');
  updateAddCommand();
}

function updateAddCommand() {
  const el = document.getElementById('add-cmd');
  if (!el) return;
  const addr = (document.getElementById('add-address').value || '').trim() || 'you@yourdomain.com';
  el.textContent = 'sellbird inboxes connect ' + _addKind + ' --address ' + addr +
    (_addKind === 'smtp' ? ' --smtp-host smtp.yourhost.com' : '');
}

function copyAddCommand() {
  const text = document.getElementById('add-cmd').textContent;
  navigator.clipboard.writeText(text).then(() => showToast('Copied', 'success'),
    () => showToast('Couldn\'t copy. Select the command instead.', 'error'));
}

function addStatus(cls, html) {
  const el = document.getElementById('add-status');
  if (el) el.innerHTML = html ? '<div class="notice ' + cls + '">' + html + '</div>' : '';
}

// Where the browser sign-in's own app (Google OAuth client / Microsoft app
// registration) is set up, when it isn't yet or doesn't look real.
const CONNECT_SETUP = {
  gmail: {
    field: 'gmail-id',
    steps: [
      'In <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener noreferrer">Google Cloud Console</a>, pick or create a project and enable the Gmail API.',
      'Under <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Credentials</a>, create an OAuth client ID of type <b>Desktop app</b>.',
      'Paste its Client ID and Client secret in Sending and keys, under Gmail, and save.',
      'Come back here and sign in.',
    ],
  },
  microsoft: {
    field: 'm365-client',
    steps: [
      'In <a href="https://entra.microsoft.com" target="_blank" rel="noopener noreferrer">Entra</a>, go to App registrations and register an app for your organization only.',
      'Add the redirect URI <code>http://localhost:8766</code> as "Public client/native".',
      'Paste the Application (client) ID and tenant ID in Sending and keys, under Microsoft 365, and save.',
      'Come back here and sign in.',
    ],
  },
};

function connectSetupNotice(kind) {
  const setup = CONNECT_SETUP[kind];
  const problem = ((_inboxes && _inboxes.connect_problems) || {})[kind] || '';
  return '<div class="notice info"><b>' + escHtml(problem) + '</b>' +
    '<ol class="setup-steps">' + setup.steps.map(t => '<li>' + t + '</li>').join('') + '</ol>' +
    '<button class="btn btn-secondary btn-sm" onclick="openSettingsAt(\'' + setup.field + '\')">Open Sending and keys</button></div>';
}

function openSettingsAt(fieldId) {
  closeInboxDialog();
  showTab('settings');
  setTimeout(() => {
    const el = document.getElementById(fieldId);
    if (!el) return;
    el.scrollIntoView({behavior: 'smooth', block: 'center'});
    el.focus({preventScroll: true});
  }, 300);
}

async function connectMainMailbox(kind) {
  const go = document.getElementById('main-go');
  if (go) go.disabled = true;
  const status = document.getElementById('main-status');
  const say = (cls, html) => { if (status) status.innerHTML = '<div class="notice ' + cls + '">' + html + '</div>'; };
  say('info', 'Opening the sign-in...');
  const r = await api('/api/inboxes/main/connect', {method: 'POST'});
  if (!r || !r.success) {
    if (go) go.disabled = false;
    say('bad', escHtml((r && r.message) || 'That didn\'t work.'));
    return;
  }
  say('wait', 'A ' + (kind === 'gmail' ? 'Google' : 'Microsoft') + ' sign-in opened in your browser. ' +
    'Sign in as your sending address and allow access. This page updates when you\'re done.');
  if (_inboxPoll) clearInterval(_inboxPoll);
  _inboxPoll = setInterval(async () => {
    const s = await api('/api/inboxes/connect/status');
    if (!s || s.state === 'waiting') return;
    clearInterval(_inboxPoll); _inboxPoll = null;
    if (s.state === 'connected') {
      showToast('Main mailbox connected', 'success');
      closeInboxDialog(); loadInboxes();
    } else {
      if (go) go.disabled = false;
      say('bad', escHtml(s.message || 'The sign-in didn\'t finish.'));
    }
  }, 1500);
}

async function submitAddInbox() {
  const v = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const body = {address: v('add-address'), name: v('add-name'), warmup_started: v('add-warmup')};
  const go = document.getElementById('add-go');
  if (_addKind === 'smtp') {
    Object.assign(body, {smtp_host: v('add-host'), smtp_port: Number(v('add-port') || 587),
      password: document.getElementById('add-password').value, username: v('add-user'),
      imap_host: v('add-imap'), imap_port: Number(v('add-imap-port') || 993)});
  }
  go.disabled = true;
  addStatus('info', _addKind === 'smtp' ? 'Connecting and checking the sign-in...' : 'Opening the sign-in...');
  const r = await api('/api/inboxes/connect/' + _addKind, {method: 'POST',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  if (!r || !r.success) {
    go.disabled = false;
    addStatus('bad', escHtml((r && r.message) || 'That didn\'t work.'));
    return;
  }
  if (_addKind === 'smtp') {
    showToast('Connected ' + r.address, 'success');
    if (!r.test_ok) showToast('It\'s connected, but the check failed: ' + (r.test_detail || ''), 'error');
    closeInboxDialog(); loadInboxes();
    return;
  }
  addStatus('wait', 'A ' + (_addKind === 'gmail' ? 'Google' : 'Microsoft') + ' sign-in opened in your browser. ' +
    'Sign in as <b>' + escHtml(body.address.toLowerCase()) + '</b> and allow access. This page updates when you\'re done.');
  _inboxPoll = setInterval(async () => {
    const s = await api('/api/inboxes/connect/status');
    if (!s || s.state === 'waiting') return;
    clearInterval(_inboxPoll); _inboxPoll = null;
    if (s.state === 'connected') {
      showToast('Connected ' + s.address, 'success');
      if (s.message) showToast('It\'s connected, but the check failed: ' + s.message, 'error');
      closeInboxDialog(); loadInboxes();
    } else {
      go.disabled = false;
      addStatus('bad', escHtml(s.message || 'The sign-in didn\'t finish.'));
    }
  }, 1500);
}

async function loadActivity() {
  const el = document.getElementById('activity-list');
  const data = await api('/api/activity');
  if (!data) { el.innerHTML = offlineState(); return; }
  if (!data.length) {
    el.innerHTML = emptyState(icon('activity'), 'No activity yet',
      'Sellbird hasn\'t taken any actions. Every prospect found, email written, and reply handled will appear here the moment it happens.');
    return;
  }
  let html = '<div class="card"><div class="timeline">';
  let day = '';
  for (const a of data) {
    const label = dayLabel(a.created_at);
    if (label !== day) { day = label; html += '<div class="tl-day">' + escHtml(label) + '</div>'; }
    html += '<div class="tl-item' + (a.agent === 'main' ? ' quiet' : '') + '"><span class="tl-time">' + timeOfDay(a.created_at) + '</span>' +
      '<span class="tl-icon">' + icon(own(AGENT_ICONS, a.agent) || 'activity') + '</span>' +
      '<span class="tl-text">' + actionText(a) + '</span>' +
      '<span class="tl-agent">' + escHtml(a.agent) + '</span></div>';
  }
  el.innerHTML = html + '</div></div>';
}

// ── Calendar: what goes out, day by day ──
//
// The Outbox holds every email with the time it is due. This lays a week of
// it out by day: what is approved and scheduled, what still waits for you,
// what went. The engine records that a meeting was agreed, not its time, so
// meetings are a list under the week, not blocks inside it.

let _calOffset = 0;   // weeks from today

function calStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 7 * _calOffset);   // today first: what goes out next
  return d;
}

function isoDay(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function calMove(n) { _calOffset = n === 0 ? 0 : _calOffset + n; loadCalendar(); }

async function loadCalendar() {
  const el = document.getElementById('calendar-body');
  if (!el) return;
  const start = calStart();
  const data = await api('/api/calendar?start=' + isoDay(start) + '&days=7&tz=' + -new Date().getTimezoneOffset());
  if (!data) { el.innerHTML = offlineState(); return; }
  if (data.error) { el.innerHTML = emptyState(icon('alert'), 'Couldn\'t read the calendar', escHtml(data.error)); return; }
  el.innerHTML = calendarHtml(data, isoDay(new Date()));
  const meetings = (data.meetings || []).length;
  const scheduled = (data.days || []).reduce((n, d) => n + (d.scheduled || 0), 0);
  const waiting = (data.days || []).reduce((n, d) => n + (d.waiting || 0), 0);
  setAnswer('calendar', toneBadge('info', plural(meetings, 'meeting', 'meetings')),
    (meetings ? plural(meetings, 'meeting', 'meetings') + ' this week' : 'No meetings this week') +
    (scheduled ? ', and ' + plural(scheduled, 'email goes', 'emails go') + ' out on schedule.' : '.') +
    (waiting ? ' ' + plural(waiting, 'email waits', 'emails wait') + ' for your OK first.' : ''), 'Calendar');
}

function calendarHtml(data, today) {
  const n = (v, one, many) => v + ' ' + (v === 1 ? one : many);
  const clock = t => t ? timeOfDay(t) : '';
  const days = data.days || [];
  const fmt = iso => new Date(iso + 'T00:00:00');
  const range = days.length
    ? fmt(days[0].date).toLocaleDateString('en-US', {month: 'short', day: 'numeric'}) + ' to ' +
      fmt(days[days.length - 1].date).toLocaleDateString('en-US', {month: 'short', day: 'numeric'})
    : '';
  const week = days.map(d => {
    const dt = fmt(d.date);
    const evs = [];
    if (d.waiting) evs.push('<button type="button" class="ev wait" onclick="goTab(\'outbox\')">' +
      '<span class="time">' + (clock(d.first_waiting) || 'Held') + '</span>' +
      '<span class="t">' + n(d.waiting, 'email', 'emails') + '</span>' +
      '<span class="s">Waiting for your approval</span></button>');
    if (d.scheduled) evs.push('<button type="button" class="ev" onclick="goTab(\'outbox\')">' +
      '<span class="time">' + (clock(d.first_scheduled) ? 'From ' + clock(d.first_scheduled) : 'Scheduled') + '</span>' +
      '<span class="t">' + n(d.scheduled, 'email', 'emails') + '</span>' +
      '<span class="s">Approved and scheduled</span></button>');
    if (d.sent) evs.push('<button type="button" class="ev sent" onclick="goTab(\'outbox\')">' +
      '<span class="time">Sent</span>' +
      '<span class="t">' + n(d.sent, 'email', 'emails') + '</span>' +
      '<span class="s">' + (d.replies ? n(d.replies, 'reply', 'replies') + ' that day' : 'Went out') + '</span></button>');
    else if (d.replies) evs.push('<button type="button" class="ev sent" onclick="goTab(\'conversations\')">' +
      '<span class="time">Replies</span><span class="t">' + n(d.replies, 'reply', 'replies') + '</span>' +
      '<span class="s">New conversations</span></button>');
    (data.meetings || []).filter(m => m.day === d.date).forEach(m => evs.unshift(
      '<button type="button" class="ev meet" onclick="goTab(\'prospects\')">' +
      '<span class="time">' + clock(m.starts_at) + '</span>' +
      '<span class="t">' + (escHtml([m.first_name, m.last_name].filter(Boolean).join(' ')) || escHtml(m.email)) + '</span>' +
      '<span class="s">Meeting' + (m.company ? ', ' + escHtml(m.company) : '') + '</span></button>'));
    const cls = d.date === today ? ' today' : d.date < today ? ' past' : '';
    return '<div class="day' + cls + '"><div class="day-h"><b>' +
      dt.toLocaleDateString('en-US', {weekday: 'short'}) + ' ' + dt.getDate() + '</b><span>' +
      (d.date === today ? 'Today' : '') + '</span></div>' +
      (evs.join('') || '<p class="day-none">Nothing ' + (d.date < today ? 'went out' : 'scheduled') + '</p>') + '</div>';
  }).join('');
  const meetings = data.meetings || [];
  const meetRows = meetings.length
    ? meetings.map(m => '<div class="row"><span class="who" aria-hidden="true">' + initials(m.first_name, m.last_name) + '</span>' +
        '<div class="grow"><p class="t">' + (escHtml([m.first_name, m.last_name].filter(Boolean).join(' ')) || escHtml(m.email)) + '</p>' +
        '<p class="s">' + escHtml([m.title, m.company].filter(Boolean).join(', ')) + '</p></div>' +
        '<span class="time">' + (m.starts_at ? escHtml(formatDate(m.starts_at)) : 'Booked ' + relTime(m.updated_at)) + '</span>' +
        '<span class="tag good">' + (m.starts_at ? 'Meeting' : 'Booked, no time given') + '</span>' +
        '<button class="btn btn-secondary btn-sm rowbtn" onclick="goTab(\'prospects\')">Open</button></div>').join('')
    : '<div class="row"><div class="grow"><p class="t">No meetings booked yet</p>' +
      '<p class="s">When someone books, mark it on People or let your agent record it. Their follow-ups stop.</p></div></div>';
  const link = safeHref(data.booking_url);
  const linkRow = '<div class="row"><div class="grow"><p class="t">Your booking link</p><p class="s">' +
    (link ? '<a href="' + link + '" target="_blank" rel="noopener noreferrer">' + escHtml(data.booking_url) + '</a>. ' +
            'Replies to interested people offer it.'
          : 'None set. Add <code>product.offer.booking_url</code> to sellbird.yaml and replies will offer it.') +
    '</p></div></div>';
  return (data.paused ? '<div class="banner bad">' + icon('alert') + '<div><b>Sending is paused</b><p>' +
      escHtml(data.paused) + '. Scheduled mail stays queued until you resume it in the Outbox.</p></div></div>' : '') +
    '<div class="cal-bar"><b>' + escHtml(range) + '</b>' +
      '<button class="btn btn-secondary btn-sm" onclick="calMove(-1)">Earlier</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="calMove(0)"' + (_calOffset === 0 ? ' disabled' : '') + '>Today</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="calMove(1)">Later</button></div>' +
    '<div class="week">' + week + '</div>' +
    '<div class="keyrow"><span><i class="dot" style="background:var(--wait)"></i>Waiting for you</span>' +
      '<span><i class="dot d1"></i>Scheduled</span><span><i class="dot" style="background:var(--good)"></i>Sent</span>' +
      '<span><i class="dot d4"></i>Meeting</span></div>' +
    '<div class="secs" style="margin-top:24px"><section class="sec"><h2>Meetings booked</h2><div class="w">' + meetRows +
      '<p class="w-f">A booking stops that person\'s follow-ups. The meeting itself lives on your own calendar.</p></div></section>' +
      '<section class="sec"><h2>Booking</h2><div class="w">' + linkRow + '</div></section></div>';
}

// ── Numbers: what the work brought in ──

let _numbersWeeks = 6;
function setNumbersWeeks(n) { _numbersWeeks = n; loadNumbers(); }

// Daily counts folded into whole weeks, oldest first, the last one ending today.
function weekly(days, values, weeks) {
  const out = [];
  for (let w = 0; w < weeks; w++) {
    const end = days.length - 7 * (weeks - 1 - w);
    const slice = (values || []).slice(Math.max(0, end - 7), end);
    const first = days[Math.max(0, end - 7)];
    out.push({total: slice.reduce((x, y) => x + (Number(y) || 0), 0), label: first ? first.slice(5).replace('-', '/') : ''});
  }
  return out;
}

function columnChart(title, series) {
  const max = Math.max(...series.map(s => s.total), 1);
  return '<div class="w chartbox"><div class="w-h"><h3>' + title + '</h3></div>' +
    '<div class="chart" role="img" aria-label="' + title + ': ' + series.map(s => s.total).join(', ') + '">' +
    series.map(s => '<div class="col2"><span class="tot">' + s.total + '</span>' +
      '<div class="stack' + (s.total ? '' : ' zero') + '" style="--h:' + (s.total / max).toFixed(3) + '"></div>' +
      '<span class="lab">' + escHtml(s.label) + '</span></div>').join('') + '</div></div>';
}

async function loadNumbers() {
  const el = document.getElementById('numbers-body');
  if (!el) return;
  const weeks = _numbersWeeks;
  const [trend, stats, campaigns, inboxes, pipe] = await Promise.all([
    api('/api/trend?days=' + weeks * 7 + '&tz=' + -new Date().getTimezoneOffset()),
    api('/api/stats'), api('/api/campaigns'), api('/api/inboxes'), api('/api/pipeline'),
  ]);
  if (!trend || !Array.isArray(trend.days)) { el.innerHTML = offlineState(); return; }
  if (pipe && !pipe.error) _pipeline = pipe;
  el.innerHTML = numbersHtml(weeks, trend, stats, campaigns, inboxes);
  const sum = a => (a || []).reduce((x, y) => x + (Number(y) || 0), 0);
  const sent = sum(trend.sent), replies = sum(trend.replies);
  setAnswer('numbers', sent ? toneBadge('info', (100 * replies / sent).toFixed(1) + '% reply rate') : toneBadge('', 'Nothing sent yet'),
    sent ? plural(replies, 'reply', 'replies') + ' from ' + plural(sent, 'email', 'emails') + ' in the last ' + weeks + ' weeks.'
         : 'Nothing has gone out in the last ' + weeks + ' weeks, so there is nothing to measure yet.', 'Numbers');
}

function numbersHtml(weeks, trend, stats, campaigns, inboxes) {
  const sum = a => (a || []).reduce((x, y) => x + (Number(y) || 0), 0);
  const found = sum(trend.found), sent = sum(trend.sent), replies = sum(trend.replies);
  const pipe = (stats && stats.pipeline) || {};
  const stat = (label, value, note) => '<div class="stat"><span>' + label + '</span>' +
    '<div class="stat-main"><b class="v' + (value ? '' : ' zero') + '">' + value + '</b></div><span>' + note + '</span></div>';
  const rate = sent ? (100 * replies / sent).toFixed(1) + '%' : 0;
  let html = '<div class="chips" style="margin-bottom:18px" role="group" aria-label="Period">' +
    [[2, 'Last 2 weeks'], [6, 'Last 6 weeks'], [12, 'Last 12 weeks']].map(c =>
      '<button type="button" class="chip-btn' + (c[0] === weeks ? ' on' : '') + '" aria-pressed="' + (c[0] === weeks) +
      '" onclick="setNumbersWeeks(' + c[0] + ')">' + c[1] + '</button>').join('') + '</div>' +
    '<div class="stats">' +
      stat('People found', found, 'in ' + weeks + ' weeks') +
      stat('Emails sent', sent, 'approved and sent') +
      stat('Replies', replies, 'new conversations') +
      stat('Reply rate', rate, sent ? 'replies per email sent' : 'nothing sent yet') +
      stat('Meetings booked', ((_pipeline && _pipeline.stages) || {}).meeting_booked || 0, 'right now') +
    '</div>';

  const total = (stats && stats.prospects && stats.prospects.total) || 0;
  const camps = Array.isArray(campaigns) ? campaigns : [];
  const campRows = camps.map(c => {
    const rs = c.recipients || [];
    const replied = rs.filter(r => ['replied', 'interested', 'meeting', 'accepted_offer'].includes(r.status)).length;
    const reached = rs.filter(r => r.status !== 'new' && r.status !== 'queued').length;
    const pct = reached ? Math.round(1000 * replied / reached) / 10 : 0;
    return '<div class="row"><div class="grow"><p class="t">' + escHtml(c.name || 'Untitled campaign') + '</p>' +
      '<p class="s">' + rs.length + (rs.length === 1 ? ' person, ' : ' people, ') + reached + ' emailed, ' +
      replied + (replied === 1 ? ' reply' : ' replies') + '</p></div>' +
      '<div class="hbar"><i style="width:' + Math.min(100, pct * 4) + '%"></i></div>' +
      '<span class="tag' + (pct >= 5 ? ' good' : '') + '">' + pct + '%</span></div>';
  }).join('');
  const byStage = (_pipeline && _pipeline.stages) || {};
  const stages = Object.keys(stageNames()).map(k => [escHtml(stageNames()[k]), byStage[k] || 0]);
  const bySource = (_pipeline && _pipeline.sources) || {};
  const sourceRows = Object.keys(bySource).sort((a, b) => bySource[b] - bySource[a]).map(k =>
    '<div class="row"><div class="grow"><p class="t">' + escHtml(sourceName(k)) + '</p></div>' +
    '<div class="hbar"><i style="width:' + (total ? Math.round(100 * bySource[k] / total) : 0) + '%"></i></div>' +
    '<span class="tag">' + bySource[k] + '</span></div>').join('');
  const stageRows = stages.map(s => '<div class="row"><div class="grow"><p class="t">' + s[0] + '</p></div>' +
    '<div class="hbar"><i style="width:' + (total ? Math.round(100 * (s[1] || 0) / total) : 0) + '%"></i></div>' +
    '<span class="tag">' + (s[1] || 0) + '</span></div>').join('');
  const boxes = (inboxes && inboxes.native && inboxes.inboxes) || [];
  const boxRows = boxes.map(ib => {
    const cap = Math.max(1, Number(ib.cold_cap) || 0), n = Number(ib.cold_sent_today) || 0;
    return '<div class="row"><div class="grow"><p class="t">' + escHtml(ib.address || 'Main mailbox') + '</p>' +
      '<p class="s">' + n + ' of ' + Number(ib.cold_cap) + ' cold emails today</p></div>' +
      '<div class="hbar"><i style="width:' + Math.min(100, Math.round(100 * n / cap)) + '%"></i></div>' + inboxBadge(ib) + '</div>';
  }).join('');

  html += '<div class="secs">' +
    '<section class="sec"><h2>Each week</h2>' + columnChart('Emails sent each week', weekly(trend.days, trend.sent, weeks)) + '</section>' +
    '<section class="sec"><h2>&nbsp;</h2>' + columnChart('Replies each week', weekly(trend.days, trend.replies, weeks)) + '</section>' +
    '<section class="sec"><h2>By campaign</h2><div class="w">' +
      (campRows || '<div class="row"><div class="grow"><p class="t">No campaigns yet</p>' +
        '<p class="s">Reply share shows here once a campaign has gone out.</p></div></div>') +
      '<p class="w-f">Share of people emailed who replied.</p></div></section>' +
    '<section class="sec"><h2>Where people stand</h2><div class="w">' + stageRows +
      '<p class="w-f">' + total + (total === 1 ? ' person' : ' people') + ' in all.</p></div></section>' +
    (sourceRows ? '<section class="sec"><h2>By source</h2><div class="w">' + sourceRows +
      '<p class="w-f">Where each person came from.</p></div></section>' : '') +
    (boxRows ? '<section class="sec"><h2>By inbox, today</h2><div class="w">' + boxRows + '</div></section>' : '') +
    '</div>' +
    '<p class="ask">Ask your coding agent: <b>"Which Sellbird campaign has the best reply rate, and why?"</b></p>';
  return html;
}

// ── Set up: everything built and connected, one row each ──

// ── Everything Sellbird does: every part of the suite with its state ──

let _suite = null;
const SUITE_BUTTON = {on: 'Open', set: 'Set up', off: 'Turn on'};

async function loadSuite() {
  const el = document.getElementById('suite-body');
  if (!el) return;
  const d = await api('/api/suite');
  if (!d) { el.innerHTML = offlineState(); return; }
  if (d.error) { el.innerHTML = emptyState(icon('alert'), 'Couldn\'t read the suite', escHtml(d.error)); return; }
  _suite = d;
  const pct = d.total ? Math.round(100 * d.on / d.total) : 0;
  const tone = {on: 'good', set: 'wait', off: '', hosted: ''};
  el.innerHTML = '<div class="tally"><b>' + d.on + ' of ' + d.total + ' on</b>' +
      '<div class="bar" aria-hidden="true"><span style="width:' + pct + '%;background:var(--accent)"></span></div></div>' +
    '<div class="suite">' + d.groups.map(g =>
      '<section class="suite-g"><h2>' + escHtml(g.name) + '</h2><div class="suite-cards">' + g.parts.map(f =>
        '<div class="sc"><div class="sc-top"><b>' + escHtml(f.name) + '</b><span class="tag ' + tone[f.state] + '">' +
          escHtml(f.label) + '</span></div><p>' + escHtml(f.what) + '</p>' +
          (f.detail ? '<p class="sc-detail">' + escHtml(f.detail) + '</p>' : '') +
          (f.screen ? '<div class="sc-acts"><button type="button" class="btn btn-sm ' + (f.state === 'set' ? 'btn-primary' : 'btn-secondary') +
            '" onclick="goTab(' + jsq(f.screen) + ')">' + SUITE_BUTTON[f.state] + '</button>' +
            (f.state !== 'on' ? '<span class="sc-hint">or ask your agent</span>' : '') + '</div>' : '') +
        '</div>').join('') + '</div></section>').join('') + '</div>' +
    '<p class="ask">Phone line and hosted forms need an address the internet can reach, so they are in hosted Sellbird only. ' +
    'Ask your agent: <b>"What is left to switch on in Sellbird?"</b></p>';
}

async function loadTodaySuite() {
  const sec = document.getElementById('today-suite-sec');
  const el = document.getElementById('today-suite');
  if (!sec || !el) return;
  const d = await api('/api/suite');
  if (!d || d.error || !d.total) { sec.hidden = true; return; }
  _suite = d;
  const waiting = d.groups.flatMap(g => g.parts).filter(f => f.state === 'set').map(f => f.name);
  sec.hidden = false;
  el.innerHTML = linkRow('suite', '<span class="who" aria-hidden="true">' + icon('sparkle') + '</span><div class="grow">' +
    '<p class="t">' + d.on + ' of ' + d.total + ' parts on</p><p class="s">' +
    (waiting.length ? escHtml(waiting.slice(0, 3).join(', ')) + (waiting.length > 3 ? ' and more' : '') + ' waiting to be set up'
      : 'Everything you can run here is set up') + '</p></div>', 'See everything Sellbird does');
}

async function loadSetup() {
  const el = document.getElementById('setup-body');
  if (!el) return;
  const [today, engine, mode, setup, suite] = await Promise.all([
    api('/api/today'), api('/api/sellbird/status'), api('/api/sending-mode'), api('/api/setup-status'), api('/api/suite'),
  ]);
  _suite = suite;
  if (!today && !engine) { el.innerHTML = offlineState(); return; }
  if (today && !today.error) { applyCounts(today); _todayStats = today.stats || {}; }
  el.innerHTML = setupHtml(_todayStats, engine, mode, setup);
  applyTheme(currentTheme());
  if (!_report) await loadAgentReport();
  const left = setup && setup.checks ? setup.checks.filter(c => c.required && !c.done).length : 0;
  const chip = _report ? _report.chip : '';
  setAnswer('setup', left ? toneBadge('warn', left + ' left to set up')
      : toneBadge(chip === 'working' || chip === 'connected' ? 'good' : '', chip === 'working' || chip === 'connected' ? 'Connected to ' + agentName() : 'Ready'),
    'Sellbird thinks with ' + agentWho() + '. ' + (left ? plural(left, 'step is', 'steps are') + ' left before it can send.'
      : 'Everything below is what it can do for you, and what is on.'), 'Set up');
}

function setupHtml(st, engine, mode, setup) {
  st = st || {};
  const row = (to, title, sub, tag, tone) => '<button type="button" class="row link" onclick="goTab(' + jsq(to) + ')">' +
    '<span class="who" aria-hidden="true">' + icon(SETUP_ICONS[to] || 'settings') + '</span>' +
    '<div class="grow"><p class="t">' + title + '</p><p class="s">' + sub + '</p>' +
    (tag ? '<span class="tag ' + (tone || '') + '">' + tag + '</span>' : '') + '</div>' + icon('chevron', 'chev') + '</button>';
  const left = setup && setup.checks ? setup.checks.filter(c => c.required && !c.done).length : 0;
  const auto = mode && mode.mode === 'autopilot';
  const running = !!(engine && engine.running);
  const suite = _suite && !_suite.error ? _suite : null;
  return '<div class="secs">' +
    '<section class="sec span"><h2>Everything Sellbird does</h2><div class="w">' +
      row('suite', suite ? suite.on + ' of ' + suite.total + ' parts of the suite on' : 'Every part of the suite',
          'See every feature, what it does and what is left to switch on',
          suite && suite.total > suite.on ? (suite.total - suite.on) + ' to go' : '', 'wait') +
    '</div></section>' +
    '<section class="sec"><h2>Your business</h2><div class="w">' +
      row('company', 'Your company', 'What you sell, who you sell to, and the offer every first email ends with', '', '') +
      row('inboxes', 'Inboxes', 'The addresses Sellbird sends from, and how much each has sent today', '', '') +
      row('records', 'Email records', 'SPF, DKIM, DMARC and MX on each domain you send from, and what to fix', '', '') +
    '</div></section>' +
    '<section class="sec"><h2>Sending and the engine</h2><div class="w">' +
      row('settings', 'Sending and keys', 'Approval or autopilot, your email provider, and the keys for checking addresses',
          left ? left + ' to finish' : mode ? (auto ? 'Autopilot' : 'Approval') : '', left || auto ? 'wait' : 'good') +
      row('limits', 'Limits and rules', 'The stop button, daily limits, quiet hours, and anything that sends without you', '', '') +
      row('neveremail', 'Opt-outs and bounces', 'Everyone Sellbird will never email again, and why', '', '') +
      row('texting', 'Texting and consent', 'Your own Twilio number, who said yes to texts and calls, and who must never be contacted', '', '') +
      row('controls', 'Engine', 'Start and stop the loop that finds, writes and sends, and read its log',
          engine ? (running ? 'Running' : 'Stopped') : '', running ? 'good' : '') +
    '</div></section>' +
    '<section class="sec"><h2>Connections and records</h2><div class="w">' +
      row('agent', 'Your agent', 'What your coding agent may do, everything it did, and the switch that cuts it off', '', '') +
      row('events', 'Events and webhooks', 'Send every reply, new lead, booking and stage change to the tools you already use', '', '') +
      row('activity', 'Activity', 'Every action Sellbird took, newest first', '', '') +
      row('help', 'Help', 'How it works, where files live, and fixes for the usual problems', '', '') +
    '</div></section>' +
    '<section class="sec"><h2>This dashboard</h2><div class="w">' +
      '<div class="row"><div class="grow"><p class="t">Appearance</p><p class="s">Match your computer, or pick light or dark</p></div>' +
      '<div class="theme-switch" role="group" aria-label="Appearance">' +
        [['auto', 'Match your computer', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']].map(t =>
          '<button type="button" data-theme-opt="' + t[0] + '" onclick="setTheme(\'' + t[0] + '\')" title="' + t[1] +
          '" aria-label="' + t[1] + '">' + icon(t[2]) + '</button>').join('') + '</div></div>' +
      '<div class="row"><div class="grow"><a class="follow-link" href="https://x.com/sellbirdagent" target="_blank" rel="noopener" ' +
        'title="News and updates on X">' + icon('x') + '<span>Follow @sellbirdagent for releases and the roadmap</span></a></div></div>' +
    '</div></section>' +
    '<section class="sec"><h2>What your agent can\'t do</h2><div class="cant">' +
      ['Approve or send an email, a reply or a text', 'Buy anything or start a paid search', 'Turn sending back on, or turn on autopilot',
       'Let itself back in after you cut it off'].map(x => '<div>' + LOCK_SVG + '<span>' + x + '</span></div>').join('') +
      '<p>Those stay your clicks, here. <a href="#agent" onclick="goTab(\'agent\');return false">Everything it may do</a></p></div></section>' +
    '</div>' +
    '<p class="ask">Your coding agent can do most of this for you. Ask it: <b>"Check my Sellbird setup and tell me what is left."</b></p>';
}

const SETUP_ICONS = {company: 'company', campaigns: 'campaigns', signals: 'signals', discover: 'discover',
                     inboxes: 'inboxes', settings: 'settings', controls: 'controls', activity: 'activity', help: 'help',
                     events: 'arrow', suite: 'sparkle', texting: 'message', records: 'check', neveremail: 'flag',
                     limits: 'alert', agent: 'sparkle'};

// ── Leads: people who came to you ──

const LEAD_VIA = {form_email: 'From a form email', agent: 'Added by your agent', cli: 'Added on the command line', you: 'Added by you'};
const LEAD_SOURCE = {form: 'Form', call: 'Call', text: 'Text', mention: 'Mention', referral: 'Referral', other: 'Other'};

function leadWho(l) {
  return escHtml(l.name || [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || l.phone) || 'Nobody found';
}

// Where a lead's first answer stands: [words, tone].
function leadAnswer(l) {
  if (l.status === 'unreadable') return ['Read it yourself', 'wait'];
  if (l.status === 'held') return ['Held', 'bad'];
  if (l.status === 'dismissed') return ['Set aside', ''];
  if (l.status === 'recorded') return ['Answer where they posted', ''];
  switch (l.answer_status) {
    case 'pending_review': return ['Answer waits for you', 'acc'];
    case 'approved': case 'sending': return ['Answer approved', 'wait'];
    case 'sent': return ['Answered', 'good'];
    case 'rejected': return ['Answer rejected', ''];
    case 'cancelled': return ['Answer cancelled', ''];
  }
  return l.email ? ['No answer yet', 'wait'] : ['No address', ''];
}

function leadRow(l) {
  const a = leadAnswer(l);
  const fields = Object.keys(l.fields || {}).filter(k => l.fields[k] && String(l.fields[k]) !== l.message)
    .map(k => '<p class="s"><b>' + escHtml(k) + '</b> ' + escHtml(l.fields[k]) + '</p>').join('');
  const open = l.status !== 'dismissed' && l.status !== 'held';
  return '<div class="row lead-row"><span class="who" aria-hidden="true">' + icon(l.source === 'form' ? 'pen' : 'message') + '</span>' +
    '<div class="grow"><p class="t">' + leadWho(l) + ' <span class="tag ' + a[1] + '">' + a[0] + '</span></p>' +
      '<p class="s">' + escHtml(LEAD_SOURCE[l.source] || 'Other') + (l.form_name ? ' · ' + escHtml(l.form_name) : '') +
        ' · ' + (LEAD_VIA[l.via] || 'Added') + ' · ' + relTime(l.created_at) +
        (l.email && l.name ? ' · ' + escHtml(l.email) : '') + (l.phone ? ' · ' + escHtml(l.phone) : '') + '</p>' +
      (l.message ? '<div class="tb lead-words">' + escHtml(l.message) + '</div>' : '') +
      (fields ? '<div class="lead-fields">' + fields + '</div>' : '') +
      (l.note ? '<p class="s" style="color:var(--wait)">' + escHtml(l.note) + '</p>' : '') + '</div>' +
    '<div class="row-acts">' +
      (l.answer_status === 'pending_review' ? '<button class="btn btn-primary btn-sm" onclick="goTab(\'outbox\')">Review answer</button>' : '') +
      (l.prospect_id ? '<button class="btn btn-secondary btn-sm" onclick="openPerson(' + jsq(l.prospect_id) + ')">Open person</button>' : '') +
      (open && l.answer_status !== 'sent' ? '<button class="btn btn-ghost btn-sm" onclick="dismissLead(' + jsq(l.id) + ')">Set aside</button>' : '') +
    '</div></div>';
}

async function loadLeads() {
  const el = document.getElementById('leads-body');
  if (!el) return;
  const d = await api('/api/leads');
  if (!d) { el.innerHTML = offlineState(); return; }
  if (d.error) { el.innerHTML = emptyState(icon('alert'), 'Couldn\'t read your leads', escHtml(d.error)); return; }
  navCount('nav-leads', d.needs_you || 0);
  const leads = d.leads || [];
  const waiting = l => (l.status === 'new' || l.status === 'unreadable' || l.status === 'answered') &&
    l.answer_status !== 'sent' && l.answer_status !== 'rejected' && l.answer_status !== 'cancelled';
  const open = leads.filter(waiting), rest = leads.filter(l => !waiting(l));
  const drafted = open.filter(l => l.answer_status === 'pending_review').length;
  setAnswer('leads', open.length ? toneBadge('warn', open.length + ' waiting') : toneBadge('good', 'All answered'),
    open.length
      ? plural(open.length, 'person is', 'people are') + ' waiting for an answer.' +
        (drafted ? ' ' + agentWho() + ' drafted ' + plural(drafted, 'answer', 'answers') + '; each waits for your OK.' : '')
      : 'Nobody is waiting for an answer. A form fill or a lead your agent adds shows up here.',
    'Inbound');
  const file = escHtml(d.config_file || 'sellbird.yaml');
  const r = (t, sub, tag, tone) => '<div class="row"><div class="grow"><p class="t">' + t + '</p><p class="s">' + sub + '</p></div>' +
    (tag ? '<span class="tag ' + (tone || '') + '">' + tag + '</span>' : '') + '</div>';
  const senders = (d.form_senders || []).map(escHtml).join(', ');
  el.innerHTML = '<div class="secs">' +
    '<section class="sec"><h2>Open</h2><div class="w">' +
      (open.map(leadRow).join('') || '<div class="row"><div class="grow"><p class="t">No open leads</p>' +
        '<p class="s">A form fill or a lead your agent adds shows up here, with the answer drafted for it.</p></div></div>') +
      '<p class="w-f">What a lead typed is shown as they typed it. Sellbird never acts on it, and nothing is sent until you approve the answer.</p></div></section>' +
    '<section class="sec"><h2>Add a lead</h2><div class="w pad">' +
      '<div class="form-row"><div class="form-group"><label class="form-label" for="lead-email">Email</label>' +
        '<input class="form-input" id="lead-email" type="email" autocomplete="off" placeholder="pat@example.com"></div>' +
      '<div class="form-group"><label class="form-label" for="lead-name">Name</label>' +
        '<input class="form-input" id="lead-name" autocomplete="off"></div>' +
      '<div class="form-group"><label class="form-label" for="lead-phone">Phone</label>' +
        '<input class="form-input" id="lead-phone" type="tel" autocomplete="off"></div></div>' +
      '<div class="form-group"><label class="form-label" for="lead-message">What they said or asked</label>' +
        '<textarea class="form-input" id="lead-message" rows="3"></textarea></div>' +
      '<div class="form-row"><div class="form-group"><label class="form-label" for="lead-source">Where they came from</label>' +
        '<select class="form-input" id="lead-source">' + Object.keys(LEAD_SOURCE).map(k => '<option value="' + k + '">' + LEAD_SOURCE[k] + '</option>').join('') + '</select></div>' +
      '<button class="btn btn-primary btn-sm" onclick="addLead()">Add lead</button></div>' +
      '<p class="form-hint">An email or a phone is enough. Adding a lead emails nobody: the first answer is drafted and waits in the Outbox.</p></div></section>' +
    '<section class="sec"><h2>How leads arrive</h2><div class="w">' +
      r('Form emails', !d.reads_inbox ? 'Sellbird reads an inbox only with Gmail, Microsoft 365 or SMTP. On Instantly, add leads by hand or through your agent.'
          : 'Your form tool emails you each submission. Send those to an inbox Sellbird reads and each one becomes a lead. ' +
            (senders ? 'Senders you listed: ' + senders + '.' : 'List the address your own site\'s form sends from under <code>inbound.form_senders</code> in ' + file + '.'),
        d.reads_inbox ? 'Checked each cycle' : 'Off', d.reads_inbox ? 'good' : '') +
      r('Form tools Sellbird knows', (d.known_senders || []).map(escHtml).join(', ') + '. Turn off with <code>inbound.known_form_tools: false</code>.',
        d.known_form_tools ? 'On' : 'Off', d.known_form_tools ? 'good' : '') +
      r('Your agent', 'It can add a lead from anywhere it can read, and draft the answer. Ask it: "Add the leads from my quote form."', 'On', 'good') +
      r('First answers', d.draft_answers ? 'Sellbird drafts one on its next cycle, up to ' + (d.max_drafts_per_day || 0) + ' a day. Turn off with <code>inbound.draft_answers: false</code>.'
          : 'Off. Leads are recorded and the answer is left to you or your agent.', d.draft_answers ? 'On' : 'Off', d.draft_answers ? 'good' : '') +
      r('Approval', d.answers_wait_for_approval ? 'A first answer always waits for you, even on autopilot: the address was typed by a stranger.'
          : 'First answers follow your sending mode (<code>inbound.answers_wait_for_approval: false</code>).',
        d.answers_wait_for_approval ? 'Always waits' : 'Sending mode', d.answers_wait_for_approval ? 'acc' : 'wait') +
      '<p class="w-f">Sellbird hosts no forms and needs no public address. It checks in; nothing has to reach it.</p></div></section>' +
    (rest.length ? '<section class="sec"><h2>Earlier</h2><div class="w">' + rest.map(leadRow).join('') + '</div></section>' : '') +
    '</div>';
}

async function addLead() {
  const v = id => document.getElementById(id).value.trim();
  const res = await api('/api/leads', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({email: v('lead-email'), name: v('lead-name'), phone: v('lead-phone'),
                          message: v('lead-message'), source: v('lead-source')})});
  if (res && res.success) showToast(res.message || 'Added.', 'success');
  else showToast(failMsg(res, 'Could not add that lead.'), 'error');
  if (res && res.success) loadLeads();
}

async function dismissLead(id) {
  const res = await api('/api/leads/' + encodeURIComponent(id) + '/dismiss', {method: 'POST'});
  if (res && res.success) showToast('Set aside. No answer will be sent.', 'success');
  else showToast(failMsg(res, 'That did not work.'), 'error');
  loadLeads();
}

// ── Mentions: what people wrote, and what you do with each ──

const MENTION_SOURCE = {hackernews: 'Hacker News', news: 'News', reddit: 'Reddit', youtube: 'YouTube', web: 'Web'};
const MENTION_KIND = {buyer: ['A buyer', 'acc'], complaint: ['A complaint', 'bad'], praise: ['Praise', 'good'],
                      competitor: ['About a competitor', ''], other: ['Other', '']};
const MENTION_HINT = {question: ['Looks like a question', 'acc'], complaint: ['Looks like a complaint', 'wait']};
const MENTION_DONE = {replied: ['You replied', 'good'], lead: ['Now a lead', 'good'], noted: ['Noted', ''], skipped: ['Skipped', '']};
const nWord = (v, one, many) => (Number(v) || 0) + ' ' + ((Number(v) || 0) === 1 ? one : many);
let _mentions = null;
let _mentionOpen = '';     // the mention whose reply or note box is open
let _mentionBox = '';      // 'reply' or 'note'

function mentionRow(m) {
  const tag = m.status !== 'new' ? MENTION_DONE[m.status] : (own(MENTION_KIND, m.kind) || own(MENTION_HINT, m.hint));
  const open = _mentionOpen === m.id;
  const title = escHtml(m.title || (m.body || '').slice(0, 90) || m.url);
  return '<div class="row lead-row"><span class="who" aria-hidden="true">' + icon('signals') + '</span>' +
    '<div class="grow"><p class="t">' + title + (tag ? ' <span class="tag ' + tag[1] + '">' + tag[0] + '</span>' : '') + '</p>' +
      '<p class="s">' + escHtml(MENTION_SOURCE[m.source] || m.source) + (m.author ? ' · ' + escHtml(m.author) : '') +
        ' · watching "' + escHtml(m.term) + '" · found ' + relTime(m.found_at) + '</p>' +
      (m.body ? '<div class="tb lead-words">' + escHtml(m.body.length > 420 ? m.body.slice(0, 420) + '...' : m.body) + '</div>' : '') +
      (m.reply && !(open && _mentionBox === 'reply') ? '<p class="s mention-label">Draft reply, for you to post from your own account' +
        (m.reply_by === 'agent' ? ' · written by your agent' : '') + '</p><div class="tb draft lead-words">' + escHtml(m.reply) + '</div>' : '') +
      (m.note && !(open && _mentionBox === 'note') ? '<p class="s"><b>Note</b> ' + escHtml(m.note) + '</p>' : '') +
      (open ? '<div class="form-group mention-edit"><label class="form-label" for="mention-text">' +
          (_mentionBox === 'reply' ? 'Your reply. Sellbird does not post it: copy it and post it yourself.' : 'A note for yourself') + '</label>' +
        '<textarea class="form-input" id="mention-text" rows="4">' + escHtml(_mentionBox === 'reply' ? m.reply : m.note) + '</textarea></div>' : '') +
    '</div>' +
    '<div class="row-acts">' + (open
      ? '<button class="btn btn-primary btn-sm" onclick="saveMention(' + jsq(m.id) + ')">Save</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="_mentionOpen=\'\';renderMentions()">Cancel</button>'
      : (m.reply ? '<button class="btn btn-primary btn-sm" onclick="copyMentionReply(' + jsq(m.id) + ')">Copy reply</button>' : '') +
        '<a class="btn btn-secondary btn-sm" href="' + safeHref(m.url) + '" target="_blank" rel="noopener noreferrer">Open the post</a>' +
        '<button class="btn btn-secondary btn-sm" onclick="editMention(' + jsq(m.id) + ',\'reply\')">' + (m.reply ? 'Edit reply' : 'Write a reply') + '</button>' +
        (m.prospect_id ? '<button class="btn btn-secondary btn-sm" onclick="openPerson(' + jsq(m.prospect_id) + ')">Open person</button>'
          : (m.source !== 'news' && m.source !== 'web' && m.author ? '<button class="btn btn-secondary btn-sm" onclick="mentionLead(' + jsq(m.id) + ')">Make a lead</button>' : '')) +
        '<button class="btn btn-ghost btn-sm" onclick="editMention(' + jsq(m.id) + ',\'note\')">Note</button>' +
        (m.status === 'new'
          ? (m.reply ? '<button class="btn btn-ghost btn-sm" onclick="mentionStatus(' + jsq(m.id) + ',\'replied\')">I replied</button>' : '') +
            '<button class="btn btn-ghost btn-sm" onclick="mentionStatus(' + jsq(m.id) + ',\'skipped\')">Skip</button>'
          : '<button class="btn btn-ghost btn-sm" onclick="mentionStatus(' + jsq(m.id) + ',\'new\')">Bring back</button>')) +
    '</div></div>';
}

function renderMentions() {
  const el = document.getElementById('mentions-body');
  const d = _mentions;
  if (!el || !d) return;
  const all = d.mentions || [];
  const fresh = all.filter(m => m.status === 'new'), rest = all.filter(m => m.status !== 'new');
  const watching = (d.watches || []).filter(w => w.active).length;
  const empty = !watching
    ? ['Nothing is being watched yet', 'Add your own name first. <button class="btn btn-secondary btn-sm" onclick="goTab(\'mentionsetup\')">Set up brand mentions</button>']
    : ['Nothing new', d.last_check ? 'Last checked ' + relTime(d.last_check) + '. Sellbird looks again every ' + d.check_every_hours + ' hours while it runs.'
        : 'Sellbird has not checked yet. It checks while it runs, or press Check now under What is watched.'];
  el.innerHTML = '<div class="secs">' +
    '<section class="sec"><h2>New</h2><div class="w">' +
      (fresh.map(mentionRow).join('') || '<div class="row"><div class="grow"><p class="t">' + empty[0] + '</p><p class="s">' + empty[1] + '</p></div></div>') +
      '<p class="w-f">Sellbird never posts for you. A reply is a draft: copy it and post it from your own account. What people wrote is shown as written and never acted on.</p></div></section>' +
    (rest.length ? '<section class="sec"><h2>Dealt with</h2><div class="w">' + rest.slice(0, 50).map(mentionRow).join('') + '</div></section>' : '') +
    '</div>' +
    '<p class="ask">Your coding agent can sort these and draft the replies. Ask it: <b>"Go through my new mentions and draft replies for the buyers."</b></p>';
}

async function loadMentions() {
  const el = document.getElementById('mentions-body');
  if (!el) return;
  const d = await api('/api/mentions');
  if (!d) { el.innerHTML = offlineState(); return; }
  if (d.error) { el.innerHTML = emptyState(icon('alert'), 'Couldn\'t read your mentions', escHtml(d.error)); return; }
  _mentions = d;
  navCount('nav-mentions', d.new || 0);
  renderMentions();
}

function editMention(id, box) { _mentionOpen = id; _mentionBox = box; renderMentions(); const t = document.getElementById('mention-text'); if (t) t.focus(); }

async function mentionPost(path, body) {
  return api('/api/mentions/' + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body || {})});
}

async function saveMention(id) {
  const body = {};
  body[_mentionBox] = document.getElementById('mention-text').value;
  const res = await mentionPost(encodeURIComponent(id), body);
  if (res && res.success) { showToast(_mentionBox === 'reply' ? 'Saved. Copy it and post it yourself.' : 'Saved.', 'success'); _mentionOpen = ''; }
  else showToast(failMsg(res, 'Could not save that.'), 'error');
  loadMentions();
}

async function copyMentionReply(id) {
  const m = ((_mentions || {}).mentions || []).find(x => x.id === id);
  if (!m) return;
  try { await navigator.clipboard.writeText(m.reply); showToast('Copied. Open the post and paste it in.', 'success'); }
  catch { showToast('Could not copy. Select the reply and copy it by hand.', 'error'); }
}

async function mentionStatus(id, status) {
  const res = await mentionPost(encodeURIComponent(id) + '/status', {status: status});
  if (!(res && res.success)) showToast(failMsg(res, 'That did not work.'), 'error');
  loadMentions();
}

async function mentionLead(id) {
  const res = await mentionPost(encodeURIComponent(id) + '/lead');
  if (res && res.success) showToast(res.message || 'Added to People.', 'success');
  else showToast(failMsg(res, 'Could not make a lead.'), 'error');
  loadMentions();
}

async function loadMentionSetup() {
  const el = document.getElementById('mentionsetup-body');
  if (!el) return;
  const d = await api('/api/mentions');
  if (!d) { el.innerHTML = offlineState(); return; }
  if (d.error) { el.innerHTML = emptyState(icon('alert'), 'Couldn\'t read brand mentions', escHtml(d.error)); return; }
  _mentions = d;
  const file = escHtml(d.config_file || 'sellbird.yaml');
  const kinds = d.watch_kinds || {};
  const watches = (d.watches || []).map(w =>
    '<div class="row"><div class="grow"><p class="t">' + escHtml(w.term) + '</p><p class="s">' + escHtml(kinds[w.kind] || w.kind) +
      ' · ' + nWord(w.found || 0, 'mention', 'mentions') + ' found' + (w.added_by === 'agent' && !w.active ? ' · proposed by your agent' : '') + '</p></div>' +
    '<span class="tag ' + (w.active ? 'good' : '') + '">' + (w.active ? 'On' : 'Off') + '</span>' +
    '<div class="row-acts"><button class="btn btn-secondary btn-sm" onclick="watchSet(' + jsq(w.id) + ',{active:' + (w.active ? 'false' : 'true') + '})">' +
      (w.active ? 'Turn off' : 'Turn on') + '</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="watchSet(' + jsq(w.id) + ',{remove:true})">Remove</button></div></div>').join('');
  const sources = (d.sources || []).map(s => {
    const state = !s.on ? ['Off', ''] : s.ready ? ['On', 'good'] : ['Needs a key', 'wait'];
    return '<div class="row"><div class="grow"><p class="t">' + escHtml(s.label) + '</p><p class="s">' + escHtml(s.cost) + '.' +
      (s.needs.length ? ' Needs <code>' + s.needs.map(escHtml).join('</code> and <code>') + '</code> in .env.' : '') +
      (!s.on ? ' Add <code>' + escHtml(s.key) + '</code> to <code>mentions.sources</code> in ' + file + ' to use it.' : '') + '</p></div>' +
      '<span class="tag ' + state[1] + '">' + state[0] + '</span></div>';
  }).join('');
  el.innerHTML = (d.last_problems ? '<div class="banner wait mode-banner">' + icon('alert') + '<div><b>The last check had a problem</b><p>' +
      escHtml(d.last_problems) + '. The other sources still ran.</p></div></div>' : '') +
    '<div class="secs">' +
    '<section class="sec"><h2>Watching</h2><div class="w">' +
      (watches || '<div class="row"><div class="grow"><p class="t">Nothing yet</p><p class="s">Start with your own company name. Nothing is searched until a term is on.</p></div></div>') +
      '<p class="w-f">' + (d.last_check ? 'Last checked ' + relTime(d.last_check) + '. ' : '') + 'Checked every ' + d.check_every_hours +
        ' hours while Sellbird runs, for posts from the last ' + d.lookback_days + ' days. Your agent can propose a term. Only you can turn one on.</p></div></section>' +
    '<section class="sec"><h2>Watch something</h2><div class="w pad">' +
      '<div class="form-row"><div class="form-group"><label class="form-label" for="watch-term">A name or a phrase</label>' +
        '<input class="form-input" id="watch-term" autocomplete="off" placeholder="Example Roofing" onkeydown="if (event.key === \'Enter\') addWatch()"></div>' +
      '<div class="form-group"><label class="form-label" for="watch-kind">What it is</label><select class="form-input" id="watch-kind">' +
        Object.keys(kinds).map(k => '<option value="' + escHtml(k) + '">' + escHtml(kinds[k]) + '</option>').join('') + '</select></div>' +
      '<button class="btn btn-primary btn-sm" onclick="addWatch()">Watch</button></div>' +
      '<p class="form-hint">The whole phrase is searched for, so a short and exact one finds more. For buyers, try the question they ask: "roofer recommendation Denver".</p></div></section>' +
    '<section class="sec"><h2>Where Sellbird looks</h2><div class="w">' + sources +
      '<p class="w-f">Sellbird searches and reads. It does not scrape Instagram, TikTok, X, Facebook, LinkedIn or review sites, whose terms forbid it. Web search finds only what a search engine already shows from them.</p></div></section>' +
    '</div>';
}

async function addWatch() {
  const res = await mentionPost('watches', {term: document.getElementById('watch-term').value, kind: document.getElementById('watch-kind').value});
  if (res && res.success) showToast(res.message || 'Watching.', 'success');
  else showToast(failMsg(res, 'Could not watch that.'), 'error');
  loadMentionSetup();
}

async function watchSet(id, body) {
  const res = await mentionPost('watches/' + encodeURIComponent(id), body);
  if (!(res && res.success)) showToast(failMsg(res, 'That did not work.'), 'error');
  loadMentionSetup();
}

async function checkMentions(btn) {
  if (btn) btn.disabled = true;
  showToast('Searching. This can take a minute.', 'success');
  const res = await mentionPost('check');
  if (btn) btn.disabled = false;
  if (res && res.success) showToast(nWord(res.found || 0, 'new mention', 'new mentions') + ' from ' + nWord(res.searches || 0, 'search', 'searches') +
    ((res.problems || []).length ? '. ' + res.problems.join('; ') : '') + '.', (res.problems || []).length ? 'error' : 'success');
  else showToast(failMsg(res, 'The check did not run.'), 'error');
  loadMentionSetup();
}

// ── Social: playbooks, and posts that wait for you ──

let _social = null;
let _socialEdit = '';     // the post whose text is being edited

function socialPost(p, mode) {
  const editing = _socialEdit === p.id;
  const limit = ((_social || {}).limits || {})[p.platform] || 0;
  const acts = mode === 'waiting'
    ? (editing
        ? '<button class="btn btn-primary btn-sm" onclick="socialAct(' + jsq(p.id) + ',\'edit\')">Save</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="_socialEdit=\'\';renderSocial()">Cancel</button>'
        : '<button class="btn btn-primary btn-sm" onclick="socialAct(' + jsq(p.id) + ',\'approve\')">Approve</button>' +
          '<button class="btn btn-secondary btn-sm" onclick="_socialEdit=' + jsq(p.id) + ';renderSocial()">Edit</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="socialAct(' + jsq(p.id) + ',\'skip\')">Skip this one</button>' + onlyYou())
    : mode === 'approved'
      ? '<button class="btn btn-primary btn-sm" onclick="copySocial(' + jsq(p.id) + ')">Copy post</button>' +
        '<button class="btn btn-secondary btn-sm" onclick="socialAct(' + jsq(p.id) + ',\'posted\')">I posted it</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="socialAct(' + jsq(p.id) + ',\'skip\')">Skip</button>'
      : (p.posted_url && safeHref(p.posted_url) ? '<a class="btn btn-secondary btn-sm" href="' + safeHref(p.posted_url) + '" target="_blank" rel="noopener noreferrer">Open the post</a>' : '');
  const tag = mode === 'recent' ? (p.status === 'posted' ? ['Posted', 'good'] : ['Skipped', ''])
    : mode === 'approved' ? ['Approved', 'good'] : ['Needs you', 'wait'];
  return '<div class="row lead-row"><span class="who" aria-hidden="true">' + icon('pen') + '</span>' +
    '<div class="grow"><p class="t">' + escHtml(p.platform_label) + ' <span class="tag ' + tag[1] + '">' + tag[0] + '</span></p>' +
      '<p class="s">From ' + escHtml(p.playbook_name) + (p.drafted_by === 'agent' ? ' · drafted by your agent' : '') +
        ' · ' + relTime(p.posted_at || p.approved_at || p.created_at) + ' · ' + p.body.length + (limit ? ' of ' + limit : '') + ' characters</p>' +
      (editing ? '<div class="form-group mention-edit"><label class="form-label" for="social-text">The post</label>' +
          '<textarea class="form-input" id="social-text" rows="6">' + escHtml(p.body) + '</textarea></div>'
        : '<div class="tb ' + (mode === 'waiting' ? 'draft ' : '') + 'lead-words">' + escHtml(p.body) + '</div>') +
      (p.media_note ? '<p class="s"><b>With it</b> ' + escHtml(p.media_note) + '</p>' : '') + '</div>' +
    (acts ? '<div class="row-acts">' + acts + '</div>' : '') + '</div>';
}

function renderSocial() {
  const el = document.getElementById('social-body');
  const d = _social;
  if (!el || !d) return;
  const books = (d.playbooks || []).map(b =>
    '<div class="row"><div class="grow"><p class="t">' + escHtml(b.name) + '</p><p class="s">' + escHtml(b.summary || '') +
      (b.summary ? '. ' : '') + escHtml(b.platforms.map(p => (d.platforms || {})[p] || p).join(', ')) +
      (b.cadence ? ' · ' + escHtml(b.cadence) : '') + '</p></div>' +
    '<span class="tag ' + (b.active ? 'good' : '') + '">' + (b.active ? 'On' : 'Off') + '</span>' +
    '<button class="btn btn-secondary btn-sm rowbtn" onclick="socialSwitch(' + jsq(b.key) + ',' + (b.active ? 'false' : 'true') + ')">' +
      (b.active ? 'Turn off' : 'Turn on') + '</button></div>').join('');
  const none = (t, s) => '<div class="row"><div class="grow"><p class="t">' + t + '</p><p class="s">' + s + '</p></div></div>';
  el.innerHTML = '<div class="secs">' +
    '<section class="sec"><h2>Waiting for you</h2><div class="w">' +
      ((d.waiting || []).map(p => socialPost(p, 'waiting')).join('') ||
        none('Nothing to approve', 'A post your agent drafts from a playbook that is on shows up here first.')) +
      '<p class="w-f">Your agent can draft a post. Only you can approve one.</p></div></section>' +
    ((d.approved || []).length ? '<section class="sec"><h2>Approved, not posted yet</h2><div class="w">' +
      d.approved.map(p => socialPost(p, 'approved')).join('') +
      '<p class="w-f">Copy it and post it yourself, or ask your agent to post it from the account you connected to it. Sellbird has no way to post.</p></div></section>' : '') +
    '<section class="sec"><h2>Playbooks</h2><div class="w">' +
      (books || none('No playbooks found', 'Sellbird ships five in its skills folder. Yours has none it can read.')) +
      '<p class="w-f">A playbook is a file your agent reads: <code>skills/social_&lt;name&gt;.md</code>. Add your own beside the ones Sellbird ships. Your agent drafts only from the ones that are on.</p></div></section>' +
    ((d.recent || []).length ? '<section class="sec"><h2>Recent</h2><div class="w">' + d.recent.map(p => socialPost(p, 'recent')).join('') + '</div></section>' : '') +
    '</div>' +
    '<p class="ask">Ask your coding agent: <b>"Draft a LinkedIn post about the job we finished this week."</b></p>';
  const box = document.getElementById('social-text');
  if (box) box.focus();
}

async function loadSocial() {
  const el = document.getElementById('social-body');
  if (!el) return;
  const d = await api('/api/social');
  if (!d) { el.innerHTML = offlineState(); return; }
  if (d.error) { el.innerHTML = emptyState(icon('alert'), 'Couldn\'t read your playbooks', escHtml(d.error)); return; }
  _social = d;
  renderSocial();
}

async function socialSwitch(key, on) {
  const res = await api('/api/social/playbooks/' + encodeURIComponent(key), {method: 'POST',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify({active: on})});
  if (!(res && res.success)) showToast(failMsg(res, 'That did not work.'), 'error');
  loadSocial();
}

async function socialAct(id, action) {
  const body = action === 'edit' ? {body: document.getElementById('social-text').value} : {};
  const res = await api('/api/social/posts/' + encodeURIComponent(id) + '/' + action, {method: 'POST',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  if (res && res.success) {
    _socialEdit = '';
    showToast(action === 'approve' ? 'Approved. Copy it and post it, or ask your agent to.' : action === 'posted' ? 'Marked as posted.'
      : action === 'skip' ? 'Skipped.' : 'Saved. It still waits for your approval.', 'success');
  } else showToast(failMsg(res, 'That did not work.'), 'error');
  loadSocial();
}

async function copySocial(id) {
  const p = ((_social || {}).approved || []).find(x => x.id === id);
  if (!p) return;
  try { await navigator.clipboard.writeText(p.body); showToast('Copied.', 'success'); }
  catch { showToast('Could not copy. Select the post and copy it by hand.', 'error'); }
}

// ── Texts and consent ──

let _texting = null;

function textWho(t) {
  return escHtml([t.first_name, t.last_name].filter(Boolean).join(' ')) || escHtml(t.phone);
}

function textingBanner(d) {
  if (!d.enabled) return '<div class="banner mode-banner">' + icon('alert') + '<div><b>Texting is off</b>' +
    '<p>Turn it on with <code>texting: {enabled: true}</code> in ' + escHtml(d.config_file || 'sellbird.yaml') +
    ', after connecting Twilio. Drafts can still be written and approved; nothing sends while it is off.</p></div>' +
    '<button class="btn btn-secondary btn-sm" onclick="goTab(\'texting\')">Set up texting</button></div>';
  if (!d.connected) return '<div class="banner wait mode-banner">' + icon('alert') + '<div><b>Twilio is not connected</b>' +
    '<p>' + escHtml(d.problem || '') + '. Approved texts wait until it is.</p></div>' +
    '<button class="btn btn-secondary btn-sm" onclick="goTab(\'texting\')">Set up texting</button></div>';
  return '';
}

async function loadTexts() {
  const el = document.getElementById('texts-body');
  if (!el) return;
  const d = await api('/api/texting');
  if (!d) { el.innerHTML = offlineState(); return; }
  if (d.error) { el.innerHTML = emptyState(icon('alert'), 'Couldn\'t read your texts', escHtml(d.error)); return; }
  _texting = d;
  navCount('nav-texts', (d.pending || []).length);
  const pending = (d.pending || []).map(t =>
    '<div class="row"><span class="who" aria-hidden="true">' + icon('message') + '</span>' +
    '<div class="grow"><p class="t">To ' + textWho(t) + '</p><p class="s">' + escHtml(t.phone) +
      (t.drafted_by === 'agent' ? ' · drafted by your agent' : '') + '</p>' +
      '<div class="tb draft">' + escHtml(t.body) + '</div></div>' +
    '<div class="row-acts"><button class="btn btn-primary btn-sm" onclick="textAct(' + jsq(t.id) + ',\'approve\')">Approve</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="textAct(' + jsq(t.id) + ',\'reject\')">Reject</button>' + onlyYou() + '</div></div>').join('');
  const tone = {sent: 'good', received: 'acc', approved: 'wait', blocked: 'bad', failed: 'bad'};
  const word = {sent: 'Sent', received: 'Received', approved: 'Approved, waiting', blocked: 'Held', failed: 'Failed',
                rejected: 'Rejected', cancelled: 'Cancelled', sending: 'Sending'};
  const rest = (d.texts || []).filter(t => t.status !== 'pending_review').map(t =>
    '<div class="row"><span class="time">' + relTime(t.sent_at || t.created_at) + '</span>' +
    '<div class="grow"><p class="t">' + (t.direction === 'in' ? 'From ' : 'To ') + textWho(t) + '</p>' +
      '<p class="s">' + escHtml(t.body) + '</p>' +
      (t.error ? '<p class="s" style="color:var(--wait)">' + escHtml(t.error.charAt(0).toUpperCase() + t.error.slice(1)) + '.</p>' : '') + '</div>' +
    '<span class="tag ' + (tone[t.status] || '') + '">' + (word[t.status] || escHtml(t.status)) + '</span></div>').join('');
  el.innerHTML = textingBanner(d) + '<div class="secs">' +
    '<section class="sec"><h2>Waiting for you</h2><div class="w">' +
      (pending || '<div class="row"><div class="grow"><p class="t">Nothing to approve</p>' +
        '<p class="s">A text you or your agent drafts shows up here first.</p></div></div>') +
      '<p class="w-f">Your agent can draft a text. Only you can approve one.</p></div></section>' +
    '<section class="sec"><h2>Recent</h2><div class="w">' +
      (rest || '<div class="row"><div class="grow"><p class="t">No texts yet</p>' +
        '<p class="s">Texts in and out are listed here.</p></div></div>') + '</div></section></div>';
}

async function textAct(id, action) {
  const res = await api('/api/texts/' + encodeURIComponent(id) + '/' + action, {method: 'POST'});
  if (res && res.success) showToast(action === 'reject' ? 'Rejected.'
    : res.status === 'sent' ? 'Approved and sent.'
    : res.status === 'blocked' ? 'Held: ' + (res.note || 'the consent check said no') + '.'
    : 'Approved. ' + (res.note ? 'It waits: ' + res.note + '.' : 'It sends on the next cycle.'), 'success');
  else showToast(failMsg(res, 'That did not work.'), 'error');
  loadTexts();
}

async function loadTexting() {
  const el = document.getElementById('texting-body');
  if (!el) return;
  const d = await api('/api/texting');
  if (!d) { el.innerHTML = offlineState(); return; }
  if (d.error) { el.innerHTML = emptyState(icon('alert'), 'Couldn\'t read texting', escHtml(d.error)); return; }
  _texting = d;
  const q = d.quiet_hours || {};
  const r = (t, s, tag, tone) => '<div class="row"><div class="grow"><p class="t">' + t + '</p><p class="s">' + s + '</p></div>' +
    (tag ? '<span class="tag ' + (tone || '') + '">' + tag + '</span>' : '') + '</div>';
  const consents = (d.consents || []).map(c =>
    '<div class="row"><span class="time">' + relTime(c.created_at) + '</span><div class="grow"><p class="t">' +
    (escHtml([c.first_name, c.last_name].filter(Boolean).join(' ')) || escHtml(c.phone)) + '</p>' +
    '<p class="s">' + escHtml(c.phone) + ' · ' + escHtml(c.evidence || c.source || '') + '</p></div>' +
    '<span class="tag">' + (c.channel === 'call' ? 'Calls' : 'Texts') + '</span>' +
    '<span class="tag ' + (c.status === 'granted' ? 'good' : 'bad') + '">' + (c.status === 'granted' ? 'Yes' : 'Took it back') + '</span></div>').join('');
  const blocked = (d.blocked || []).map(b =>
    '<div class="row"><div class="grow"><p class="t">' + escHtml(b.phone) + '</p><p class="s">' +
    (b.reason === 'opted_out' ? 'Replied STOP' : 'Added by ' + escHtml(b.source || 'you')) + ' · ' + relTime(b.created_at) + '</p></div>' +
    (b.reason === 'opted_out' ? '<span class="tag bad">STOP</span>'
      : '<button class="btn btn-secondary btn-sm rowbtn" onclick="unblockPhone(' + jsq(b.phone) + ')">Remove</button>') + '</div>').join('');
  el.innerHTML = '<div class="secs">' +
    '<section class="sec"><h2>Your Twilio account</h2><div class="w">' +
      r('Texting', d.enabled ? 'On. Approved texts go out each cycle.' : 'Off. Set <code>texting: {enabled: true}</code> in ' + escHtml(d.config_file || 'sellbird.yaml') + '.',
        d.enabled ? 'On' : 'Off', d.enabled ? 'good' : '') +
      r('Twilio', d.connected ? 'Connected. Texts go out as ' + escHtml(d.from || 'your number') + ', on your own carrier registration.'
        : 'Twilio is ' + escHtml(d.problem || 'not connected') + '. Add the values to .env yourself; never paste them into a chat.',
        d.connected ? 'Connected' : 'Not connected', d.connected ? 'good' : 'wait') +
      '<p class="w-f">Sellbird registers no numbers of its own. Inbound texts are read from Twilio each cycle, so nothing has to be reachable from the internet.</p></div></section>' +
    '<section class="sec"><h2>Rules in force</h2><div class="w">' +
      r('Only to people who said yes', 'No stored yes, no first text. A yes to texts is not a yes to calls.', 'Always', 'good') +
      r('Quiet hours', 'Nothing between ' + escHtml(q.start || '21:00') + ' and ' + escHtml(q.end || '08:00') + ', their time when Sellbird knows it, else yours.', 'Always', 'good') +
      r('STOP means stop', 'A reply of STOP opts the number out at once and cancels anything queued. Only they can undo it.', 'Always', 'good') +
      r('Email opt-outs count too', 'Someone who opted out of email is not texted or called.', 'Always', 'good') +
      r('You approve every text', 'Your agent can draft. It cannot approve or send.', 'Always', 'good') +
      (d.inbound_counts_as_consent ? r('Someone who texts you first may be answered', 'Their message is kept as the record. Turn off with <code>texting.reply_to_inbound: false</code>.', 'On', 'acc') : '') +
      '<p class="w-f">These are checked in code at the moment of sending. There is no setting that turns them off.</p></div></section>' +
    '<section class="sec"><h2>Record a yes</h2><div class="w pad">' +
      '<div class="form-row"><div class="form-group"><label class="form-label" for="cs-phone">Phone number</label>' +
        '<input class="form-input" id="cs-phone" type="tel" autocomplete="off" placeholder="(303) 555-0119"></div>' +
      '<div class="form-group"><label class="form-label" for="cs-channel">For</label>' +
        '<select class="form-input" id="cs-channel"><option value="sms">Texts</option><option value="call">Calls</option></select></div></div>' +
      '<div class="form-group"><label class="form-label" for="cs-evidence">How they agreed</label>' +
        '<input class="form-input" id="cs-evidence" maxlength="300" placeholder="Ticked the box on the quote form on March 3"></div>' +
      '<div class="btn-group" style="margin-top:0"><button class="btn btn-primary btn-sm" onclick="recordConsent(\'granted\')">Record their yes</button>' +
        '<button class="btn btn-secondary btn-sm" onclick="recordConsent(\'revoked\')">They took it back</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="blockPhone()">Never contact this number</button></div>' +
      '<p class="form-hint">Write what you would show if anyone asked. A record is never edited: a later no is added after it.</p></div></section>' +
    '<section class="sec"><h2>Consent records</h2><div class="w">' +
      (consents || '<div class="row"><div class="grow"><p class="t">No one has said yes yet</p><p class="s">Until someone does, no text can be drafted or sent.</p></div></div>') + '</div></section>' +
    '<section class="sec"><h2>Never contact</h2><div class="w">' +
      (blocked || '<div class="row"><div class="grow"><p class="t">No numbers on the list</p><p class="s">Numbers that reply STOP land here by themselves.</p></div></div>') +
      '<p class="w-f">Checked before every text, and before every call.</p></div></section></div>';
}

async function recordConsent(status) {
  const body = {phone: document.getElementById('cs-phone').value.trim(), channel: document.getElementById('cs-channel').value,
                status, source: 'other', evidence: document.getElementById('cs-evidence').value.trim()};
  const res = await api('/api/consent', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  if (res && res.success) showToast(status === 'granted' ? 'Recorded their yes for ' + res.phone + '.' : 'Recorded. Nothing more goes to ' + res.phone + ' on that channel.', 'success');
  else showToast(failMsg(res, 'Could not record that.'), 'error');
  loadTexting();
}

async function blockPhone() {
  const res = await api('/api/phone-blocks', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({phone: document.getElementById('cs-phone').value.trim()})});
  if (res && res.success) showToast(res.phone + ' will never be called or texted.', 'success');
  else showToast(failMsg(res, 'Could not add that number.'), 'error');
  loadTexting();
}

async function unblockPhone(phone) {
  const res = await api('/api/phone-blocks/remove', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({phone})});
  if (res && res.success) showToast('Removed from the list.', 'success');
  else showToast(failMsg(res, 'Could not remove that number.'), 'error');
  loadTexting();
}

// ── Email records: SPF, DKIM, DMARC and MX, and what to fix ──

const RECORD_WORDS = {
  MX: 'Where replies and bounces are delivered',
  SPF: 'Which servers may send as your domain',
  DKIM: 'A signature that proves a message is yours',
  DMARC: 'What receivers do when the other two fail',
};

async function loadRecords(btn) {
  const el = document.getElementById('records-body');
  if (!el) return;
  if (btn) btn.disabled = true;
  if (!el.innerHTML || btn) el.innerHTML = '<div class="w pad muted">Reading your DNS records. This takes a few seconds.</div>';
  const d = await api('/api/email-records');
  if (btn) btn.disabled = false;
  if (!d) { el.innerHTML = offlineState(); return; }
  if (d.error) { el.innerHTML = emptyState(icon('alert'), 'Couldn\'t check the records', escHtml(d.error)); return; }
  el.innerHTML = recordsHtml(d);
}

function recordsHtml(d) {
  const domains = d.domains || [];
  if (!domains.length) {
    return '<div class="w">' + emptyState(icon('inboxes'), 'No sending address yet',
      'Connect an inbox under <b>Set up, Inboxes</b>, or set <code>persona.email</code> in ' +
      escHtml(d.config_file || 'sellbird.yaml') + '. Sellbird checks the domain after the @.') + '</div>';
  }
  const word = {ok: 'Ready', warn: 'Works, could be better', fail: 'Needs fixing', unknown: 'Could not check'};
  const tone = {ok: 'good', warn: 'wait', fail: 'bad', unknown: ''};
  return '<div class="secs">' + domains.map(dom =>
    '<section class="sec"><h2>' + escHtml(dom.domain) + '<span class="tag ' + tone[dom.state] + '">' + word[dom.state] + '</span></h2>' +
    '<div class="w">' + (dom.checks || []).map(c => {
      const state = c.unknown ? 'unknown' : c.status;
      return '<div class="row top"><div class="grow"><p class="t">' + escHtml(c.name) + '</p>' +
        '<p class="s">' + escHtml(own(RECORD_WORDS, c.name) || '') + '</p>' +
        '<p class="s found">' + escHtml(c.detail) + '</p>' +
        (c.fix ? '<p class="fix"><b>To fix:</b> ' + escHtml(c.fix) + '</p>' : '') + '</div>' +
        '<span class="tag ' + (tone[state] || '') + '">' + ({ok: 'OK', warn: 'Check', fail: 'Fix', unknown: 'Not checked'}[state] || 'Note') + '</span></div>';
    }).join('') +
    '<p class="w-f">Records are changed where the domain is registered. A change can take up to a day to show here.</p></div></section>'
  ).join('') + '</div>' +
  '<p class="ask">For blocklists, domain age and warmup, run <b>sellbird warmup</b>, or ask your agent: <b>"Is my sending domain ready?"</b></p>';
}

// ── Opt-outs and bounces: who is never emailed ──

const NEVER_WORDS = {opted_out: 'Opted out', bounced: 'Bounced', complaint: 'Complained', manual: 'Added by you', imported: 'Imported'};
let _never = null, _neverQuery = '', _neverArmed = '';

async function loadNeverEmail() {
  const el = document.getElementById('neveremail-body');
  if (!el) return;
  const d = await api('/api/suppressions');
  if (!d) { el.innerHTML = offlineState(); return; }
  if (d.error) { el.innerHTML = emptyState(icon('alert'), 'Couldn\'t read the list', escHtml(d.error)); return; }
  _never = d;
  el.innerHTML = '<div class="stats">' + ['opted_out', 'bounced', 'complaint', 'manual'].map(k =>
      '<div class="stat"><span>' + NEVER_WORDS[k] + '</span><b class="v' + ((d.counts || {})[k] ? '' : ' zero') + '">' +
      ((d.counts || {})[k] || 0) + '</b></div>').join('') + '</div>' +
    '<div class="secs"><section class="sec"><h2>Add someone</h2><div class="w pad">' +
      '<div class="form-row"><div class="form-group"><label class="form-label" for="ne-value">An address, or a whole domain</label>' +
        '<input class="form-input" id="ne-value" autocomplete="off" placeholder="pat@example.com or example.com" ' +
        'onkeydown="if (event.key === \'Enter\') addNeverEmail()"></div>' +
      '<button class="btn btn-primary btn-sm" onclick="addNeverEmail()">Never email</button></div>' +
      '<p class="form-hint">A domain covers everyone at it. Anything queued for them is held back at the moment of sending.</p></div></section>' +
    '<section class="sec"><h2>The list</h2>' +
      '<input class="form-input" type="search" aria-label="Search the list" placeholder="Search" value="' + escHtml(_neverQuery) +
        '" oninput="_neverQuery=this.value;renderNeverRows()">' +
      '<div class="w" id="ne-rows"></div></section></div>';
  renderNeverRows();
}

function renderNeverRows() {
  const el = document.getElementById('ne-rows');
  if (!el || !_never) return;
  const q = _neverQuery.trim().toLowerCase();
  const rows = (_never.rows || []).filter(r => !q || String(r.value).toLowerCase().includes(q));
  if (!rows.length) {
    el.innerHTML = '<div class="row"><div class="grow"><p class="t">' + (q ? 'No match' : 'Nobody yet') + '</p><p class="s">' +
      (q ? 'Nothing on the list matches that search.' : 'An opt-out or a bounce puts the address here by itself. Nobody has done either yet.') + '</p></div></div>';
    return;
  }
  el.innerHTML = rows.map(r =>
    '<div class="row"><div class="grow"><p class="t">' + escHtml(r.value) + '</p>' +
    '<p class="s">' + (r.kind === 'domain' ? 'Everyone at this domain' : 'This address') + ' · ' + relTime(r.created_at) + '</p></div>' +
    '<span class="tag ' + (r.reason === 'manual' || r.reason === 'imported' ? '' : 'bad') + '">' + escHtml(own(NEVER_WORDS, r.reason) || r.reason) + '</span>' +
    (_neverArmed === r.id
      ? '<div class="row-acts"><button class="btn btn-danger btn-sm" onclick="removeNeverEmail(' + jsq(r.id) + ')">Yes, allow email again</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="_neverArmed=\'\';renderNeverRows()">Keep</button></div>'
      : '<button class="btn btn-ghost btn-sm rowbtn" onclick="_neverArmed=' + jsq(r.id) + ';renderNeverRows()">Remove</button>') +
    '</div>').join('') +
    '<p class="w-f">' + (_never.total > rows.length && !q ? 'Showing the newest ' + rows.length + ' of ' + _never.total + '. Export has all of them. ' : '') +
    'Only you can take someone off this list. Your agent cannot.</p>';
}

async function addNeverEmail() {
  const input = document.getElementById('ne-value');
  const res = await api('/api/suppressions', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({value: input.value.trim()})});
  if (res && res.success) showToast(res.added ? res.value + ' will never be emailed.' : res.value + ' was already on the list.', 'success');
  else showToast(failMsg(res, 'Could not add that.'), 'error');
  loadNeverEmail();
}

async function removeNeverEmail(id) {
  const res = await api('/api/suppressions/' + encodeURIComponent(id) + '/remove', {method: 'POST'});
  _neverArmed = '';
  if (res && res.success) showToast('Removed. Sellbird may email them again.', 'success');
  else showToast(failMsg(res, 'Could not remove that.'), 'error');
  loadNeverEmail();
}

// ── Limits and rules: the stop button, and what sends on its own ──

async function loadLimits() {
  const el = document.getElementById('limits-body');
  if (!el) return;
  const d = await api('/api/limits');
  if (!d) { el.innerHTML = offlineState(); return; }
  if (d.error) { el.innerHTML = emptyState(icon('alert'), 'Couldn\'t read the limits', escHtml(d.error)); return; }
  el.innerHTML = limitsHtml(d);
}

function limitsHtml(d) {
  const r = (t, sub, tag, tone) => '<div class="row"><div class="grow"><p class="t">' + t + '</p><p class="s">' + sub + '</p></div>' +
    (tag ? '<span class="tag ' + (tone || '') + '">' + tag + '</span>' : '') + '</div>';
  const file = '<code>' + escHtml(d.file || 'sellbird.yaml') + '</code>';
  const auto = d.mode === 'autopilot', paused = !!d.paused;
  const q = d.quiet_hours || {}, w = d.send_window, t = d.texting;
  return '<div class="secs">' +
    '<section class="sec span"><div class="w"><div class="row"><div class="grow"><p class="t">' +
      (paused ? 'All sending is paused' : 'Sending is on') + '</p><p class="s">' +
      (paused ? escHtml(d.paused) + '. Nothing goes out until you turn it back on. Only you can.'
              : 'One press stops every email and text. Your agent can press it too. Only you can undo it.') + '</p></div>' +
      (paused ? '<button class="btn btn-primary btn-sm" onclick="limitsToggle(\'resume\')">Turn sending back on</button>'
              : '<button class="btn btn-danger btn-sm" onclick="limitsToggle(\'pause\')">Pause all sending</button>') +
      '</div></div></section>' +
    '<section class="sec"><h2>What sends on its own</h2><div class="w">' +
      '<div class="row"><div class="grow"><p class="t">Email autopilot</p><p class="s">' +
        (auto ? 'On. Emails Sellbird writes go out on schedule, inside the limits here. Ones that link to a site that is not yours still wait for you.'
              : 'Off. Every email, first, follow-up or reply, waits in the Outbox for you.') + '</p></div>' +
        (auto ? '<button class="btn btn-secondary btn-sm" onclick="limitsAutopilotOff()">Turn off</button>'
              : '<span class="tag good">Off</span>') + '</div>' +
      r('Texts', 'Never. Every text waits for you under Inbound, Texts.', 'Never', 'good') +
      r('Anything your agent writes', 'Never on its own say-so. It can draft and propose. It cannot approve, send or resume.', 'Never', 'good') +
      '<p class="w-f">' + (auto ? 'Turning autopilot off works at once.' : 'Autopilot is turned on under <b>Sending and keys</b>, by typing its name.') +
      ' There is no other rule that sends without you.</p></div></section>' +
    '<section class="sec"><h2>Email limits</h2><div class="w">' +
      r('Emails a day', 'Across every inbox. <code>channels.email.max_daily_sends</code>', escHtml(String(d.max_daily_sends))) +
      r('Per inbox, a day', 'A new inbox ramps up to this. <code>channels.email.per_inbox_daily_cap</code>', escHtml(String(d.per_inbox_daily_cap))) +
      r('Bounce limit', 'Past this share of bounces, all sending pauses by itself. <code>channels.email.max_bounce_rate</code>',
        escHtml(String(Math.round(d.max_bounce_rate * 1000) / 10)) + '%') +
      r('Sending hours', w ? 'Their local time' + (w.weekdays_only ? ', weekdays only' : '') + '. <code>channels.email.send_window</code>'
                          : 'No window set. <code>channels.email.send_window</code>',
        w ? escHtml(w.start) + ' to ' + escHtml(w.end) : 'Any time') +
      r('Quiet hours', 'Sellbird does nothing in these hours, ' + escHtml(q.timezone || '') + '. <code>usage.quiet_hours</code>',
        escHtml(q.start || '') + ' to ' + escHtml(q.end || '')) +
      r('Follow-ups', 'They stop on a reply, a booked meeting or an opt-out. <code>writer.sequence_length</code>',
        d.follow_ups ? escHtml(String(d.sequence_length)) + ' emails' : 'Off') +
      r('Catch-all addresses', 'Addresses that cannot be confirmed either way. <code>channels.email.send_to_risky</code>',
        d.send_to_risky ? 'Sent to' : 'Not sent to') +
      '<p class="w-f">Change these in ' + file + '. A running Sellbird picks them up on its next cycle.</p></div></section>' +
    (t ? '<section class="sec"><h2>Text limits</h2><div class="w">' +
      r('Texting', t.enabled ? 'Approved texts go out each cycle.' : 'Nothing sends while it is off.', t.enabled ? 'On' : 'Off', t.enabled ? 'good' : '') +
      r('Quiet hours', 'Their local time when Sellbird knows it, else yours. <code>texting.quiet_hours</code>',
        escHtml(t.quiet_start) + ' to ' + escHtml(t.quiet_end)) +
      r('Replies to people who text you first', 'Their message counts as the record. A reply still waits for you. <code>texting.reply_to_inbound</code>',
        t.reply_to_inbound ? 'Allowed' : 'Needs a recorded yes') +
      '<p class="w-f">The consent rules themselves are under <b>Texting and consent</b> and cannot be turned off.</p></div></section>' : '') +
    '</div>';
}

async function limitsToggle(action) {
  const res = await api('/api/sending/' + action, {method: 'POST'});
  if (res && res.success) showToast(action === 'pause' ? 'Sending paused.' : 'Sending is back on.', 'success');
  else showToast(failMsg(res, action === 'pause' ? 'Could not pause sending.' : 'Could not resume sending.'), 'error');
  loadLimits();
}

async function limitsAutopilotOff() {
  const res = await api('/api/sending-mode', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({mode: 'approval'})});
  if (res && res.success) showToast('Autopilot is off. Every email waits for you.', 'success');
  else showToast(failMsg(res, 'Could not change the sending mode.'), 'error');
  loadLimits();
}

// ── Your agent: access, what it may do, what it did ──

async function loadAgent() {
  const el = document.getElementById('agent-body');
  if (!el) return;
  const d = await api('/api/agent');
  if (!d) { el.innerHTML = offlineState(); return; }
  if (d.error) { el.innerHTML = emptyState(icon('alert'), 'Couldn\'t read this', escHtml(d.error)); return; }
  el.innerHTML = agentHtml(d);
  loadAgentConnect();
}

function agentHtml(d) {
  const on = d.access !== 'off';
  const r = (t, sub, tag, tone) => '<div class="row"><div class="grow"><p class="t">' + t + '</p>' + (sub ? '<p class="s">' + sub + '</p>' : '') + '</div>' +
    (tag ? '<span class="tag ' + (tone || '') + '">' + tag + '</span>' : '') + '</div>';
  const log = (d.requests || []).map(q => {
    const ok = q.status >= 200 && q.status < 300;
    const refused = q.status === 403;
    return '<div class="row"><span class="time">' + relTime(q.created_at) + '</span><div class="grow"><p class="t">' + (q.what !== q.path ? escHtml(q.what) : 'Tried something that is yours alone') + '</p>' +
      '<p class="s mono">' + escHtml(q.method) + ' ' + escHtml(q.path) + '</p></div>' +
      '<span class="tag ' + (ok ? 'good' : refused ? 'bad' : 'wait') + '">' + (ok ? 'Done' : refused ? 'Refused' : 'Failed') + '</span></div>';
  }).join('');
  return '<div class="secs">' +
    '<section class="sec span"><div class="w"><div class="row"><div class="grow"><p class="t">' +
      (on ? 'Your agent has access' : 'Your agent is cut off') + '</p><p class="s">' +
      (on ? (d.last_seen ? 'Last call ' + relTime(d.last_seen) + '. ' : 'It has not called yet. ') + 'Cutting it off works at once and needs nothing from the agent.'
          : 'Every call it makes is refused. Nothing else changes: Sellbird keeps running and your own access is the same.') + '</p></div>' +
      (on ? '<button class="btn btn-danger btn-sm" onclick="setAgentAccess(\'off\')">Cut it off</button>'
          : '<button class="btn btn-primary btn-sm" onclick="setAgentAccess(\'on\')">Let it back in</button>') +
      '</div></div></section>' +
    '<section class="sec"><h2>Its browser pane</h2><div class="w">' +
      ((d.panes || []).length
        ? (d.panes || []).map(x => r('Signed in in your agent\'s browser pane', 'Since ' + relTime(new Date(x.since * 1000).toISOString()) +
            '. Signs itself out in ' + Math.max(1, Math.round(x.minutes_left / 60)) + ' hours.', 'Open', 'wait')).join('') +
          '<div class="row"><div class="grow"><p class="s">Whoever drives that pane can click most of what you can, Approve included. It can never let your agent back in, resume sending, turn on autopilot, connect an agent or make links for more panes.</p></div>' +
          '<button class="btn btn-secondary btn-sm" onclick="signOutPanes()">Sign panes out</button></div>'
        : r('No pane is signed in', 'Your agent can open this dashboard in its own browser pane with a link that works once, for two minutes. ' +
            'It never gets your key. Cutting it off signs every pane out.')) +
      '</div></section>' +
    '<section class="sec"><h2>Connect an agent</h2><div class="w" id="agent-connect">' +
      '<div class="row"><div class="grow"><p class="s">Looking for agents on this computer...</p></div></div></div>' +
      '<h2>What it may do</h2><div class="w">' +
      r('Read', 'Today, people, companies, replies, the Outbox, campaigns, numbers, the calendar and the setup checklist.', d.reads + ' reads') +
      (d.may_do || []).map(x => r(escHtml(x), '')).join('') + '</div></section>' +
    '<section class="sec"><h2>What it can never do</h2><div class="w">' +
      ['Approve or send an email or a text', 'Turn sending back on after a pause', 'Turn on autopilot',
       'Confirm a signal or run a paid search', 'Record that someone agreed to texts or calls',
       'Take anyone off the never-email or do-not-contact lists', 'Read or change a key, a password or a setting',
       'Switch its own access back on'].map(x => r(x, '', 'Yours', 'good')).join('') +
      '<p class="w-f">This is a fixed list in the code, not a setting. A new feature is yours alone until it is added to the agent\'s list.</p></div></section>' +
    '<section class="sec span"><h2>What it did</h2><div class="w">' +
      (log || '<div class="row"><div class="grow"><p class="t">Nothing yet</p><p class="s">Every call your agent makes shows up here, including the ones Sellbird refused.</p></div></div>') +
      '<p class="w-f">The newest 100. What it asked for and how it ended; never the contents.</p></div></section></div>';
}

// Connect buttons: one row per agent found on this computer.
let _connectNext = {};

async function loadAgentConnect() {
  const el = document.getElementById('agent-connect');
  if (!el) return;
  const d = await api('/api/agents/connect');
  if (!d || d.error || !d.agents) {
    el.innerHTML = '<div class="row"><div class="grow"><p class="t">Connect from a terminal</p><p class="s">' +
      escHtml((d && (d.message || d.error)) || 'This page can\'t check your agents.') + ' Run <code>sellbird connect</code> instead.</p></div></div>';
    return;
  }
  const verb = {connect: 'Connect', reconnect: 'Reconnect', remove: 'Remove'};
  const tone = {connected: 'good', not_connected: '', elsewhere: 'wait', moved: 'wait', blocked: 'bad'};
  const rows = d.agents.map(a => {
    const sub = a.state === 'elsewhere' ? 'Uses the Sellbird in ' + escHtml(a.detail) + '. Reconnect points it at this one.'
      : a.state === 'moved' ? 'Set up from another copy of Sellbird. Reconnect points it at this one.'
      : a.state === 'blocked' ? escHtml(a.detail)
      : a.state === 'connected' ? 'Ask it: "Open Sellbird" or "What needs me?"'
      : 'Adds Sellbird to its settings. Nothing else in them changes.';
    const nxt = _connectNext[a.agent];
    return '<div class="row"><div class="grow"><p class="t">' + escHtml(a.name) + '</p><p class="s">' + sub + '</p>' +
      '<span class="tag ' + (tone[a.state] || '') + '">' + escHtml(a.label) + '</span>' +
      (nxt ? '<p class="s"><b>Next:</b> ' + escHtml(nxt) + '</p>' : '') + '</div>' +
      (a.action ? '<button class="btn ' + (a.action === 'connect' || a.state === 'moved' ? 'btn-primary' : 'btn-secondary') + ' btn-sm" ' +
        'onclick="connectAgent(\'' + escHtml(a.agent) + '\', \'' + a.action + '\', this, ' + (a.state === 'elsewhere' ? '1' : '0') + ')">' + verb[a.action] + '</button>' : '') + '</div>';
  }).join('');
  el.innerHTML = (rows || '<div class="row"><div class="grow"><p class="t">No agent found here</p><p class="s">Install Claude Code, Claude desktop or Codex, then come back.</p></div></div>') +
    '<p class="w-f">Your agent gets its own key, never yours, and no key goes into its settings. A copy of each settings file is kept before it changes. ' +
    'ChatGPT and claude.ai in a browser can\'t reach Sellbird on this computer: use Codex, or hosted Sellbird.</p>';
}

async function connectAgent(agent, action, btn, otherFolder) {
  // Another Sellbird folder is in use there: moving it to this one is a real choice.
  if (otherFolder && !confirm('This agent uses another Sellbird folder now. Point it at this one instead? The other folder stays as it is.')) return;
  if (btn) btn.disabled = true;
  const res = await api('/api/agents/connect', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({agent, action})});
  if (res && res.success) {
    _connectNext[agent] = res.next || '';
    showToast(action === 'remove' ? 'Removed. ' + (res.next || '') : 'Connected. ' + (res.next || ''), 'success');
  } else {
    showToast(failMsg(res, 'Could not change that agent.'), 'error');
    if (btn) btn.disabled = false;
  }
  loadAgentConnect();
}

async function signOutPanes() {
  const res = await api('/api/pane/sign-out', {method: 'POST'});
  if (res && res.success) showToast('Signed out. A pane opened by your agent needs a new link now.', 'success');
  loadAgent();
}

async function setAgentAccess(access) {
  const res = await api('/api/agent/access', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({access})});
  if (res && res.success) showToast(access === 'off' ? 'Your agent is cut off.' : 'Your agent has access again.', 'success');
  else showToast(failMsg(res, 'Could not change that.'), 'error');
  loadAgent();
}

// ── One person: who they are, the deal, and everything that happened ──

let _person = null;

function openPerson(id) {
  _personId = String(id || '');
  _person = null;
  showTab('person');
}

async function loadPerson() {
  const el = document.getElementById('person-body');
  if (!el) return;
  if (!_personId) { goTab('prospects'); return; }
  const d = await api('/api/prospects/' + encodeURIComponent(_personId));
  if (!d) { el.innerHTML = offlineState(); return; }
  if (d.success === false || !d.person) {
    el.innerHTML = '<div class="w">' + emptyState(icon('contacts'), 'No such person',
      'They may have been removed. <button type="button" class="linklike" onclick="goTab(\'prospects\')">Back to People</button>') + '</div>';
    return;
  }
  // Typing in the deal form survives a background refresh.
  const typing = document.activeElement && el.contains(document.activeElement) &&
    ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
  _person = d;
  if (!typing) el.innerHTML = personHtml(d);
}

function personHtml(d) {
  const p = d.person;
  const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || 'Unnamed';
  const stage = stageOf(p);
  const r = (t, sub, tag, tone) => '<div class="row"><div class="grow"><p class="t">' + t + '</p>' + (sub ? '<p class="s">' + sub + '</p>' : '') + '</div>' +
    (tag ? '<span class="tag ' + (tone || '') + '">' + tag + '</span>' : '') + '</div>';
  const none = (t, sub) => '<div class="row"><div class="grow"><p class="t">' + t + '</p><p class="s">' + sub + '</p></div></div>';

  // Emails and replies, in the order they happened.
  const items = (d.emails || []).map(e => ({ts: e.sent_at || e.send_at || e.created_at, email: e}));
  (d.conversations || []).forEach(c => (c.thread || []).forEach(m => items.push({ts: m.timestamp, msg: m})));
  items.forEach(it => { it.key = +parseTs(it.ts); });
  items.sort((a, b) => (isNaN(a.key) ? Infinity : a.key) - (isNaN(b.key) ? Infinity : b.key));
  const thread = items.map(it => {
    if (it.email) {
      const e = it.email;
      return '<div class="thread-email"><div class="te-head">' + icon('campaigns') +
        '<b>' + (e.kind === 'reply' ? 'Reply' : 'Email ' + escHtml(String(e.step))) + '</b><span>' + escHtml(e.subject) + '</span>' +
        badge(e.status) + '<span class="te-when">' + relTime(it.ts) + '</span></div>' +
        '<div class="te-body">' + escHtml(e.body) + '</div></div>';
    }
    const m = it.msg, sent = m.sender !== 'prospect';
    return '<div class="thread-msg ' + (sent ? 'sent' : 'received') + '"><div class="sender">' +
      (sent ? 'Sellbird' : escHtml(p.first_name || 'Them')) + ' &middot; ' + relTime(m.timestamp) + '</div>' + escHtml(m.content) + '</div>';
  }).join('');

  const texts = (d.texts || []).map(t => {
    const out = t.direction === 'out';
    return '<div class="thread-msg ' + (out ? 'sent' : 'received') + '"><div class="sender">' +
      (out ? 'You' : escHtml(p.first_name || 'Them')) + ' &middot; ' + relTime(t.sent_at || t.created_at) +
      (out && t.status !== 'sent' ? ' &middot; ' + escHtml(String(t.status).replace(/_/g, ' ')) : '') + '</div>' + escHtml(t.body) + '</div>';
  }).join('');

  const latest = {};
  (d.consents || []).forEach(c => { if (!latest[c.channel]) latest[c.channel] = c; });
  const consentRow = (channel, label) => {
    const c = latest[channel];
    if (!c) return r(label, 'No record. Nothing can go to them on this channel.', 'No yes', '');
    return r(label, escHtml(c.evidence || c.source || '') + ' · ' + relTime(c.created_at) + ' · recorded by ' + escHtml(c.recorded_by || 'you'),
      c.status === 'granted' ? 'Yes' : 'Took it back', c.status === 'granted' ? 'good' : 'bad');
  };

  const history = (d.stage_events || []).slice().reverse().map(ev =>
    '<div class="row"><span class="time">' + relTime(ev.created_at) + '</span><div class="grow"><p class="t">' +
    escHtml(own(stageNames(), ev.to_stage) || ev.to_stage) + '</p><p class="s">' +
    (ev.from_stage ? 'From ' + escHtml(own(stageNames(), ev.from_stage) || ev.from_stage) + ', by ' : 'By ') +
    escHtml(ev.changed_by === 'sellbird' ? 'Sellbird' : ev.changed_by === 'agent' ? 'your agent' : 'you') +
    (ev.reason ? ' · ' + escHtml(ev.reason) : '') + '</p></div></div>').join('');
  const meetings = (d.meetings || []).map(m =>
    r(m.starts_at ? formatDate(m.starts_at) : 'Time not given', escHtml(m.note || '') || 'Recorded ' + relTime(m.created_at), 'Meeting', 'acc')).join('');

  const optedOut = p.status === 'opted_out';
  return '<div class="person-head"><span class="who big" aria-hidden="true">' + initials(p.first_name, p.last_name) + '</span>' +
      '<div class="grow"><h1 tabindex="-1">' + escHtml(name) + '</h1>' +
      '<p>' + escHtml([p.title, p.company].filter(Boolean).join(', ')) + '</p>' +
      '<p class="reach">' + [p.email ? escHtml(p.email) + emailTag(p) : '', p.phone ? escHtml(p.phone) : ''].filter(Boolean).join(' · ') + '</p></div>' +
      '<div class="tags"><span class="tag' + (STAGE_TONES[stage] ? ' ' + STAGE_TONES[stage] : '') + '">' + escHtml(stageNames()[stage]) + '</span>' +
      '<span class="tag">' + escHtml(sourceName(sourceOf(p))) + '</span>' + badge(p.status) + '</div></div>' +
    (d.suppressed ? '<div class="banner bad">' + icon('alert') + '<div><b>Never emailed</b><p>' +
      escHtml(own(NEVER_WORDS, d.suppressed) || d.suppressed) + '. See Set up, Opt-outs and bounces.</p></div></div>' : '') +
    '<div class="secs">' +
    '<section class="sec"><h2>The deal</h2><div class="w pad">' +
      '<div class="form-row"><div class="form-group"><label class="form-label" for="pd-stage">Stage</label>' +
        '<select class="form-input" id="pd-stage"' + (optedOut ? ' disabled' : '') + ' onchange="personStage(this.value)">' +
        Object.keys(stageNames()).map(k => '<option value="' + k + '"' + (k === stage ? ' selected' : '') + '>' + escHtml(stageNames()[k]) + '</option>').join('') +
        '</select></div>' +
      '<div class="form-group"><label class="form-label" for="pd-value">Worth</label>' +
        '<input class="form-input" id="pd-value" inputmode="numeric" autocomplete="off" placeholder="0" value="' + (p.deal_value ? escHtml(String(p.deal_value)) : '') + '"></div></div>' +
      '<div class="form-group"><label class="form-label" for="pd-next">Next step</label>' +
        '<input class="form-input" id="pd-next" maxlength="300" placeholder="Send the quote by Friday" value="' + escHtml(p.next_step || '') + '"></div>' +
      '<div class="form-group"><label class="form-label" for="pd-notes">Notes</label>' +
        '<textarea class="form-input" id="pd-notes" rows="3" maxlength="4000">' + escHtml(p.deal_notes || '') + '</textarea></div>' +
      '<div class="btn-group" style="margin-top:0"><button class="btn btn-primary btn-sm" onclick="savePersonDeal()">Save</button>' +
        (optedOut ? '' : '<button class="btn btn-secondary btn-sm" onclick="personMeeting()">A meeting is booked</button>') + '</div>' +
      '<p class="form-hint">Your agent keeps this up to date too. Moving a stage sends nothing. A booked meeting stops their follow-ups.</p></div>' +
      '<h2>Calls and texts</h2><div class="w">' + consentRow('sms', 'Texts') + consentRow('call', 'Calls') +
        (d.phone_blocked ? r('Do not contact', d.phone_blocked === 'opted_out' ? 'They replied STOP.' : 'Added by hand.', 'Blocked', 'bad') : '') +
        '<p class="w-f">A yes is recorded under Set up, Texting and consent.</p></div>' +
      '<h2>Stage history</h2><div class="w">' + (meetings + history || none('Nothing yet', 'They were found and have not moved since.')) + '</div></section>' +
    '<section class="sec"><h2>Emails and replies</h2><div class="w pad"><div class="thread">' +
      (thread || '<p class="muted">Nothing has been written to them yet.</p>') + '</div></div>' +
      (texts ? '<h2>Texts</h2><div class="w pad"><div class="thread">' + texts + '</div></div>' : '') +
      (p.personalization_notes ? '<h2>What Sellbird found</h2><div class="w pad"><p class="notes">' + escHtml(p.personalization_notes) + '</p></div>' : '') +
    '</section></div>';
}

async function savePersonDeal() {
  const value = document.getElementById('pd-value').value.replace(/[^0-9.]/g, '');
  const body = {value: value === '' ? 0 : Number(value), next_step: document.getElementById('pd-next').value,
                notes: document.getElementById('pd-notes').value};
  const res = await api('/api/prospects/' + encodeURIComponent(_personId) + '/deal', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  if (res && res.success) showToast('Saved.', 'success');
  else showToast(failMsg(res, 'Could not save that.'), 'error');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  loadPerson();
}

async function personStage(stage) {
  if (stage === 'meeting_booked') { personMeeting(); return; }
  const res = await api('/api/prospects/' + encodeURIComponent(_personId) + '/stage', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({stage})});
  if (res && res.success) showToast('Moved to ' + (own(stageNames(), stage) || stage) + '.', 'success');
  else showToast(failMsg(res, 'Could not move them.'), 'error');
  loadPerson();
}

async function personMeeting() {
  const when = prompt('A meeting is booked. Their follow-ups stop.\n\nWhen is it? Optional, for example 2026-03-10 15:00', '');
  if (when === null) { loadPerson(); return; }
  let starts = '';
  if (when.trim()) {
    const dt = new Date(when.trim().replace(' ', 'T'));
    if (isNaN(dt)) { showToast('That time was not understood. Try 2026-03-10 15:00.', 'error'); loadPerson(); return; }
    starts = dt.toISOString();
  }
  const res = await api('/api/prospects/' + encodeURIComponent(_personId) + '/meeting', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({starts_at: starts})});
  if (res && res.success) showToast('Meeting recorded. Follow-ups stop.', 'success');
  else showToast(failMsg(res, 'Could not record the meeting.'), 'error');
  loadPerson();
}

// ── Events and webhooks: what other tools can listen to ──

const EVENT_NAMES = {'lead.created': 'New lead', 'reply.received': 'Reply', 'meeting.booked': 'Meeting booked',
                     'stage.changed': 'Stage change'};

async function loadEvents() {
  const el = document.getElementById('events-body');
  if (!el) return;
  const data = await api('/api/events');
  if (!data) { el.innerHTML = offlineState(); return; }
  if (data.error) { el.innerHTML = emptyState(icon('alert'), 'Couldn\'t read the events', escHtml(data.error)); return; }
  el.innerHTML = eventsHtml(data);
}

function eventsHtml(data) {
  const eps = data.endpoints || [];
  const hosts = {};
  eps.forEach(e => { hosts[e.key] = e.host; });
  const epRows = eps.length
    ? eps.map(e => '<div class="row"><div class="grow"><p class="t">' + escHtml(e.host) + '</p>' +
        '<p class="s">' + (e.events || []).map(t => escHtml(own(EVENT_NAMES, t) || t)).join(', ') + '</p>' +
        (e.problem ? '<p class="s" style="color:var(--bad)">Not sending: ' + escHtml(e.problem) + '.</p>' : '') + '</div>' +
        '<span class="tag ' + (e.problem ? 'bad' : 'good') + '">' + (e.problem ? 'Not sending' : 'Signed with ' + escHtml(e.secret_env)) + '</span></div>').join('')
    : '<div class="row"><div class="grow"><p class="t">No endpoint yet</p>' +
      '<p class="s">Events are still recorded below. Add an address and Sellbird starts sending to it.</p></div></div>';
  const tone = {delivered: 'good', retrying: 'wait', failed: 'bad', skipped: ''};
  const word = {delivered: 'Delivered', retrying: 'Retrying', failed: 'Gave up', skipped: 'Not wanted'};
  const evRows = (data.events || []).map(ev => {
    const p = (ev.data && ev.data.person) || {};
    const who = p.name || p.email || '';
    const what = ev.type === 'stage.changed' ? String(ev.data.from || '').replace(/_/g, ' ') + ' to ' + String(ev.data.to || '').replace(/_/g, ' ')
      : ev.type === 'reply.received' ? String(ev.data.intent || '').replace(/_/g, ' ')
      : ev.type === 'meeting.booked' ? ((ev.data.meeting || {}).starts_at ? formatDate(ev.data.meeting.starts_at) : 'no time given')
      : (p.company || '');
    return '<div class="row"><span class="time">' + relTime(ev.created_at) + '</span>' +
      '<div class="grow"><p class="t">' + escHtml(own(EVENT_NAMES, ev.type) || ev.type) + (who ? ': ' + escHtml(who) : '') + '</p>' +
      '<p class="s">' + escHtml(what) + '</p></div>' +
      ((ev.deliveries || []).map(d => '<span class="tag ' + (tone[d.status] || '') + '" title="' +
        escHtml((hosts[d.endpoint] || 'an endpoint') + (d.error ? ': ' + d.error : '')) + '">' +
        (word[d.status] || escHtml(d.status)) + (d.attempts > 1 ? ' (' + d.attempts + ')' : '') + '</span>').join('') ||
        (eps.length ? '<span class="tag">Queued</span>' : '')) + '</div>';
  }).join('');
  const sample = 'webhooks:\n  - url: https://hooks.example.com/sellbird\n    secret_env: SELLBIRD_WEBHOOK_SECRET\n    events: [reply.received, meeting.booked]   # leave out for all four';
  return '<div class="secs">' +
    '<section class="sec"><h2>Where events go</h2><div class="w">' + epRows +
      '<p class="w-f">Set in ' + escHtml(data.config_file || 'sellbird.yaml') + '. The secret lives in .env, never in that file.</p></div>' +
      '<div class="w pad"><p class="t">Add an endpoint</p>' +
      '<p class="s" style="margin:4px 0 10px">Put this in ' + escHtml(data.config_file || 'sellbird.yaml') + ' and a long random value for the secret in .env. ' +
      'Each request carries a <code>' + escHtml(data.signature_header || 'Sellbird-Signature') + '</code> header: an HMAC-SHA256 of the time and the body, made with your secret.</p>' +
      '<pre class="code-block">' + escHtml(sample) + '</pre></div></section>' +
    '<section class="sec"><h2>Recent events</h2><div class="w">' +
      (evRows || '<div class="row"><div class="grow"><p class="t">Nothing has happened yet</p>' +
        '<p class="s">A new lead, a reply, a booking or a stage change shows up here the moment it happens.</p></div></div>') +
      '<p class="w-f">A failed delivery is retried for about two days, then left alone.</p></div></section></div>';
}

async function testEvents(btn) {
  btn.disabled = true;
  const res = await api('/api/events/test', {method: 'POST'});
  btn.disabled = false;
  if (!res || !res.success) { showToast(failMsg(res, 'Could not send a test event.'), 'error'); return; }
  const bad = (res.results || []).filter(r => !r.ok);
  showToast(bad.length ? bad[0].host + ': ' + bad[0].detail : 'Test event delivered to ' + res.results.length +
    (res.results.length === 1 ? ' endpoint.' : ' endpoints.'), bad.length ? 'error' : 'success');
}

// Wide tables become stacked rows in a narrow frame (app.css). Each cell
// carries its column's name so a bare "3" still reads as "Contacts 3".
function labelTables(root) {
  root.querySelectorAll('table:not(.file-table)').forEach(table => {
    const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
    if (!heads.length) return;
    table.querySelectorAll('tbody tr:not(.detail-row)').forEach(tr => {
      [...tr.children].forEach((td, i) => {
        if (heads[i] && td.dataset.label !== heads[i]) td.dataset.label = heads[i];
      });
    });
  });
}
(function watchTables() {
  const inner = document.getElementById('inner');
  if (!inner || typeof MutationObserver === 'undefined') return;
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; labelTables(inner); });
  }).observe(inner, {childList: true, subtree: true});
})();

// ── Init & live refresh ──

document.body.classList.add('first-load');
showTab(fromHash(), {fromHash: true, focus: false, initial: true});
setTimeout(() => document.body.classList.remove('first-load'), 700);
loadSellbirdStatus();
loadAgentReport();
// The agent chip and the answer lines: what the agent did, kept fresh.
setInterval(() => { if (!document.hidden && !_locked) loadAgentReport(); }, 30000);

// Agent status: quick poll (not while locked: it would only be refused)
setInterval(() => { if (!_locked) loadSellbirdStatus(); }, 8000);

// Live status panel: refreshed while the Today tab is open and visible.
setInterval(() => {
  if (!document.hidden && !_locked && currentTab === 'today') loadLiveStatus();
}, 10000);

// Nav counts stay live wherever you are, so "something needs me" is visible
// from any tab without polling that tab's contents.
setInterval(async () => {
  if (document.hidden || _locked || currentTab === 'today') return;
  const data = await api('/api/today');
  if (!data || data.error) return;
  applyCounts(data);
}, 20000);

// Data tabs: auto-refresh live views without clobbering anything in progress.
// Outbox, settings and help are deliberately excluded — re-rendering the desk
// under someone mid-decision loses their place, and settings may be mid-edit.
setInterval(() => {
  if (document.hidden || _locked) return;
  switch (currentTab) {
    case 'today': loadToday(); loadTrend(); loadFunnel(); loadRuns(); loadTodayActivity(); break;
    case 'calendar': loadCalendar(); break;
    case 'numbers': loadNumbers(); break;
    case 'companies': if (!companyDrill) loadCompanies(); break;
    case 'prospects': loadProspects(); break;
    case 'campaigns': loadCampaigns(); break;
    case 'conversations': loadConversations(); break;
    case 'activity': loadActivity(); break;
    case 'inboxes': loadInboxes(); break;
    case 'usage': loadUsage(); break;
    case 'controls': loadLogs(); break;
  }
}, 15000);


// ── Your company (sellbird.offer): what Sellbird writes from, and the offer ──

let _company = null;
let _offerIdeas = [];

function ce(t) {
  const d = document.createElement('div');
  d.textContent = t == null ? '' : String(t);
  return d.innerHTML;
}

function lines(list) { return (list || []).join('\n'); }
function splitLines(text) { return String(text || '').split('\n').map(x => x.trim()).filter(Boolean); }

async function loadCompany() {
  const body = document.getElementById('company-body');
  const data = await api('/api/company');
  if (!data) { body.innerHTML = offlineState(); return; }
  if (data.error) { body.innerHTML = `<p class="desc">${ce(data.error)}</p>`; return; }
  _company = data;
  const o = data.offer || {}, p = data.product || {}, icp = data.icp || {}, s = data.persona || {};
  const objections = Object.entries(p.objection_responses || {});
  body.innerHTML = `
  <section class="card company-card" aria-labelledby="co-offer-h">
    <div class="company-card-head">
      <h3 id="co-offer-h">Your offer</h3>
      <span class="hint">What every first email ends by offering</span>
    </div>
    ${o.proposed ? `<div class="offer-proposed">
      <div><span class="tag accent">Your agent proposed</span></div>
      <p class="offer-proposed-text">${ce(o.proposed.entry)}</p>
      ${o.proposed.why ? `<p class="desc">${ce(o.proposed.why)}</p>` : ''}
      <div class="offer-actions">
        <button class="btn btn-primary btn-sm" onclick="useProposedOffer()">Use this offer</button>
        <button class="btn btn-secondary btn-sm" onclick="dismissProposedOffer()">Dismiss</button>
      </div>
    </div>` : ''}
    <p class="desc">Each first email names something Sellbird found about the prospect, says what it costs them, and offers this as the fix. Make it free, specific, and something you can deliver this week. ${o.entry ? '' : '<b>No offer yet</b>, so first emails end with a question instead. '}The easiest way to work it out is to ask your coding agent: <i>"Help me work out my Sellbird offer."</i></p>
    <div class="form-group"><label class="form-label" for="offer-entry">Offer</label>
      <textarea class="form-input" id="offer-entry" rows="2" maxlength="300" placeholder="e.g. a written plan for getting you onto page one of Google">${ce(o.entry || '')}</textarea></div>
    <div class="offer-actions">
      <button class="btn btn-primary btn-sm" onclick="saveOffer()">Save offer</button>
      <button class="btn btn-secondary btn-sm" id="offer-preview-btn" onclick="previewOffer()">Preview an email</button>
      <button class="btn btn-secondary btn-sm" id="offer-suggest-btn" onclick="suggestOffers()">Suggest ideas</button>
    </div>
    <div id="offer-preview" class="offer-preview" hidden></div>
    <div id="offer-ideas" class="offer-ideas"></div>
  </section>

  <section class="card company-card" aria-labelledby="co-product-h">
    <div class="company-card-head"><h3 id="co-product-h">What you sell</h3></div>
    <div class="company-grid">
      <div class="form-group"><label class="form-label" for="co-p-name">Product or service</label>
        <input class="form-input" id="co-p-name" value="${ce(p.name)}"></div>
      <div class="form-group"><label class="form-label" for="co-p-pricing">Pricing</label>
        <input class="form-input" id="co-p-pricing" value="${ce(p.pricing)}"></div>
    </div>
    <div class="form-group"><label class="form-label" for="co-p-desc">What it is and who it's for</label>
      <textarea class="form-input" id="co-p-desc" rows="3">${ce(p.description)}</textarea></div>
    <div class="form-group"><label class="form-label" for="co-p-benefits">Key benefits <span class="hint">one per line</span></label>
      <textarea class="form-input" id="co-p-benefits" rows="4">${ce(lines(p.key_benefits))}</textarea></div>
    <div class="offer-actions"><button class="btn btn-primary btn-sm" onclick="saveCompanySection('product')">Save</button></div>
  </section>

  <section class="card company-card" aria-labelledby="co-icp-h">
    <div class="company-card-head"><h3 id="co-icp-h">Who you sell to</h3></div>
    <div class="company-grid">
      <div class="form-group"><label class="form-label" for="co-i-industries">Industries <span class="hint">one per line</span></label>
        <textarea class="form-input" id="co-i-industries" rows="4">${ce(lines(icp.industries))}</textarea></div>
      <div class="form-group"><label class="form-label" for="co-i-titles">Job titles <span class="hint">one per line</span></label>
        <textarea class="form-input" id="co-i-titles" rows="4">${ce(lines(icp.titles))}</textarea></div>
      <div class="form-group"><label class="form-label" for="co-i-size">Company size</label>
        <input class="form-input" id="co-i-size" value="${ce(icp.company_size)}"></div>
      <div class="form-group"><label class="form-label" for="co-i-geo">Where <span class="hint">one per line</span></label>
        <textarea class="form-input" id="co-i-geo" rows="2">${ce(lines(icp.geography))}</textarea></div>
    </div>
    <div class="offer-actions"><button class="btn btn-primary btn-sm" onclick="saveCompanySection('icp')">Save</button></div>
  </section>

  <section class="card company-card" aria-labelledby="co-sender-h">
    <div class="company-card-head"><h3 id="co-sender-h">Who it's from</h3>
      <span class="hint">${ce(s.company)}${s.email ? ' · ' + ce(s.email) : ''}</span></div>
    <div class="company-grid">
      <div class="form-group"><label class="form-label" for="co-s-name">Sender name <span class="hint">signed under every email</span></label>
        <input class="form-input" id="co-s-name" value="${ce(s.name)}"></div>
      <div class="form-group"><label class="form-label" for="co-s-role">Role</label>
        <input class="form-input" id="co-s-role" value="${ce(s.role)}"></div>
    </div>
    <div class="form-group"><label class="form-label" for="co-s-tone">Tone</label>
      <input class="form-input" id="co-s-tone" value="${ce(s.tone)}"></div>
    <div class="offer-actions"><button class="btn btn-primary btn-sm" onclick="saveCompanySection('persona')">Save</button></div>
  </section>

  <section class="card company-card" aria-labelledby="co-obj-h">
    <div class="company-card-head"><h3 id="co-obj-h">Objections and answers</h3>
      <span class="hint">How replies handle pushback</span></div>
    <div id="co-objections" class="company-objections">
      ${(objections.length ? objections : [['', '']]).map(([k, v], i) => objectionRow(k, v, i)).join('')}
    </div>
    <div class="offer-actions">
      <button class="btn btn-secondary btn-sm" onclick="addObjection()">Add an objection</button>
      <button class="btn btn-primary btn-sm" onclick="saveCompanySection('product', true)">Save</button>
    </div>
  </section>

  ${data.knowledge || data.competitors ? `<section class="card company-card" aria-labelledby="co-learned-h">
    <div class="company-card-head"><h3 id="co-learned-h">What Sellbird learned from your site</h3>
      <span class="hint">From training. Retrain with <code>sellbird train &lt;url&gt;</code></span></div>
    ${data.knowledge ? `<details class="company-learned"><summary>Product knowledge</summary><pre>${ce(data.knowledge)}</pre></details>` : ''}
    ${data.competitors ? `<details class="company-learned"><summary>Competitors</summary><pre>${ce(data.competitors)}</pre></details>` : ''}
  </section>` : ''}`;
  _offerIdeas = (o.entry_ideas || []).map(x => ({offer: x}));
  renderOfferIdeas();
  const badge = document.getElementById('nav-company');
  if (badge) badge.textContent = o.proposed ? '1' : '';
}

function objectionRow(k, v, i) {
  return `<div class="company-objection">
    <div class="form-group"><label class="form-label" for="co-ok-${i}">When they say</label>
      <input class="form-input co-ok" id="co-ok-${i}" value="${ce(k)}"></div>
    <div class="form-group"><label class="form-label" for="co-ov-${i}">Answer with</label>
      <textarea class="form-input co-ov" id="co-ov-${i}" rows="2">${ce(v)}</textarea></div>
  </div>`;
}

function addObjection() {
  const box = document.getElementById('co-objections');
  box.insertAdjacentHTML('beforeend', objectionRow('', '', box.children.length));
}

async function saveCompanySection(section, objectionsOnly) {
  const v = id => document.getElementById(id).value;
  let fields;
  if (section === 'product' && objectionsOnly) {
    const out = {};
    document.querySelectorAll('.company-objection').forEach(row => {
      const k = row.querySelector('.co-ok').value.trim(), a = row.querySelector('.co-ov').value.trim();
      if (k && a) out[k] = a;
    });
    fields = {objection_responses: out};
  } else if (section === 'product') {
    fields = {name: v('co-p-name'), pricing: v('co-p-pricing'), description: v('co-p-desc'),
              key_benefits: splitLines(v('co-p-benefits'))};
  } else if (section === 'icp') {
    fields = {industries: splitLines(v('co-i-industries')), titles: splitLines(v('co-i-titles')),
              company_size: v('co-i-size'), geography: splitLines(v('co-i-geo'))};
  } else if (section === 'persona') {
    fields = {name: v('co-s-name'), role: v('co-s-role'), tone: v('co-s-tone')};
  }
  const r = await api('/api/company', {method: 'POST', headers: {'Content-Type': 'application/json'},
                                       body: JSON.stringify({section, fields})});
  if (r && r.success) showToast(r.message, 'success');
  else showToast((r && r.message) || 'Couldn\'t save.', 'error');
}

function renderOfferIdeas() {
  const box = document.getElementById('offer-ideas');
  if (!box) return;
  if (!_offerIdeas.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="form-label">Ideas to start from (click one to put it in the box, then make it yours)</div>' +
    _offerIdeas.map((idea, i) => `<button type="button" class="offer-idea" onclick="useOfferIdea(${i})">
      <span class="offer-idea-text">${ce(idea.offer)}</span>
      ${idea.finding ? `<span class="offer-idea-meta">Pairs with: ${ce(idea.finding)}</span>` : ''}
      ${idea.why ? `<span class="offer-idea-meta">${ce(idea.why)}</span>` : ''}
    </button>`).join('');
}

function useOfferIdea(i) {
  const el = document.getElementById('offer-entry');
  el.value = _offerIdeas[i].offer;
  el.focus();
}

async function suggestOffers() {
  const btn = document.getElementById('offer-suggest-btn');
  btn.disabled = true; btn.textContent = 'Thinking...';
  document.getElementById('offer-ideas').innerHTML =
    '<p class="desc">Sellbird is reading your product and coming up with offers that fit it...</p>';
  const r = await api('/api/offer/suggest', {method: 'POST'});
  btn.disabled = false; btn.textContent = 'Suggest ideas';
  if (!r || r.error || !r.ideas) { renderOfferIdeas(); showToast((r && r.error) || 'Sellbird couldn\'t come up with offers just now. Try again.', 'error'); return; }
  _offerIdeas = r.ideas;
  renderOfferIdeas();
}

async function previewOffer() {
  const entry = document.getElementById('offer-entry').value.trim();
  if (!entry) { showToast('Write an offer first.', 'error'); return; }
  const btn = document.getElementById('offer-preview-btn');
  const box = document.getElementById('offer-preview');
  btn.disabled = true; btn.textContent = 'Writing...';
  box.hidden = false;
  box.innerHTML = '<p class="desc">Writing a sample first email for one of your prospects. Nothing is saved or sent.</p>';
  box.scrollIntoView({block: 'nearest', behavior: 'smooth'});
  const r = await api('/api/offer/preview', {method: 'POST', headers: {'Content-Type': 'application/json'},
                                            body: JSON.stringify({entry})});
  btn.disabled = false; btn.textContent = 'Preview an email';
  if (!r || !r.ok) { box.innerHTML = `<p class="desc">${ce((r && r.message) || 'The preview failed. Try again.')}</p>`; return; }
  box.innerHTML = `<div class="form-label">Sample for ${ce(r.to)} (not saved, not sent)</div>
    <div class="offer-mail"><div class="offer-mail-subject">${ce(r.subject)}</div><pre>${ce(r.body)}</pre></div>`;
  box.scrollIntoView({block: 'nearest', behavior: 'smooth'});
}

async function saveOffer(entryOverride) {
  const entry = entryOverride != null ? entryOverride : document.getElementById('offer-entry').value.trim();
  const r = await api('/api/offer', {method: 'POST', headers: {'Content-Type': 'application/json'},
                                     body: JSON.stringify({entry})});
  if (r && r.success) { showToast(r.message, 'success'); loadCompany(); }
  else showToast((r && r.message) || 'Couldn\'t save the offer.', 'error');
}

async function useProposedOffer() {
  if (_company && _company.offer && _company.offer.proposed) await saveOffer(_company.offer.proposed.entry);
}

async function dismissProposedOffer() {
  await api('/api/offer/propose', {method: 'DELETE'});
  loadCompany();
}

(function wireInboxDialog() {
  const d = document.getElementById('inbox-dialog');
  if (!d) return;
  d.addEventListener('close', () => { if (_inboxPoll) { clearInterval(_inboxPoll); _inboxPoll = null; } });
  d.addEventListener('click', e => { if (e.target === d) closeInboxDialog(); });
})();
