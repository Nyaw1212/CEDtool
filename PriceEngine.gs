const PriceEngine = (() => {
  function getMetadata() {
    return {
      id: 'price',
      name: 'Price Engine',
      version: '0.1.0',
      actions: ['list', 'search', 'findBySku', 'compare']
    };
  }

  function getSheet_() {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName(CONFIG.SHEETS.PRICE_LIST);

    if (!sheet) {
      throw new Error(`Sheet "${CONFIG.SHEETS.PRICE_LIST}" was not found.`);
    }

    return sheet;
  }

  function normalizePrice_(value) {
    if (typeof value === 'number') return value;

    const cleaned = String(value == null ? '' : value)
      .replace(/[$,\s]/g, '')
      .trim();

    if (!cleaned) return null;

    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeSku_(value) {
    return String(value == null ? '' : value).trim().toUpperCase();
  }

  function createItem_(row, rowNumber) {
    return {
      rowNumber,
      sku: normalizeSku_(row[0]),
      description: String(row[1] == null ? '' : row[1]).trim(),
      price: normalizePrice_(row[2]),
      extPrice: normalizePrice_(row[3])
    };
  }

  function list() {
    const sheet = getSheet_();
    const lastRow = sheet.getLastRow();

    if (lastRow < 2) {
      return { success: true, count: 0, items: [] };
    }

    const rows = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
    const items = rows
      .map((row, index) => createItem_(row, index + 2))
      .filter(item => item.sku);

    return { success: true, count: items.length, items };
  }

  function search(payload) {
    const query = String(payload.query || '').trim().toLowerCase();
    const result = list();

    if (!query) return result;

    const items = result.items.filter(item =>
      item.sku.toLowerCase().includes(query) ||
      item.description.toLowerCase().includes(query)
    );

    return { success: true, count: items.length, query, items };
  }

  function findBySku(payload) {
    const sku = normalizeSku_(payload.sku);
    if (!sku) throw new Error('SKU is required.');

    const item = list().items.find(entry => entry.sku === sku) || null;
    return { success: true, found: Boolean(item), item };
  }

  function compare(payload) {
    const inputItems = Array.isArray(payload.items) ? payload.items : [];
    const skuMap = new Map(list().items.map(item => [item.sku, item]));

    const results = inputItems.map(input => {
      const sku = normalizeSku_(input.sku);
      const current = skuMap.get(sku) || null;
      const newPrice = normalizePrice_(input.price);

      if (!current) {
        return {
          sku,
          description: String(input.description || '').trim(),
          status: 'NEW',
          currentPrice: null,
          newPrice,
          difference: null,
          percentDifference: null
        };
      }

      const currentPrice = current.price;
      const difference = currentPrice == null || newPrice == null
        ? null
        : newPrice - currentPrice;
      const percentDifference = difference == null || currentPrice === 0
        ? null
        : (difference / currentPrice) * 100;

      let status = 'UNCHANGED';
      if (difference > 0) status = 'INCREASED';
      if (difference < 0) status = 'DECREASED';

      return {
        sku,
        description: current.description,
        status,
        currentPrice,
        newPrice,
        difference,
        percentDifference
      };
    });

    return { success: true, count: results.length, results };
  }

  return { getMetadata, list, search, findBySku, compare };
})();
