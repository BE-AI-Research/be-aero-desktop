// Update notifier: watches the project's GitHub releases and tells the user
// when a newer build is published. Deliberately notify-only - no silent
// downloads, no auto-install. The user clicks through to the release page
// and decides for themselves.
const { net } = require('electron');

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;   // a few times a day is plenty
const TIMEOUT_MS = 10000;

// "v1.2.3" / "1.2.3" -> [1, 2, 3]; junk -> null.
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// -1 | 0 | 1, null when either side is unparseable.
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function isNewer(remote, current) {
  return compareVersions(remote, current) === 1;
}

// The fields we use from GitHub's "latest release" response. Draft and
// prerelease entries never reach /latest, so everything here is a real
// published build.
function parseLatestRelease(json) {
  if (!json || typeof json !== 'object') return null;
  const version = typeof json.tag_name === 'string' ? json.tag_name : null;
  const url = typeof json.html_url === 'string' && /^https:\/\/github\.com\//.test(json.html_url)
    ? json.html_url : null;
  if (!version || !url) return null;
  return {
    version,
    url,
    name: typeof json.name === 'string' ? json.name.slice(0, 120) : version
  };
}

// owner/repo from a package.json repository field in its common shapes.
function repoSlug(repository) {
  const raw = typeof repository === 'string' ? repository
    : repository && typeof repository.url === 'string' ? repository.url : '';
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#].*)?$/.exec(raw)
    || /^([\w.-]+)\/([\w.-]+)$/.exec(raw);
  return m ? `${m[1]}/${m[2]}` : null;
}

// One check against GitHub. Resolves to:
//   { state: 'update', release }   a newer published build exists
//   { state: 'current' }           up to date
//   { state: 'none' }              repo has no published releases yet
//   { state: 'error', message }    network / API trouble (never throws)
async function checkLatest(slug, currentVersion, fetchImpl) {
  if (!slug) return { state: 'error', message: 'no repository configured' };
  const doFetch = fetchImpl || ((url, opts) => net.fetch(url, opts));
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await doFetch(`https://api.github.com/repos/${slug}/releases/latest`, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'be-aero-desktop-update-check' }
    });
    clearTimeout(timer);
    if (res.status === 404) return { state: 'none' };
    if (!res.ok) return { state: 'error', message: `GitHub answered ${res.status}` };
    const release = parseLatestRelease(await res.json());
    if (!release) return { state: 'error', message: 'unexpected response shape' };
    return isNewer(release.version, currentVersion)
      ? { state: 'update', release }
      : { state: 'current', release };
  } catch (err) {
    return { state: 'error', message: err && err.name === 'AbortError' ? 'timed out' : String(err && err.message || err) };
  }
}

module.exports = {
  checkLatest, parseVersion, compareVersions, isNewer, parseLatestRelease, repoSlug,
  CHECK_EVERY_MS
};
