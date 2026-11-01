/*
 * Secretum seals: a wax seal drawn from a coin's 32-byte launch hash, so every coin's seal is
 * unique and anyone can redraw it from on-chain data. Three points on the rim turn gold as the
 * certificate is anchored on Monero, Zcash and HyperEVM.
 */
(function (root) {
  'use strict';
  const CHAINS = [
    { bit: 1, name: 'Monero', angle: -150 },
    { bit: 2, name: 'Zcash', angle: -30 },
    { bit: 4, name: 'HyperEVM', angle: 90 },
  ];
  let uid = 0;

  function bytesFrom(hash) {
    if (hash instanceof Uint8Array) return hash;
    if (typeof hash === 'string') {
      const h = hash.replace(/^0x/, '');
      return Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
    }
    return Uint8Array.from(hash);
  }

  /**
   * @param hash        32-byte launch hash (Uint8Array or hex)
   * @param certFlags   bit 0 Monero, bit 1 Zcash, bit 2 HyperEVM
   * @param opts        { size, graduated, label, title }
   */
  function sealSVG(hash, certFlags = 0, opts = {}) {
    const b = bytesFrom(hash);
    const id = 'seal' + ++uid;
    const size = opts.size || 160;
    const c = 100;

    // Irregular wax edge: radius wobbles with the hash.
    const edge = [];
    const n = 40;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 88 + ((b[i % 32] / 255) - 0.5) * 7 + Math.sin(a * 3 + b[3] / 40) * 2.2;
      edge.push([c + Math.cos(a) * r, c + Math.sin(a) * r]);
    }
    // Smooth closed curve through the midpoints, using each wobble point as a control point.
    const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const f = (v) => v.toFixed(1);
    const start = mid(edge[n - 1], edge[0]);
    let edgePath = `M${f(start[0])},${f(start[1])}`;
    for (let i = 0; i < n; i++) {
      const m = mid(edge[i], edge[(i + 1) % n]);
      edgePath += ` Q${f(edge[i][0])},${f(edge[i][1])} ${f(m[0])},${f(m[1])}`;
    }
    edgePath += 'Z';

    // Rosette: petal count, length and twist come from the hash.
    const petals = 6 + (b[0] % 7);
    const twist = (b[1] / 255) * 360;
    const len = 30 + (b[2] % 18);
    const wid = 7 + (b[4] % 7);
    const inner = 10 + (b[5] % 9);
    let rosette = '';
    for (let i = 0; i < petals; i++) {
      const rot = twist + (360 / petals) * i;
      rosette += `<ellipse cx="${c}" cy="${c - inner - len / 2}" rx="${wid}" ry="${len / 2}" transform="rotate(${rot.toFixed(1)} ${c} ${c})"/>`;
    }
    // Second, finer ring of dots
    const dots = 12 + (b[6] % 12);
    let ring = '';
    for (let i = 0; i < dots; i++) {
      const a = ((360 / dots) * i + twist / 2) * (Math.PI / 180);
      ring += `<circle cx="${(c + Math.cos(a) * 62).toFixed(1)}" cy="${(c + Math.sin(a) * 62).toFixed(1)}" r="${(1.6 + (b[(7 + i) % 32] % 3) * 0.5).toFixed(1)}"/>`;
    }

    const marks = CHAINS.map((ch) => {
      const a = ch.angle * (Math.PI / 180);
      const on = (certFlags & ch.bit) !== 0;
      const x = (c + Math.cos(a) * 79).toFixed(1), y = (c + Math.sin(a) * 79).toFixed(1);
      return `<g class="seal-mark${on ? ' on' : ''}"><title>${ch.name}: ${on ? 'certified' : 'pending'}</title>`
        + `<circle cx="${x}" cy="${y}" r="7.5" fill="${on ? `url(#${id}g)` : 'rgba(0,0,0,.28)'}" stroke="${on ? '#f3dfa6' : 'rgba(255,255,255,.18)'}" stroke-width="1"/></g>`;
    }).join('');

    const label = opts.label ? String(opts.label).slice(0, 1).toUpperCase() : '';
    const title = opts.title ? `<title>${escapeXml(opts.title)}</title>` : '';
    return `<svg class="seal" viewBox="0 0 200 200" width="${size}" height="${size}" role="img" aria-label="${escapeXml(opts.title || 'Seal')}">${title}
<defs>
  <radialGradient id="${id}w" cx="38%" cy="32%" r="75%">
    <stop offset="0" stop-color="#d2405a"/><stop offset=".55" stop-color="#a71e36"/><stop offset="1" stop-color="#6c0f20"/>
  </radialGradient>
  <radialGradient id="${id}g" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="#f6e6b4"/><stop offset="1" stop-color="#b58d3c"/></radialGradient>
</defs>
<path d="${edgePath}" fill="url(#${id}w)"/>
<circle cx="${c}" cy="${c}" r="70" fill="none" stroke="#5e0c1b" stroke-opacity=".55" stroke-width="2.5"/>
<circle cx="${c}" cy="${c}" r="70" fill="none" stroke="#f08a9b" stroke-opacity=".18" stroke-width="1" transform="translate(-1 -1)"/>
${opts.graduated ? `<circle cx="${c}" cy="${c}" r="75" fill="none" stroke="url(#${id}g)" stroke-width="2"/>` : ''}
<g fill="#7d1226" fill-opacity=".85">${ring}</g>
<g fill="#86142a" stroke="#e05a70" stroke-opacity=".25" stroke-width=".8">${rosette}</g>
<circle cx="${c}" cy="${c}" r="${inner + 6}" fill="#8f172e" stroke="#5e0c1b" stroke-opacity=".6"/>
${label ? `<text x="${c}" y="${c + 7.5}" text-anchor="middle" font-family="Fell, serif" font-size="${inner + 10}" fill="#f2c9d0" fill-opacity=".85">${escapeXml(label)}</text>` : ''}
${marks}
</svg>`;
  }

  function escapeXml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  root.SecretumSeal = { sealSVG, CHAINS };
})(typeof self !== 'undefined' ? self : this);
