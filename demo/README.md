# Keyhole demo documents

Everything here is synthetic and clearly fictional (fictional people, company, country, bank, addresses, numbers). Nothing is a real document. Each file is marked "SAMPLE - FICTIONAL" and has selectable text (the PNG is an image of the passport page).

## Regenerate and check

```
node demo/make-docs.mjs     # renders demo/files/* with Playwright + Chromium
node demo/check-docs.mjs    # verifies files exist and contain the expected strings (uses pdftotext)
```

## Landlord scenario

Maria Santos wants to rent 14 Harbour Road from Alder & Finch Lettings. She puts her payslip and passport pages in a Keyhole box and shares them with the landlord for 2 hours. The landlord asks "is income at least 3,000 a month?". Instead of the payslip, the landlord gets a claim ("yes, monthly gross income is at least 3,000 GBP") derived from the payslip, and the opening is recorded in a tamper-evident receipt. Maria then ends access, so the landlord can no longer open anything. The lease and bank statement are extra documents for tests that need more than two files, and notes.txt tests the plain-text viewer.

## Files and expected extractor fields

| File | Pages | Fields a rule-based extractor should find |
|---|---|---|
| `payslip-maria-santos.pdf` | 1 | employee name `Maria Santos`; employer `Northgate Studio Ltd`; employee id `NS-00417`; pay period `October 2026`; currency `GBP`; gross pay `3,850.00` (3850.00); income tax `520.20`; National Insurance `241.40`; pension `120.00`; total deductions `881.60`; net pay `2,968.40` (3850.00 - 881.60) |
| `passport-maria-santos.pdf` | 1 | surname `SANTOS`; given names `MARIA`; country `Republic of Northvale` (code `NVL`); document number `NV1234567`; date of birth `1994-03-12`; sex `F`; issue `2021-07-01`; expiry `2031-06-30`; MRZ line 1 `P<NVLSANTOS<<MARIA<<<<<<<<<<<<<<<<<<<<<<<<<<`; MRZ line 2 `NV12345672NVL9403121F3106305<<<<<<<<<<<<<<06` (check digits valid per ICAO 9303 weights 7-3-1) |
| `passport-maria-santos.png` | image | same visible fields as the PDF; no text layer (OCR only) |
| `lease-14-harbour-road.pdf` | 2 | landlord `Alder & Finch Lettings (fictional)`; tenant `Maria Santos`; property `14 Harbour Road, Northvale (fictional)`; monthly rent `1,200.00` GBP; deposit `1,800.00` GBP; start `2026-12-01`; term `12 months` (ends 2027-11-30); page 2: guarantor `Tomas Santos (fictional)`, guarantee cap `14,400.00` |
| `bank-statement-sample.pdf` | 1 | bank `Northvale Savings (fictional)`; holder `Maria Santos`; period `2026-10-01` to `2026-10-31`; opening balance `2,450.00`; 12 transactions (including salary credit `2,968.40` on `2026-10-28`); closing balance `3,591.18` |
| `notes.txt` | text | heading `Keyhole demo notes`; owner `Maria Santos`; phrase `harbour-lantern-7421` |
