// Generates synthetic, clearly fictional demo documents into demo/files/.
// Usage: node demo/make-docs.mjs   (needs Playwright + Chromium)
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'files');
mkdirSync(OUT, { recursive: true });

const money = (n) => n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const base = `
@page { size: A4; margin: 0 }
* { box-sizing: border-box }
body { font-family: Helvetica, Arial, sans-serif; color: #222; margin: 0; font-size: 12px }
.page { width: 210mm; height: 297mm; padding: 16mm 16mm 22mm; position: relative; overflow: hidden; page-break-after: always }
.page:last-child { page-break-after: auto }
.wm { position: absolute; top: 45%; left: 50%; transform: translate(-50%,-50%) rotate(-35deg); font-size: 64px; font-weight: bold; color: rgba(200,0,0,0.10); white-space: nowrap; z-index: 0 }
.hdr { border-bottom: 2px solid #345; padding-bottom: 6px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: baseline }
.hdr b { font-size: 18px }
.tag { color: #a00; font-weight: bold; font-size: 11px }
.ftr { position: absolute; bottom: 10mm; left: 16mm; right: 16mm; border-top: 1px solid #999; padding-top: 4px; font-size: 10px; color: #a00; text-align: center }
table { width: 100%; border-collapse: collapse; margin: 8px 0 }
th, td { border: 1px solid #bbb; padding: 5px 7px; text-align: left }
th { background: #eef1f5 }
td.r, th.r { text-align: right }
h2 { font-size: 14px; margin: 16px 0 4px }
p { line-height: 1.45; margin: 5px 0 }
`;
const wrap = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>${base}</style></head><body>${body}</body></html>`;
const frame = (title, inner, tag = 'SAMPLE - FICTIONAL', footer = 'SAMPLE - FICTIONAL - generated demo data, not a real document') => `
<div class="page"><div class="wm">SAMPLE - FICTIONAL</div>
<div class="hdr"><b>${title}</b><span class="tag">${tag}</span></div>${inner}
<div class="ftr">${footer}</div></div>`;

// 1. Payslip
const gross = 3850.0, tax = 520.2, ni = 241.4, pension = 120.0;
const net = gross - tax - ni - pension;
if (net.toFixed(2) !== '2968.40') throw new Error('payslip arithmetic wrong: ' + net);
const payslip = wrap(frame('Northgate Studio Ltd (fictional) - PAYSLIP', `
<table><tr><th>Employee name</th><td>Maria Santos</td><th>Employee ID</th><td>NS-00417</td></tr>
<tr><th>Employer</th><td>Northgate Studio Ltd</td><th>Pay period</th><td>October 2026 (01 Oct 2026 - 31 Oct 2026)</td></tr>
<tr><th>Tax code</th><td>1257L (fictional)</td><th>Pay date</th><td>2026-10-28</td></tr>
<tr><th>NI number</th><td>ZZ 99 99 99 Z (fictional)</td><th>Currency</th><td>GBP</td></tr></table>
<h2>Earnings</h2>
<table><tr><th>Description</th><th class="r">Amount (GBP)</th></tr>
<tr><td>Basic monthly salary</td><td class="r">${money(gross)}</td></tr>
<tr><th>Gross pay</th><th class="r">${money(gross)}</th></tr></table>
<h2>Deductions</h2>
<table><tr><th>Description</th><th class="r">Amount (GBP)</th></tr>
<tr><td>Income tax (PAYE)</td><td class="r">${money(tax)}</td></tr>
<tr><td>National Insurance</td><td class="r">${money(ni)}</td></tr>
<tr><td>Employee pension contribution</td><td class="r">${money(pension)}</td></tr>
<tr><th>Total deductions</th><th class="r">${money(tax + ni + pension)}</th></tr></table>
<h2>Net pay</h2>
<table><tr><th>Net pay (paid to account ending 0000, fictional)</th><th class="r">${money(net)}</th></tr></table>
<p>Gross pay ${money(gross)} - deductions ${money(tax + ni + pension)} = net pay ${money(net)} GBP.</p>`));

// 2. Passport
const W = [7, 3, 1];
const val = (c) => (c === '<' ? 0 : /[0-9]/.test(c) ? +c : c.charCodeAt(0) - 55);
const chk = (s) => String([...s].reduce((a, c, i) => a + val(c) * W[i % 3], 0) % 10);
const pad = (s, n) => s.padEnd(n, '<');
const docNo = 'NV1234567', dob = '940312', exp = '310630', pers = '<'.repeat(14);
const l1 = pad('P<NVLSANTOS<<MARIA', 44);
const l2core = docNo + chk(docNo) + 'NVL' + dob + chk(dob) + 'F' + exp + chk(exp) + pers + chk(pers);
const l2 = l2core + chk(docNo + chk(docNo) + dob + chk(dob) + exp + chk(exp) + pers + chk(pers));
if (l1.length !== 44 || l2.length !== 44) throw new Error('MRZ length');
const esc = (s) => s.replace(/</g, '&lt;');
const passportBody = `
<style>.pp{width:210mm;height:140mm;padding:10mm 12mm;position:relative;overflow:hidden;background:#e9f0e6;border:1px solid #567}
.pp .row{display:flex;gap:10mm}.ph{width:38mm;height:48mm;border:1px solid #567;background:#cfd8cf;position:relative}
.ph svg{width:100%;height:100%}.f{margin:3px 0;font-size:11px}.f span{display:block;font-size:8px;color:#555}.f b{font-size:13px}
.mrz{position:absolute;left:12mm;right:12mm;bottom:8mm;font-family:"Courier New",monospace;font-size:14.4px;letter-spacing:0.5px;background:#fff;padding:4px 6px;border:1px solid #999;white-space:pre;line-height:1.35}
.pp .wm{position:absolute;top:40%;left:50%;transform:translate(-50%,-50%) rotate(-20deg);font-size:44px;font-weight:bold;color:rgba(200,0,0,0.10);white-space:nowrap}.pp .tg{position:absolute;top:3mm;right:12mm;color:#a00;font-weight:bold;font-size:11px}</style>
<div class="pp"><div class="wm">SAMPLE - FICTIONAL</div>
<div class="tg">SAMPLE - FICTIONAL - NOT A REAL DOCUMENT</div>
<div style="font-size:15px;font-weight:bold;margin-bottom:6px">REPUBLIC OF NORTHVALE (fictional) - PASSPORT</div>
<div class="row"><div class="ph"><svg viewBox="0 0 100 130"><circle cx="50" cy="48" r="20" fill="#8a9a8a"/><path d="M10 130 C10 85 90 85 90 130Z" fill="#8a9a8a"/></svg></div>
<div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:0 8mm">
<div class="f"><span>Type / Country code</span><b>P / NVL</b></div><div class="f"><span>Document number</span><b>${docNo}</b></div>
<div class="f"><span>Surname</span><b>SANTOS</b></div><div class="f"><span>Given names</span><b>MARIA</b></div>
<div class="f"><span>Nationality</span><b>NORTHVALIAN (fictional)</b></div><div class="f"><span>Date of birth</span><b>1994-03-12</b></div>
<div class="f"><span>Sex</span><b>F</b></div><div class="f"><span>Place of birth</span><b>NORTHVALE CITY (fictional)</b></div>
<div class="f"><span>Date of issue</span><b>2021-07-01</b></div><div class="f"><span>Date of expiry</span><b>2031-06-30</b></div>
</div></div>
<div class="mrz">${esc(l1)}\n${esc(l2)}</div></div>`;
const passportHtml = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:210mm 140mm;margin:0}*{box-sizing:border-box}body{margin:0;font-family:Helvetica,Arial,sans-serif;color:#222}</style></head><body>${passportBody}</body></html>`;

// 3. Lease
const lease = wrap(
  frame('Residential Tenancy Agreement (fictional) - page 1 of 2', `
<p><b>Landlord:</b> Alder &amp; Finch Lettings (fictional)<br><b>Tenant:</b> Maria Santos<br>
<b>Property:</b> 14 Harbour Road, Northvale (fictional)</p>
<table><tr><th>Monthly rent</th><td>GBP ${money(1200)}</td></tr><tr><th>Deposit</th><td>GBP ${money(1800)}</td></tr>
<tr><th>Start date</th><td>2026-12-01</td></tr><tr><th>Term</th><td>12 months (ending 2027-11-30)</td></tr></table>
<h2>1. Rent</h2><p>The Tenant shall pay rent of GBP 1,200.00 per month in advance on the first day of each month.</p>
<h2>2. Deposit</h2><p>The Tenant shall pay a deposit of GBP 1,800.00, to be held in a fictional protection scheme and returned at the end of the term less any agreed deductions.</p>
<h2>3. Use of the property</h2><p>The property is let as a private residence only. The Tenant shall keep it clean and in good repair and shall not sublet without written consent.</p>
<h2>4. Utilities</h2><p>The Tenant is responsible for electricity, gas, water and council tax during the term.</p>
<h2>5. Notice</h2><p>Either party may end the tenancy after the fixed term by giving two months written notice.</p>
<p><i>This agreement is invented for software demonstration. It has no legal effect.</i></p>`, 'SAMPLE - FICTIONAL', 'SAMPLE - FICTIONAL - generated demo data, not a real lease - page 1 of 2') +
  frame('Residential Tenancy Agreement (fictional) - page 2 of 2', `
<h2>6. Access and inspection</h2><p>The Landlord may inspect the property on 24 hours notice at reasonable times.</p>
<h2>7. Termination for breach</h2><p>If rent is more than 14 days overdue the Landlord may serve notice as provided in this fictional agreement.</p>
<h2>8. Guarantor</h2>
<table><tr><th>Guarantor name</th><td>Tomas Santos (fictional)</td></tr><tr><th>Relationship to tenant</th><td>Brother (fictional)</td></tr>
<tr><th>Guarantor address</th><td>3 Example Lane, Northvale (fictional)</td></tr></table>
<p>The Guarantor guarantees payment of rent by the Tenant under this agreement up to GBP 14,400.00.</p>
<h2>Signatures</h2>
<table><tr><th>Landlord (Alder &amp; Finch Lettings, fictional)</th><td>____________________ Date: 2026-11-20</td></tr>
<tr><th>Tenant (Maria Santos)</th><td>____________________ Date: 2026-11-20</td></tr>
<tr><th>Guarantor</th><td>____________________ Date: 2026-11-20</td></tr></table>`, 'SAMPLE - FICTIONAL', 'SAMPLE - FICTIONAL - generated demo data, not a real lease - page 2 of 2'));

// 4. Bank statement
const open = 2450.0;
const tx = [
  ['2026-10-01', 'Standing order - Rent (fictional landlord)', -1000.0],
  ['2026-10-03', 'Corner Grocer (fictional)', -62.35],
  ['2026-10-05', 'Transit pass (fictional)', -64.0],
  ['2026-10-08', 'Cafe Northvale (fictional)', -14.8],
  ['2026-10-12', 'Utilities Co (fictional) direct debit', -88.5],
  ['2026-10-15', 'Refund - Bookshop (fictional)', 22.99],
  ['2026-10-18', 'Streaming service (fictional)', -9.99],
  ['2026-10-21', 'Supermarket (fictional)', -74.12],
  ['2026-10-24', 'Mobile phone (fictional)', -25.0],
  ['2026-10-28', 'Salary - Northgate Studio Ltd (fictional)', 2968.4],
  ['2026-10-29', 'Transfer to savings pot (fictional)', -500.0],
  ['2026-10-30', 'Pharmacy (fictional)', -11.45],
];
let bal = open;
const rows = tx.map(([d, t, a]) => { bal = Math.round((bal + a) * 100) / 100; return `<tr><td>${d}</td><td>${t}</td><td class="r">${a < 0 ? money(-a) : ''}</td><td class="r">${a > 0 ? money(a) : ''}</td><td class="r">${money(bal)}</td></tr>`; }).join('');
const closing = bal;
const bank = wrap(frame('Northvale Savings (fictional) - ACCOUNT STATEMENT', `
<table><tr><th>Account holder</th><td>Maria Santos</td><th>Account number</th><td>00000000 (fictional)</td></tr>
<tr><th>Statement period</th><td>2026-10-01 to 2026-10-31</td><th>Currency</th><td>GBP</td></tr></table>
<table><tr><th>Date</th><th>Description</th><th class="r">Out</th><th class="r">In</th><th class="r">Balance</th></tr>
<tr><td>2026-10-01</td><td>Opening balance</td><td></td><td></td><td class="r">${money(open)}</td></tr>${rows}
<tr><th colspan="4">Closing balance 2026-10-31</th><th class="r">${money(closing)}</th></tr></table>
<p>Opening balance GBP ${money(open)}. Closing balance GBP ${money(closing)}.</p>`));

const notes = `Keyhole demo notes (SAMPLE - FICTIONAL)
=======================================
This is a plain text file used to test the Keyhole viewer.
Owner: Maria Santos (fictional)
Reminder: viewing window for the landlord is 2 hours.
Secret phrase for tests: harbour-lantern-7421
`;
writeFileSync(join(OUT, 'notes.txt'), notes);

const browser = await chromium.launch();
const page = await browser.newPage();
const pdf = async (html, name) => {
  await page.setContent(html);
  await page.pdf({ path: join(OUT, name), printBackground: true, preferCSSPageSize: true });
};
await pdf(payslip, 'payslip-maria-santos.pdf');
await pdf(passportHtml, 'passport-maria-santos.pdf');
await pdf(lease, 'lease-14-harbour-road.pdf');
await pdf(bank, 'bank-statement-sample.pdf');
await page.setViewportSize({ width: 794, height: 530 });
await page.setContent(passportHtml);
await page.locator('.pp').screenshot({ path: join(OUT, 'passport-maria-santos.png') });
await browser.close();
console.log('MRZ:\n' + l1 + '\n' + l2);
console.log('closing balance', money(closing));
