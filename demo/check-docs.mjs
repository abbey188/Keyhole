// Verifies generated demo files exist and contain expected text. Regenerates nothing.
import { readFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = join(dirname(fileURLToPath(import.meta.url)), 'files');
const checks = {
  'payslip-maria-santos.pdf': ['Maria Santos', 'Northgate Studio Ltd', 'October 2026', '3,850.00', '2,968.40', 'NS-00417', 'SAMPLE - FICTIONAL'],
  'passport-maria-santos.pdf': ['NV1234567', '1994-03-12', '2031-06-30', 'REPUBLIC OF NORTHVALE', 'NOT A REAL DOCUMENT', 'P<NVLSANTOS<<MARIA'],
  'passport-maria-santos.png': [],
  'lease-14-harbour-road.pdf': ['Alder & Finch Lettings', '14 Harbour Road', '1,200.00', '1,800.00', '2026-12-01', '12 months', 'Guarantor'],
  'bank-statement-sample.pdf': ['Northvale Savings', 'Closing balance', 'Salary'],
  'notes.txt': ['Keyhole demo notes'],
};
let fail = 0;
for (const [f, keys] of Object.entries(checks)) {
  const p = join(DIR, f);
  const errs = [];
  if (!existsSync(p)) errs.push('missing');
  else {
    const buf = readFileSync(p);
    if (f !== 'notes.txt' && statSync(p).size <= 5 * 1024) errs.push('size <= 5KB');
    if (f.endsWith('.pdf')) {
      if (!buf.subarray(0, 8).toString('latin1').includes('%PDF')) errs.push('no %PDF header');
      let text = '';
      try { text = execFileSync('pdftotext', ['-layout', p, '-'], { encoding: 'utf8' }); } catch { errs.push('pdftotext unavailable/failed'); }
      text = text.replace(/\s+/g, ' ');
      for (const k of keys) if (!text.includes(k)) errs.push('missing text: ' + k);
    } else if (f.endsWith('.png')) {
      if (buf.subarray(1, 4).toString() !== 'PNG') errs.push('not PNG');
    } else {
      const t = buf.toString('utf8');
      for (const k of keys) if (!t.includes(k)) errs.push('missing text: ' + k);
    }
  }
  console.log(`${errs.length ? 'FAIL' : 'PASS'} ${f}${errs.length ? ' - ' + errs.join('; ') : ''}`);
  if (errs.length) fail++;
}
process.exit(fail ? 1 : 0);
