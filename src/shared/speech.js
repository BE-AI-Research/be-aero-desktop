// Turn an assistant reply (Markdown, symbols, abbreviations, units) into
// plain sentences a speech engine reads naturally. Engines like Piper
// (espeak phonemes) and Windows SAPI read "e.g." as "eg", "&" as nothing,
// "50%" oddly and "API" as a word; lists and tables lose their pauses.
// Pure and shared: the renderer uses it, tests import it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AeroSpeech = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Spoken letter by letter (otherwise engines try to pronounce them).
  const SPELL = new Set(('AI API APIs CPU CPUs GPU GPUs URL URLs USB UI UX OS PC PCs ID IDs PDF PDFs SQL HTML CSS JS TS ' +
    'TTS STT LLM LLMs MCP LAN WAN VPN DNS IP SSD HDD FAQ CEO CTO AWS RGB UTC EST PST CST GMT USA UK EU CLI SDK IDE ' +
    'HTTP HTTPS SSH FTP TCP UDP CSV XML YAML PNG JPG JPEG SVG MP3 MP4 GB MB KB TB PR QA HD UHD TV PIN OTP CDN DB VM VMs ' +
    'NPM CI CD ETA FYI IIRC TBD TBA ASAP AM PM BTW IMO IMHO DIY HR PS AC DC').split(/\s+/));
  // Read as words even though they are all caps.
  const WORDS = new Set('NASA RAM ROM GIF JSON SAPI LED NATO SIM WIFI RAID SCSI SATA UNESCO OPEC'.split(' '));

  const ABBR = [
    [/\be\.g\.,?/gi, 'for example,'], [/\bi\.e\.,?/gi, 'that is,'], [/\betc\./gi, 'et cetera.'],
    [/\bvs\.?(?=\s)/gi, 'versus'], [/\bapprox\.?(?=\s)/gi, 'approximately'], [/\baka\b/gi, 'also known as'],
    [/\bw\/o\b/gi, 'without'], [/\bw\/(?=\s)/gi, 'with'], [/\bincl\.(?=\s)/gi, 'including'],
    [/\bmax\.(?=\s)/gi, 'maximum'], [/\bmin\.(?=\s)/gi, 'minimum'], [/\bavg\.?(?=\s)/gi, 'average'],
    [/\bdept\.(?=\s)/gi, 'department'], [/\best\.(?=\s)/gi, 'estimated'], [/\bfig\.(?=\s)/gi, 'figure'],
    [/\bNo\.\s*(?=\d)/g, 'number '], [/\bno\.\s*(?=\d)/g, 'number '], [/\bpp\.\s*(?=\d)/g, 'pages '], [/\bp\.\s*(?=\d)/g, 'page '],
    [/\bJan\.(?=\s)/g, 'January'], [/\bFeb\.(?=\s)/g, 'February'], [/\bAug\.(?=\s)/g, 'August'], [/\bSept?\.(?=\s)/g, 'September'],
    [/\bOct\.(?=\s)/g, 'October'], [/\bNov\.(?=\s)/g, 'November'], [/\bDec\.(?=\s)/g, 'December'],
    [/\bMon\.(?=\s)/g, 'Monday'], [/\bTue\.(?=\s)/g, 'Tuesday'], [/\bWed\.(?=\s)/g, 'Wednesday'], [/\bThu\.(?=\s)/g, 'Thursday'], [/\bFri\.(?=\s)/g, 'Friday']
  ];

  // Units, only right after a number ("16 GB", "200ms", "3.5GHz").
  const UNITS = {
    ms: 'milliseconds', s: 'seconds', sec: 'seconds', secs: 'seconds', min: 'minutes', mins: 'minutes', h: 'hours', hr: 'hours', hrs: 'hours',
    kb: 'kilobytes', mb: 'megabytes', gb: 'gigabytes', tb: 'terabytes', kib: 'kibibytes', mib: 'mebibytes', gib: 'gibibytes',
    kbps: 'kilobits per second', mbps: 'megabits per second', gbps: 'gigabits per second',
    hz: 'hertz', khz: 'kilohertz', mhz: 'megahertz', ghz: 'gigahertz', fps: 'frames per second', px: 'pixels', dpi: 'D P I',
    mm: 'millimeters', cm: 'centimeters', m: 'meters', km: 'kilometers', in: 'inches', ft: 'feet', mi: 'miles',
    mg: 'milligrams', g: 'grams', kg: 'kilograms', lb: 'pounds', lbs: 'pounds', oz: 'ounces',
    ml: 'milliliters', l: 'liters', mph: 'miles per hour', kph: 'kilometers per hour', kmh: 'kilometers per hour',
    w: 'watts', kw: 'kilowatts', kwh: 'kilowatt hours', v: 'volts', mah: 'milliamp hours', k: 'thousand'
  };

  const CURRENCY = { $: 'dollars', '€': 'euros', '£': 'pounds', '¥': 'yen', '₹': 'rupees' };

  function spellOut(w) { return w.replace(/s$/, (m) => (w.length > 2 && /[A-Z]s$/.test(w) ? '\u0000' : m)).split('').filter((c) => c !== '\u0000').join(' ') + (/[A-Z]s$/.test(w) && w.length > 2 ? "'s" : ''); }

  function host(url) {
    const m = /^(?:https?:\/\/)?(?:www\.)?([^/?#:]+)/i.exec(url);
    return m ? m[1].replace(/\./g, ' dot ') : 'a link';
  }

  // ---- Markdown -> lines of plain text, each ending in punctuation.
  function structure(md) {
    let s = String(md || '').replace(/\r\n?/g, '\n');
    s = s.replace(/```[\s\S]*?(```|$)/g, '\nThere is a code example here.\n');
    s = s.replace(/<[^>\n]{1,200}>/g, ' ');                       // html tags
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt) => (alt ? ` image: ${alt}. ` : ' '));
    s = s.replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1');               // [text](url) -> text
    s = s.replace(/<?(https?:\/\/[^\s)>]+)>?/g, (_m, u) => ` a link to ${host(u)} `);
    const out = [];
    for (let line of s.split('\n')) {
      line = line.trim();
      if (!line) { out.push(''); continue; }
      if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line)) continue;      // table separator
      if (/^\|.*\|$/.test(line)) line = line.slice(1, -1).split('|').map((c) => c.trim()).filter(Boolean).join(', ');
      line = line.replace(/^#{1,6}\s+/, '').replace(/^>\s?/, '').replace(/^(?:[-*+•]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s+/, '');
      line = line.replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2').replace(/~~(.+?)~~/g, '$1');
      line = line.replace(/`([^`]+)`/g, (_m, c) => ` ${identifier(c)} `);
      if (line && !/[.!?:;,]$/.test(line)) line += '.';
      out.push(line);
    }
    return out.join('\n');
  }

  // `set_settings` -> "set settings", `fetchUrl` -> "fetch url", "app.js" -> "app dot J S"
  function identifier(c) {
    return String(c)
      .replace(/\b([\w-]+)\.([a-z]{1,4})\b/gi, (m, a, ext) => (/^\d+$/.test(a) && /^\d+$/.test(ext) ? m : `${a} dot ${ext.length <= 3 ? ext.toUpperCase().split('').join(' ') : ext}`))
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_]+/g, ' ')
      .replace(/^--?/, '');
  }

  // ---- Symbols, numbers, abbreviations, acronyms.
  function words(s) {
    for (const [re, rep] of ABBR) s = s.replace(re, rep);
    s = s
      .replace(/(\d)\s*[-–—]\s*(\d)/g, '$1 to $2')                       // 1-30
      .replace(/(\d)\s*[x×]\s*(\d)/g, '$1 by $2')                        // 1920x1080, 3 x 4
      .replace(/\b(\d+(?:\.\d+)?)x\b/g, '$1 times')                      // 3x
      .replace(/(\d)\s*%/g, '$1 percent')
      .replace(/([$€£¥₹])\s?(\d[\d,]*(?:\.\d+)?)(\s?[kKmMbB]n?\b)?/g, (_m, c, n, mult) => {
        const scale = mult ? ({ k: ' thousand', m: ' million', b: ' billion', bn: ' billion' }[mult.trim().toLowerCase()] || '') : '';
        return `${n}${scale} ${CURRENCY[c]}`;
      })
      .replace(/(\d)\s?°\s?C\b/g, '$1 degrees Celsius').replace(/(\d)\s?°\s?F\b/g, '$1 degrees Fahrenheit').replace(/(\d)\s?°/g, '$1 degrees')
      .replace(/#(\d+)/g, 'number $1')
      .replace(/~\s?(\d)/g, 'about $1')
      .replace(/(\d)\s*\+\s*(\d)/g, '$1 plus $2').replace(/(\d)\+(?=\s|$)/g, '$1 or more')
      .replace(/(\d)\s*=\s*(\d)/g, '$1 equals $2')
      .replace(/(\d)\s*\/\s*(\d)(?!\d*\/)/g, '$1 out of $2')
      .replace(/\b(\d+(?:\.\d+)?)\s?([a-zA-Z]{1,4})\b/g, (m, n, u) => {
        const name = UNITS[u.toLowerCase()];
        if (!name) return m;
        if ((u === 'm' || u === 'M') && /^\d+$/.test(n) && false) return m;
        if (u === 'in' || u === 'm' || u === 's' || u === 'g' || u === 'l' || u === 'v' || u === 'w' || u === 'h' || u === 'k') {
          // single letters are only units when glued to the number ("5m", "20s")
          if (/\s/.test(m)) return m;
        }
        return `${n} ${name}`;
      })
      .replace(/(\d),(\d{3})\b/g, '$1$2');                                 // 1,000 -> 1000 (engines read the comma as a pause)

    s = s
      .replace(/\s*(?:->|=>|→|⟶)\s*/g, ' to ').replace(/\s*(?:<-|←)\s*/g, ' from ').replace(/\s*↔\s*/g, ' and ')
      .replace(/\s*&\s*/g, ' and ').replace(/\s*≈\s*/g, ' approximately ').replace(/\s*≠\s*/g, ' is not ')
      .replace(/\s*≤\s*/g, ' at most ').replace(/\s*≥\s*/g, ' at least ').replace(/\s+<\s+/g, ' less than ').replace(/\s+>\s+/g, ' greater than ')
      .replace(/\b([\w.+-]+)@([\w-]+(?:\.[\w-]+)+)\b/g, (_m, u, d) => `${u.replace(/[._]/g, ' ')} at ${d.replace(/\./g, ' dot ')}`)
      .replace(/\s@(\w)/g, ' at $1')
      // Rates before the generic slash: "$5/mo", "60 km/h", "10 MB/s", "2x/day".
      .replace(/\/\s?(mo|month|yr|year|wk|week|day|hr|hour|h|min|minute|s|sec|second|user|person|seat|ea|each)\b/gi, (_m, u) => ` per ${{ mo: 'month', yr: 'year', wk: 'week', hr: 'hour', h: 'hour', min: 'minute', s: 'second', sec: 'second', ea: 'item', each: 'item' }[u.toLowerCase()] || u.toLowerCase()}`)
      .replace(/\b(km|mi|m|mb|gb|kb|tb)\s?per\b/gi, (_m, u) => `${UNITS[u.toLowerCase()]} per`)
      .replace(/(\w)\/(\w)/g, (m, a, b) => `${a} or ${b}`)
      .replace(/…|\.\.\./g, ', ')
      .replace(/\s[-–—]{1,2}\s/g, ', ')                                      // dashes used as pauses
      .replace(/[\p{Extended_Pictographic}️‍]/gu, '')            // emoji
      .replace(/[*_#|^`\\{}[\]<>~=+]/g, ' ');

    // File names in running text: "notes.txt" -> "notes dot T X T".
    s = s.replace(/\b([A-Za-z][\w-]*)\.(png|jpe?g|gif|svg|webp|pdf|js|ts|jsx|tsx|json|txt|md|html?|css|exe|msi|zip|csv|py|sh|ps1|bat|mp3|mp4|wav|docx?|xlsx?|pptx?|ya?ml|log|ini|cfg|conf|xml|tar|gz)\b/gi,
      (_m, name, ext) => `${name.replace(/[_]+/g, ' ')} dot ${/^(json|yaml|conf)$/i.test(ext) ? ext.toLowerCase() : ext.toUpperCase().split('').join(' ')}`);

    // Acronyms and identifiers left in running text.
    s = s.replace(/\b[A-Z][A-Za-z]*\b/g, (w) => {
      if (WORDS.has(w.toUpperCase())) return w;
      if (SPELL.has(w)) return w.endsWith('s') && w.length > 2 && /[A-Z]s$/.test(w) ? `${w.slice(0, -1).split('').join(' ')}'s` : w.split('').join(' ');
      if (/^[A-Z]{2,5}$/.test(w) && !/[AEIOUY]/.test(w)) return w.split('').join(' ');   // no vowels: spell (HTTP, CPU)
      return w;
    });
    s = s.replace(/\b([a-z]+)_([a-z_]+)\b/g, (m) => m.replace(/_/g, ' '));
    return s;
  }

  function toSpeech(text, max = 4000) {
    const lines = structure(text).split('\n').map((l) => words(l).replace(/\s+([.,!?;:])/g, '$1').replace(/\s{2,}/g, ' ').trim());
    let out = '';
    for (const l of lines) {
      if (!l || /^[.,;:]+$/.test(l)) continue;
      out += (out ? ' ' : '') + l;
    }
    out = out.replace(/([.!?])\s*\./g, '$1').replace(/,\s*([.!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
    return out.slice(0, max);
  }

  return { toSpeech, structure, words, identifier };
});
