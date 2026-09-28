// Display formats for binary cells ({ b: hex, n: byteLength }). Shared by the webviews and unit tests.
(function (root) {
  const MODES = [
    ['hex', 'Hex'],
    ['uuid', 'UUID'],
    ['uuidSwapped', 'UUID (swapped)'],
    ['text', 'Text (UTF-8)'],
    ['base64', 'Base64'],
  ];

  const isBinary = (v) => v !== null && typeof v === 'object' && typeof v.b === 'string';

  function bytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  const dashed = (h) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

  /**
   * uuidSwapped reverses MySQL UUID_TO_BIN(u, 1), which stores time_hi, time_mid, time_low
   * (in that order) so ordered UUIDs index well. UUID modes fall back to hex unless 16 bytes.
   */
  function format(v, mode) {
    const cut = v.b.length < v.n * 2 ? `… (${v.n} bytes)` : '';
    if ((mode === 'uuid' || mode === 'uuidSwapped') && v.n === 16) {
      const h = v.b;
      return dashed(mode === 'uuid' ? h : h.slice(8, 16) + h.slice(4, 8) + h.slice(0, 4) + h.slice(16));
    }
    if (mode === 'text') return new TextDecoder('utf-8').decode(bytes(v.b)) + cut;
    if (mode === 'base64') return btoa(String.fromCharCode(...bytes(v.b))) + cut;
    return '0x' + v.b + cut;
  }

  /** "auto" shows UUIDs when every binary value of the column is 16 bytes long. */
  function resolve(mode, cells) {
    if (mode && mode !== 'auto') return mode;
    const bin = cells.filter(isBinary);
    return bin.length > 0 && bin.every((c) => c.n === 16) ? 'uuid' : 'hex';
  }

  const api = { MODES, isBinary, format, resolve };
  root.SqlBinary = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
