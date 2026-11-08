import * as XLSX from 'xlsx';

export const exportToExcel = (data: any[] | any[][], fileName: string, sheetName: string = "Sheet1") => {
  if (!data || data.length === 0) return;
  let ws: XLSX.WorkSheet;
  if (Array.isArray(data[0])) {
    ws = XLSX.utils.aoa_to_sheet(data as any[][]);
  } else {
    ws = XLSX.utils.json_to_sheet(data as any[]);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const cleanName = fileName.replace(/\.xlsx$/i, '');
  XLSX.writeFile(wb, `${cleanName}.xlsx`);
};
