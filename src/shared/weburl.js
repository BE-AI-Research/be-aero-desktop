// Small URL helpers for web widgets, shared by main (certificate exemptions,
// frame-failure routing) and the renderer (matching a failure to its pane).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AeroWebUrl = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // host:port key for a url, with the default port made explicit so
  // "https://a" and "https://a:443" compare equal. Null for unparseable input.
  function hostKey(url) {
    try {
      const u = new URL(String(url));
      if (!/^https?:$/.test(u.protocol)) return null;
      const port = u.port || (u.protocol === 'https:' ? '443' : '80');
      return `${u.hostname.toLowerCase()}:${port}`;
    } catch { return null; }
  }

  // Does a navigated/failed url belong to a widget configured at base?
  // Redirects commonly hop to a www. or regional subdomain, so a subdomain of
  // the configured host still counts as the same widget.
  function sameSite(baseUrl, otherUrl) {
    const a = hostKey(baseUrl);
    const b = hostKey(otherUrl);
    if (!a || !b) return false;
    if (a === b) return true;
    // The looser subdomain comparison still requires the same port: another
    // port on the same device is a different service, not the same site.
    const portA = a.slice(a.lastIndexOf(':') + 1);
    const portB = b.slice(b.lastIndexOf(':') + 1);
    if (portA !== portB) return false;
    const hostA = a.slice(0, a.lastIndexOf(':')).replace(/^www\./, '');
    const hostB = b.slice(0, b.lastIndexOf(':')).replace(/^www\./, '');
    return hostA === hostB || hostB.endsWith(`.${hostA}`) || hostA.endsWith(`.${hostB}`);
  }

  // Human wording for the Chromium net error codes a pane is likely to hit.
  function describeLoadError(code, description) {
    switch (code) {
      case -27:   // ERR_BLOCKED_BY_RESPONSE
        return 'This site refuses to be embedded (X-Frame-Options / frame-ancestors). That is the site’s choice — it cannot be shown in a widget.';
      case -3:    // ERR_ABORTED - usually a redirect or the site cancelling; not fatal
        return null;
      case -105:  // ERR_NAME_NOT_RESOLVED
        return 'The address could not be found. Check the host name.';
      case -102:  // ERR_CONNECTION_REFUSED
        return 'The device refused the connection. Is the service running on that port?';
      case -118:  // ERR_CONNECTION_TIMED_OUT
      case -7:    // ERR_TIMED_OUT
        return 'The connection timed out. The device may be off, or a firewall may be dropping it.';
      case -109:  // ERR_ADDRESS_UNREACHABLE
        return 'The address is unreachable from this machine.';
      case -200: case -201: case -202: case -203: case -204: case -205: case -206: case -210: case -213:
        return 'The site’s certificate was rejected. For LAN devices with self-signed certificates this should clear after the widget is re-added — certificates are only accepted for addresses you added yourself.';
      case -106:  // ERR_INTERNET_DISCONNECTED
        return 'No internet connection.';
      default:
        return `The page failed to load (${description || code}).`;
    }
  }

  return { hostKey, sameSite, describeLoadError };
});
