const SkuCorrectionEngine = (() => {
  function getMetadata() {
    return {
      id: 'parser',
      name: 'Greentech SKU-Corrected Parser',
      version: '0.7.5',
      actions: ['parseInvoice']
    };
  }

  function parseInvoice(payload) {
    const result = QuoteParserEngine.parseInvoice(payload);
    const catalog = PriceEngine.list().items || [];

    const items = (result.items || []).map(item => {
      const correctedSku = extractNumberedHeaderSku_(item.sourceText) || item.parsedSku || item.sku || '';
      const exactMatch = findExactCatalogMatch_(correctedSku, catalog);

      return {
        ...item,
        parsedSku: correctedSku,
        sku: correctedSku,
        spaSku: exactMatch ? exactMatch.sku : (item.spaSku || ''),
        catalogMatch: exactMatch ? true : Boolean(item.catalogMatch),
        catalogPrice: exactMatch ? exactMatch.price : item.catalogPrice,
        catalogExtPrice: exactMatch && exactMatch.extPrice != null
          ? exactMatch.extPrice
          : item.catalogExtPrice,
        matchSource: exactMatch ? 'EXACT_NUMBERED_HEADER_SKU' : item.matchSource,
        matchScore: exactMatch ? 1 : item.matchScore
      };
    });

    return {
      ...result,
      count: items.length,
      matchedCount: items.filter(item => item.catalogMatch).length,
      newSkuCount: items.filter(item => !item.catalogMatch).length,
      items
    };
  }

  function extractNumberedHeaderSku_(sourceText) {
    const lines = String(sourceText || '')
      .replace(/\r/g, '')
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    for (const line of lines) {
      const match = line.match(/^\d{1,3}\s+([A-Z][A-Z0-9&.-]{1,15})\s+(.+)$/i);
      if (!match) continue;

      const vendor = match[1].toUpperCase();
      const productText = match[2].trim().toUpperCase();

      // Q.TRON module product codes legitimately contain spaces.
      if (vendor === 'QCELL' && /^Q\.TRON\b/.test(productText)) {
        return productText;
      }

      // Standard quote rows use: line number + vendor + one-token SKU.
      const firstToken = productText.split(/\s+/)[0];
      if (looksLikeSku_(firstToken)) return firstToken;
    }

    return '';
  }

  function findExactCatalogMatch_(sku, catalog) {
    const target = compact_(sku);
    if (!target) return null;

    return catalog.find(item => compact_(item.sku) === target) || null;
  }

  function looksLikeSku_(value) {
    const text = String(value || '').toUpperCase();
    return text.length >= 3 && /[A-Z]/.test(text) && /[0-9]/.test(text);
  }

  function compact_(value) {
    return String(value == null ? '' : value)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  return { getMetadata, parseInvoice };
})();
