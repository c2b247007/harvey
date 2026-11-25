// ── Dashboard authorisation ──
//
// Every API call needs the token `sellbird dashboard` prints. It arrives once,
// in the link's #fragment (browsers never put fragments in HTTP requests or
// Referer, so it stays out of server and proxy logs), is moved to
// sessionStorage (this tab only, gone when it closes) and replaced in the
// address bar before anything else on the page runs. The browser itself
// sees the full link before then, so its history or extensions may too. It is only ever sent as an
// Authorization header, and only to this origin: never a cookie, never a
// query string, never another host.

const AUTH_KEY = 'sellbird-dashboard-token';
// The key under Harvey, Sellbird's old name: a tab open across the update
// keeps its token instead of being signed out.
const LEGACY_AUTH_KEY = 'harvey-dashboard-token';
const AUTH_TOKEN_RE = /^[A-Za-z0-9_-]{43,128}$/;

// A sign-in link from the agent's browser pane carries a one-use code, not
// the token. It is swapped once for a pane session before any other request
// goes out; a used or expired code leaves the tab locked. (Declared before
// the fragment is read, which may set it.)
var _pendingSignIn = null;
var signInFailed = false;     // the link's code was used already or expired

function takeFragmentToken() {
  const hash = window.location.hash || '';
  if (!hash) return false;
  const params = new URLSearchParams(hash.slice(1));
  const token = params.get('token');
  const code = params.get('code');
  // A fragment with no token or code names a screen ("#outbox"): leave it for app.js.
  if (token === null && code === null) return false;
  // The page to open after a sign-in link: a screen name, or person/<id>.
  const page = (params.get('page') || '').replace(/[^a-z0-9_\/-]/gi, '');
  history.replaceState(null, '', window.location.pathname + window.location.search + (page ? '#' + page : ''));
  if (token && AUTH_TOKEN_RE.test(token)) setAuthToken(token);
  if (code && AUTH_TOKEN_RE.test(code)) { signInFailed = false; _pendingSignIn = redeemSignInCode(code); }
  return true;
}
takeFragmentToken();

// A new link opened in a pane that already shows the dashboard changes only
// the #fragment: take its code too, then show the page it names.
if (window.addEventListener) window.addEventListener('hashchange', () => {
  if (!takeFragmentToken()) return;
  Promise.resolve(_pendingSignIn).then(() => {
    if (typeof showTab === 'function' && typeof fromHash === 'function') showTab(fromHash(), {fromHash: true});
  });
});

function redeemSignInCode(code) {
  return fetch('/api/pane/redeem', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({code: code}),
    mode: 'same-origin', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'same-origin',
  }).then(r => r.ok ? r.json() : null).then(d => {
    if (d && d.token) setAuthToken(d.token);
    else signInFailed = true;
  }).catch(() => {}).finally(() => { _pendingSignIn = null; });
}

function authToken() {
  try {
    let token = sessionStorage.getItem(AUTH_KEY);
    if (!token) {
      token = sessionStorage.getItem(LEGACY_AUTH_KEY);
      if (token) { sessionStorage.setItem(AUTH_KEY, token); sessionStorage.removeItem(LEGACY_AUTH_KEY); }
    }
    return token || '';
  } catch { return ''; }
}

function setAuthToken(token) {
  if (!AUTH_TOKEN_RE.test(token || '')) return false;
  try { sessionStorage.setItem(AUTH_KEY, token); return true; } catch { return false; }
}

function clearAuthToken() {
  try { sessionStorage.removeItem(AUTH_KEY); } catch { /* ignore */ }
}

// A same-origin URL for an absolute path ("/api/..."), or null.
function sameOriginUrl(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') ||
      path.includes('\\')) return null;
  let url;
  try { url = new URL(path, window.location.origin); } catch { return null; }
  return url.origin === window.location.origin ? url : null;
}

// fetch() for this dashboard's own API, with the token attached. Refuses
// anything that isn't same-origin, and never follows redirects.
function authFetch(path, opts) {
  if (_pendingSignIn) return _pendingSignIn.then(() => authFetch(path, opts));
  const url = sameOriginUrl(path);
  if (!url) return Promise.reject(new Error('refusing to send the dashboard token off-origin'));
  const o = Object.assign({}, opts || {});
  const headers = new Headers(o.headers || {});
  const token = authToken();
  if (token) headers.set('Authorization', 'Bearer ' + token);
  o.headers = headers;
  o.mode = 'same-origin';
  o.credentials = 'omit';
  o.cache = 'no-store';
  o.redirect = 'error';
  // Not 'no-referrer': per the Fetch spec that makes a POST's Origin "null"
  // (Safari follows it), and the guard then refuses every action.
  o.referrerPolicy = 'same-origin';
  return fetch(url.href, o);
}
