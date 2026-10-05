// Excel and PDF renderers for the monthly roster. Input is the plain object built by rosterData() in server.js.
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const FALLBACK = { work: '#cfe8e4', off: '#e3e6ea', leave: '#f7cfd4', other: '#e8f0d8' };
const colorOf = c => (c.color || FALLBACK[c.category] || FALLBACK.other);
const shiftLine = s => `Shift ${s.name}: ${s.start_time}-${s.end_time}` + (s.report_time ? `, report ${s.report_time}` : '') +
  (s.opening_start ? `, opening ${s.opening_start}-${s.opening_end}` : '') + (s.handover_start ? `, handover ${s.handover_start}-${s.handover_end}` : '') +
  (s.closing_start ? `, closing from ${s.closing_start}` : '');

async function toXlsx(data, paper, out) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Roster', { pageSetup: { orientation: 'landscape', paperSize: paper === 'A3' ? 8 : 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.addRow([data.dept]).font = { bold: true, size: 14 };
  ws.addRow([`Housekeeping Roster - ${data.monthName} ${data.year}`]).font = { bold: true, size: 12 };
  ws.addRow([]);
  const hr = ws.addRow(['NAME', ...data.days.map(x => `${x.d} ${DOW[x.dow]}`)]);
  hr.font = { bold: true }; hr.alignment = { horizontal: 'center', wrapText: true };
  const thin = { style: 'thin', color: { argb: 'FF999999' } };
  data.staff.forEach(s => {
    const r = ws.addRow([s.name, ...s.cells.map(c => (c ? c.code : ''))]);
    r.getCell(1).font = { bold: true };
    for (let i = 1; i <= data.n + 1; i++) {
      const cell = r.getCell(i); cell.border = { top: thin, left: thin, bottom: thin, right: thin };
      if (i > 1) { cell.alignment = { horizontal: 'center' }; const c = s.cells[i - 2]; if (c) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + colorOf(c).replace('#', '') } }; }
    }
  });
  ws.getColumn(1).width = 18;
  for (let i = 2; i <= data.n + 1; i++) ws.getColumn(i).width = 6.5;
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 4 }];
  ws.addRow([]); ws.addRow(['Legend']).font = { bold: true };
  data.codes.forEach(c => { const r = ws.addRow([c.code, c.label]); r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + colorOf(c).replace('#', '') } }; });
  ws.addRow([]); data.shifts.forEach(s => ws.addRow([shiftLine(s)]));

  const sm = wb.addWorksheet('Summary');
  sm.addRow(['Staff', ...data.codes.map(c => c.code), 'Off days', 'Leave days', 'Blank days', 'Working days']).font = { bold: true };
  data.staff.forEach(s => sm.addRow([s.name, ...data.codes.map(c => s.counts[c.code] || 0), s.off, s.leave, s.blank, s.working]));
  sm.getColumn(1).width = 18;

  const du = wb.addWorksheet('Duties');
  du.addRow(['Date', 'Staff', 'Code', 'Residence', 'Duty description', 'Duties']).font = { bold: true };
  data.duties.forEach(d => du.addRow([d.date, d.staff, d.code, d.residence || '', d.note || '', d.duties || '']));
  [12, 18, 8, 22, 36, 50].forEach((w, i) => { du.getColumn(i + 1).width = w; });
  await wb.xlsx.write(out);
}

function toPdf(data, paper, out) {
  const doc = new PDFDocument({ size: paper === 'A3' ? 'A3' : 'A4', layout: 'landscape', margin: 24 });
  doc.pipe(out);
  const L = 24, W = doc.page.width - 48, nameW = 96, dayW = (W - nameW) / data.n, rowH = data.staff.length > 24 ? 14 : 18, fs = Math.min(8, Math.max(5, dayW * 0.5));
  const cellText = (t, x, y, w, h, size, bold) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor('#000').text(t, x, y + (h - size) / 2 + 0.5, { width: w, align: 'center', lineBreak: false });
  const title = () => {
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#000').text(data.dept, L, 24, { lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(11).text(`Housekeeping Roster - ${data.monthName} ${data.year}`, L, 42, { lineBreak: false });
    return 62;
  };
  const head = y => {
    doc.rect(L, y, nameW, 26).fillAndStroke('#ffffff', '#999'); cellText('NAME', L, y, nameW, 26, 8, true);
    data.days.forEach((x, i) => {
      const px = L + nameW + i * dayW, we = x.dow === 0 || x.dow === 6;
      doc.rect(px, y, dayW, 26).fillAndStroke(we ? '#dde2e8' : '#ffffff', '#999');
      cellText(String(x.d), px, y + 2, dayW, 10, fs, true); cellText(DOW[x.dow], px, y + 13, dayW, 10, Math.max(4, fs - 2), false);
    });
    return y + 26;
  };
  let y = head(title());
  data.staff.forEach(s => {
    if (y + rowH > doc.page.height - 60) { doc.addPage(); y = head(24); }
    doc.rect(L, y, nameW, rowH).fillAndStroke('#ffffff', '#999'); cellText(s.name, L, y, nameW, rowH, 8, true);
    s.cells.forEach((c, i) => {
      const px = L + nameW + i * dayW;
      doc.rect(px, y, dayW, rowH).fillAndStroke(c ? colorOf(c) : '#ffffff', '#999');
      if (c) cellText(c.code, px, y, dayW, rowH, fs, true);
    });
    y += rowH;
  });
  if (y + 90 > doc.page.height - 30) { doc.addPage(); y = 24; }
  y += 10; doc.font('Helvetica-Bold').fontSize(8).fillColor('#000').text('Legend', L, y, { lineBreak: false }); y += 12;
  let x = L;
  data.codes.forEach(c => {
    const label = `${c.code} = ${c.label}`, w = doc.font('Helvetica').fontSize(8).widthOfString(label) + 26;
    if (x + w > L + W) { x = L; y += 14; }
    doc.rect(x, y, 10, 10).fillAndStroke(colorOf(c), '#999'); doc.fillColor('#000').text(label, x + 14, y + 1, { lineBreak: false }); x += w;
  });
  y += 18; data.shifts.forEach(s => { doc.font('Helvetica').fontSize(8).fillColor('#000').text(shiftLine(s), L, y, { lineBreak: false }); y += 11; });
  y += 8;
  const cols = ['Staff', ...data.codes.map(c => c.code), 'Off', 'Leave', 'Working'], cw = Math.min(60, (W - 120) / (cols.length - 1));
  if (y + (data.staff.length + 2) * 12 > doc.page.height - 24) { doc.addPage(); y = 24; }
  const line = (vals, bold) => { vals.forEach((v, i) => { const px = i === 0 ? L : L + 120 + (i - 1) * cw; doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor('#000').text(String(v), px, y, { width: i === 0 ? 116 : cw, align: i === 0 ? 'left' : 'center', lineBreak: false }); }); y += 12; };
  line(cols, true);
  data.staff.forEach(s => { if (y > doc.page.height - 30) { doc.addPage(); y = 24; } line([s.name, ...data.codes.map(c => s.counts[c.code] || 0), s.off, s.leave, s.working], false); });
  doc.end();
}
module.exports = { toXlsx, toPdf };
