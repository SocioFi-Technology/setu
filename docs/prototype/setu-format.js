/* Setu Health — shared locale helpers. Load via <script src="lib/setu-format.js"> → window.SetuFormat */
(function () {
  const BN = '০১২৩৪৫৬৭৮৯';
  const toBn = (s) => String(s).replace(/[0-9]/g, (d) => BN[d]);
  const toEn = (s) => String(s).replace(/[০-৯]/g, (d) => BN.indexOf(d));
  const digits = (s, bn) => (bn ? toBn(s) : toEn(s));
  // South Asian grouping: 1,25,000 · 1,25,00,000
  const group = (n) => {
    const [i, f] = Math.abs(n).toFixed(2).split('.');
    const last3 = i.slice(-3), rest = i.slice(0, -3);
    const g = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
    return { int: g, frac: f, neg: n < 0 };
  };
  const taka = (n, o = {}) => {
    const { int, frac, neg } = group(Number(n) || 0);
    const s = (neg ? '−' : '') + '৳ ' + int + (o.paisa || frac !== '00' ? '.' + frac : '');
    return digits(s, o.bn);
  };
  const EN1 = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const EN10 = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const en99 = (n) => (n < 20 ? EN1[n] : EN10[Math.floor(n / 10)] + (n % 10 ? '-' + EN1[n % 10] : ''));
  const BN99 = ('এক দুই তিন চার পাঁচ ছয় সাত আট নয় দশ এগারো বারো তেরো চৌদ্দ পনেরো ষোলো সতেরো আঠারো উনিশ বিশ একুশ বাইশ তেইশ চব্বিশ পঁচিশ ছাব্বিশ সাতাশ আঠাশ ঊনত্রিশ ত্রিশ একত্রিশ বত্রিশ তেত্রিশ চৌত্রিশ পঁয়ত্রিশ ছত্রিশ সাঁইত্রিশ আটত্রিশ ঊনচল্লিশ চল্লিশ একচল্লিশ বিয়াল্লিশ তেতাল্লিশ চুয়াল্লিশ পঁয়তাল্লিশ ছেচল্লিশ সাতচল্লিশ আটচল্লিশ ঊনপঞ্চাশ পঞ্চাশ একান্ন বায়ান্ন তিপ্পান্ন চুয়ান্ন পঞ্চান্ন ছাপ্পান্ন সাতান্ন আটান্ন ঊনষাট ষাট একষট্টি বাষট্টি তেষট্টি চৌষট্টি পঁয়ষট্টি ছেষট্টি সাতষট্টি আটষট্টি ঊনসত্তর সত্তর একাত্তর বাহাত্তর তিয়াত্তর চুয়াত্তর পঁচাত্তর ছিয়াত্তর সাতাত্তর আটাত্তর ঊনআশি আশি একাশি বিরাশি তিরাশি চুরাশি পঁচাশি ছিয়াশি সাতাশি আটাশি ঊননব্বই নব্বই একানব্বই বিরানব্বই তিরানব্বই চুরানব্বই পঁচানব্বই ছিয়ানব্বই সাতানব্বই আটানব্বই নিরানব্বই').split(' ');
  const bn99 = (n) => (n ? BN99[n - 1] : '');
  const words = (amount, lang) => {
    let n = Math.floor(Math.abs(Number(amount) || 0));
    const paisa = Math.round((Math.abs(Number(amount) || 0) - n) * 100);
    const units = lang === 'bn'
      ? [[10000000, 'কোটি'], [100000, 'লক্ষ'], [1000, 'হাজার'], [100, 'শত']]
      : [[10000000, 'crore'], [100000, 'lakh'], [1000, 'thousand'], [100, 'hundred']];
    const f99 = lang === 'bn' ? bn99 : en99;
    const parts = [];
    const crore = Math.floor(n / 10000000);
    if (crore) { parts.push((crore > 99 ? words(crore, lang).replace(/ (টাকা মাত্র|taka only)$/, '') : f99(crore)) + ' ' + units[0][1]); n %= 10000000; }
    for (const [v, w] of units.slice(1)) { const q = Math.floor(n / v); if (q) { parts.push(f99(q) + ' ' + w); n %= v; } }
    if (n) parts.push(f99(n));
    let s = parts.join(' ') || (lang === 'bn' ? 'শূন্য' : 'zero');
    if (lang === 'bn') return s + ' টাকা' + (paisa ? ' ' + bn99(paisa) + ' পয়সা' : '') + ' মাত্র';
    s = s.charAt(0).toUpperCase() + s.slice(1);
    return s + ' taka' + (paisa ? ' and ' + en99(paisa) + ' paisa' : '') + ' only';
  };
  const pad = (x) => String(x).padStart(2, '0');
  const date = (d, bn) => { d = d instanceof Date ? d : new Date(d); return digits(`${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`, bn); };
  const parseDate = (s) => { const m = toEn(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (!m) return null; const d = new Date(+m[3], +m[2] - 1, +m[1]); return d.getMonth() === +m[2] - 1 ? d : null; };
  const age = (dob, ref = new Date()) => {
    let y = ref.getFullYear() - dob.getFullYear(), m = ref.getMonth() - dob.getMonth(), d = ref.getDate() - dob.getDate();
    if (d < 0) { m--; d += new Date(ref.getFullYear(), ref.getMonth(), 0).getDate(); }
    if (m < 0) { y--; m += 12; }
    return { y, m, d, future: dob > ref };
  };
  const ageLabel = (a, lang) => lang === 'bn' ? toBn(`${a.y} বছর ${a.m} মাস ${a.d} দিন`) : `${a.y}y ${a.m}m ${a.d}d`;
  const phone = (raw, bn) => {
    const d = toEn(raw).replace(/\D/g, '').replace(/^880/, '').replace(/^0/, '');
    const s = d.length ? '+880 ' + d.slice(0, 4) + (d.length > 4 ? '-' + d.slice(4, 10) : '') : '';
    return { text: digits(s, bn), valid: /^1[3-9]\d{8}$/.test(d), digits: d };
  };
  // Dose pattern "১+০+১" (morning+noon+night); accepts 1+0+1, 1-0-1, ½ and 4-slot patterns
  const dose = (raw) => {
    const parts = toEn(raw).replace(/[-–\s]+/g, '+').split('+').filter((x) => x !== '');
    const ok = (parts.length === 3 || parts.length === 4) && parts.every((p) => /^(\d(\.5)?|½)$/.test(p));
    const nums = parts.map((p) => (p === '½' ? 0.5 : parseFloat(p)));
    return { ok, parts, perDay: ok ? nums.reduce((a, b) => a + b, 0) : 0, bn: toBn(parts.join('+')) };
  };
  window.SetuFormat = { toBn, toEn, digits, taka, words, date, parseDate, age, ageLabel, phone, dose, group };
})();
