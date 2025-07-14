const xlsx = require('xlsx');
const path = require('path');

function parseExcel() {
  const file = path.join(__dirname, 'uploads', 'app-items.xlsx');
  const workbook = xlsx.readFile(file);

  const productSheet = workbook.Sheets[workbook.SheetNames[0]]; // Usually "Sheet1"
  const imageSheet = workbook.Sheets[workbook.SheetNames[1]];   // Usually "Sheet2"

  const products = xlsx.utils.sheet_to_json(productSheet);
  const images = xlsx.utils.sheet_to_json(imageSheet);

  const imageMap = {};
  for (const img of images) {
    const code = (img['Jewel Code'] || '').trim();
    const url = img['Image URL'] || '';
    if (code && url) {
      imageMap[code] = url;
    }
  }

  const enriched = products.map(row => {
    const jewelCode = (row['Jewel Code'] || '').trim();
    return {
      jewelCode,
      category: row['Category'] || row['Product Name'] || 'Jewellery',
      price: row['Price'],
      available: row['Available'] === 'Yes' || true,
      imageUrl: imageMap[jewelCode] || null
    };
  }).filter(p => p.jewelCode);

  return enriched;
}

module.exports = parseExcel;
