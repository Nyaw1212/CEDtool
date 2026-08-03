const ParserEngine = (() => {
  function getMetadata() {
    return {
      id: 'parser',
      name: 'Invoice and Quote Parser Engine',
      version: '0.2.0',
      actions: ['parseInvoice']
    };
  }

  function parseInvoice(payload) {
    const text = String(payload && payload.text ? payload.text : '').trim();

    if (!text) {
      throw new Error('Invoice or quote text is required.');
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

    const documentInfo = extractDocumentInfo_(text);

    return {
      success: true,
      documentType: documentInfo.type,
      invoice: {
        number: documentInfo.number,
        date: documentInfo.date
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
      const invoiceStart = /^T\s+\d+(?:\.\d+)?\s+/i.test(line);
      const quoteInlineStart = /^\d{1,3}\s+[A-Z][A-Z0-9&.-]+\s+/i.test(line);
      const quoteSplitStart = /^\d{1,3}$/.test(line);

      if (!invoiceStart && !quoteInlineStart && !quoteSplitStart) return;

      const knownSku = findKnownSkuNear_(lines, lineIndex, knownSkus, quoteSplitStart ? 6 : 3);

      if (knownSku) {
        starts.push({
          lineIndex,
          sku: knownSku,
          source: quoteSplitStart ? 'CATALOG_ANCHOR_SPLIT' : 'CATALOG_ANCHOR'
        });
        return;
      }

      if (invoiceStart) {
        const fallback = line.match(/^T\s+(\d+(?:\.\d+)?)\s+([A-Z0-9&.-]+)\s+(\S+)/i);
        if (!fallback) return;

        const vendor = fallback[2].toUpperCase();
        const sku = normalizeSku_(fallback[3]);

        if (vendor === 'MISC' || !looksLikeSku_(sku)) return;
        starts.push({ lineIndex, sku, source: 'INVOICE_LINE_PATTERN' });
        return;
      }

      if (quoteInlineStart) {
        const fallback = line.match(/^\d{1,3}\s+([A-Z][A-Z0-9&.-]+)\s+(\S+)/i);
        if (!fallback) return;

        const sku = normalizeSku_(fallback[2]);
        if (!looksLikeSku_(sku)) return;
        starts.push({ lineIndex, sku, source: 'QUOTE_LINE_PATTERN' });
        return;
      }

      if (quoteSplitStart) {
        const nextLine = lines[lineIndex + 1] || '';
        const fallback = nextLine.match(/^[A-Z][A-Z0-9&.-]+\s+(\S+)/i);
        if (!fallback) return;

        const sku = normalizeSku_(fallback[1]);
        if (!looksLikeSku_(sku)) return;
        starts.push({ lineIndex, sku, source: 'QUOTE_SPLIT_PATTERN' });
      }
    });

    return dedupeStarts_(starts);
  }

  function findKnownSkuNear_(lines, lineIndex, knownSkus, windowSize) {
    const windowText = lines
      .slice(lineIndex, Math.min(lines.length, lineIndex + windowSize))
      .join(' ')
      .toUpperCase();

    const compactWindow = compactSku_(windowText);

    for (const sku of knownSkus) {
      if (containsSku_(windowText, sku) || compactWindow.includes(compactSku_(sku))) {
        return sku;
      }
    }

    return '';
  }

  function dedupeStarts_(starts) {
    const seen = new Set();

    return starts.filter(start => {
      if (seen.has(start.lineIndex)) return false;
      seen.add(start.lineIndex);
      return true;
    });
  }

  function parseItemBlock_(blockLines, start, catalogMap) {
    const firstLine = blockLines[0] || '';
    const flat = blockLines.join(' ');
    const catalogItem = catalogMap.get(normalizeSku_(start.sku)) || null;

    const invoiceQtyMatch = firstLine.match(/^T\s+(\d+(?:\.\d+)?)\s+/i);
    const fullPriceMatches = Array.from(flat.matchAll(
      /(?:^|\s)(\d+(?:\.\d+)?)\s+\$?([\d,]+\.\d{2})\s+E\s+\$?([\d,]+\.\d{2})(?:\s|$)/gi
    ));

    const fullPriceMatch = fullPriceMatches.length ? fullPriceMatches[0] : null;
    let shippedQty = null;
    let price = null;
    let extPrice = null;
    let priceIndex = null;

    if (fullPriceMatch) {
      shippedQty = Number(fullPriceMatch[1]);
      price = toNumber_(fullPriceMatch[2]);
      extPrice = toNumber_(fullPriceMatch[3]);
      priceIndex = fullPriceMatch.index;
    } else {
      const partialPriceMatch = flat.match(
        /(?:^|\s)(\d+(?:\.\d+)?)\s+\$?([\d,]+\.\d{2})\s+E(?:\s|$)/i
      );

      if (!partialPriceMatch) return null;

      shippedQty = Number(partialPriceMatch[1]);
      price = toNumber_(partialPriceMatch[2]);
      extPrice = shippedQty != null && price != null
        ? Number((shippedQty * price).toFixed(2))
        : null;
      priceIndex = partialPriceMatch.index;
    }

    const orderedQty = invoiceQtyMatch ? Number(invoiceQtyMatch[1]) : shippedQty;
    const invoiceDescription = extractDescription_(flat, start.sku, priceIndex);

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

    if (skuIndex >= 0) {
      const start = skuIndex + upperSku.length;
      const end = typeof priceIndex === 'number' && priceIndex > start ? priceIndex : flat.length;

      return flat
        .slice(start, end)
        .replace(/^\s+/, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    return '';
  }

  function extractDocumentInfo_(text) {
    const invoiceMatch = text.match(
      /INVOICE\s+NO\.\s+INVOICE\s+DATE[\s\S]*?(\d+\s*-\s*\d+)\s+(\d{2}\/\d{2}\/\d{2,4})/i
    );

    if (invoiceMatch) {
      return {
        type: 'INVOICE',
        number: invoiceMatch[1].replace(/\s+/g, ' '),
        date: invoiceMatch[2]
      };
    }

    const quoteNumberMatch = text.match(/\b(Q\d{5,})\b/i);
    const quoteDateMatch = text.match(/Quote Date:[\s\S]{0,160}?(\d{2}\/\d{2}\/\d{2,4})/i);

    return {
      type: quoteNumberMatch ? 'QUOTE' : 'DOCUMENT',
      number: quoteNumberMatch ? quoteNumberMatch[1].toUpperCase() : '',
      date: quoteDateMatch ? quoteDateMatch[1] : ''
    };
  }

  function containsSku_(upperLine, sku) {
    const escaped = sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'i').test(upperLine);
  }

  function compactSku_(value) {
    return String(value == null ? '' : value)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  function looksLikeSku_(sku) {
    return sku.length >= 3 && /[A-Z]/.test(sku) && /[0-9-]/.test(sku);
  }

  function normalizeSku_(value) {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toUpperCase();
  }

  function toNumber_(value) {
    const number = Number(String(value == null ? '' : value).replace(/[$,]/g, ''));
    return Number.isFinite(number) ? number : null;
  }

  return { getMetadata, parseInvoice };
})();
