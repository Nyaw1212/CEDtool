const ParserEngine = (() => {
  function getMetadata() {
    return {
      id: 'parser',
      name: 'Invoice Parser Engine',
      version: '0.1.1',
      actions: ['parseInvoice']
    };
  }

  function parseInvoice(payload) {
    const text = String(payload && payload.text ? payload.text : '').trim();

    if (!text) {
      throw new Error('Invoice text is required.');
    }

    const catalog = PriceEngine.list().items;
    const catalogMap = new Map(catalog.map(item => [normalizeSku_(item.sku), item]));
    const knownSkus = catalog
      .map(item => normalizeSku_(item.sku))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);

    const lines = normalizeLines_(text);
    const starts = findItemStarts_(lines, knownSkus);
    const items = [];

    starts.forEach((start, index) => {
      const end = index + 1 < starts.length ? starts[index + 1].lineIndex : lines.length;
      const blockLines = lines.slice(start.lineIndex, end);
      const item = parseItemBlock_(blockLines, start, catalogMap);

      if (item && item.sku && item.price != null) {
        items.push({
          ...item,
          sourceOrder: items.length + 1,
          sourceLine: start.lineIndex + 1
        });
      }
    });

    const invoiceNumberMatch = text.match(/INVOICE\s+NO\.\s+INVOICE\s+DATE[\s\S]*?(\d+\s*-\s*\d+)\s+(\d{2}\/\d{2}\/\d{2,4})/i);

    return {
      success: true,
      invoice: {
        number: invoiceNumberMatch ? invoiceNumberMatch[1].replace(/\s+/g, ' ') : '',
        date: invoiceNumberMatch ? invoiceNumberMatch[2] : ''
      },
      count: items.length,
      matchedCount: items.filter(item => item.catalogMatch).length,
      newSkuCount: items.filter(item => !item.catalogMatch).length,
      items
    };
  }

  function normalizeLines_(text) {
    return String(text)
      .replace(/\r/g, '')
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  function findItemStarts_(lines, knownSkus) {
    const starts = [];

    lines.forEach((line, lineIndex) => {
      if (!/^T\s+\d+(?:\.\d+)?\s+/i.test(line)) return;

      const upperLine = line.toUpperCase();
      const knownSku = knownSkus.find(sku => containsSku_(upperLine, sku));

      if (knownSku) {
        starts.push({ lineIndex, sku: knownSku, source: 'CATALOG_ANCHOR' });
        return;
      }

      const fallback = line.match(/^T\s+(\d+(?:\.\d+)?)\s+([A-Z0-9&.-]+)\s+(\S+)/i);
      if (!fallback) return;

      const vendor = fallback[2].toUpperCase();
      const sku = normalizeSku_(fallback[3]);

      if (vendor === 'MISC' || !looksLikeSku_(sku)) return;

      starts.push({ lineIndex, sku, source: 'LINE_PATTERN' });
    });

    return starts;
  }

  function parseItemBlock_(blockLines, start, catalogMap) {
    const firstLine = blockLines[0] || '';
    const flat = blockLines.join(' ');
    const catalogItem = catalogMap.get(normalizeSku_(start.sku)) || null;

    const orderedMatch = firstLine.match(/^T\s+(\d+(?:\.\d+)?)\s+/i);
    const orderedQty = orderedMatch ? Number(orderedMatch[1]) : null;

    const priceMatches = Array.from(flat.matchAll(/(?:^|\s)(\d+(?:\.\d+)?)\s+([\d,]+\.\d{2})\s+E\s+([\d,]+\.\d{2})(?:\s|$)/gi));
    const priceMatch = priceMatches.length ? priceMatches[priceMatches.length - 1] : null;

    if (!priceMatch) return null;

    const shippedQty = Number(priceMatch[1]);
    const price = toNumber_(priceMatch[2]);
    const extPrice = toNumber_(priceMatch[3]);
    const invoiceDescription = extractDescription_(flat, start.sku, priceMatch.index);

    return {
      sku: normalizeSku_(start.sku),
      description: catalogItem ? catalogItem.description : invoiceDescription,
      invoiceDescription,
      quantityOrdered: orderedQty,
      quantityShipped: shippedQty,
      price,
      extPrice,
      catalogMatch: Boolean(catalogItem),
      catalogPrice: catalogItem ? catalogItem.price : null,
      catalogExtPrice: catalogItem ? catalogItem.extPrice : null,
      matchSource: start.source,
      sourceText: blockLines.join('\n')
    };
  }

  function extractDescription_(flat, sku, priceIndex) {
    const upperFlat = flat.toUpperCase();
    const upperSku = normalizeSku_(sku);
    const skuIndex = upperFlat.indexOf(upperSku);

    if (skuIndex < 0) return '';

    const start = skuIndex + upperSku.length;
    const end = typeof priceIndex === 'number' && priceIndex > start ? priceIndex : flat.length;

    return flat
      .slice(start, end)
      .replace(/^\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function containsSku_(upperLine, sku) {
    const escaped = sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'i').test(upperLine);
  }

  function looksLikeSku_(sku) {
    return sku.length >= 3 && /[A-Z]/.test(sku) && /[0-9-]/.test(sku);
  }

  function normalizeSku_(value) {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toUpperCase();
  }

  function toNumber_(value) {
    const number = Number(String(value == null ? '' : value).replace(/,/g, ''));
    return Number.isFinite(number) ? number : null;
  }

  return { getMetadata, parseInvoice };
})();
