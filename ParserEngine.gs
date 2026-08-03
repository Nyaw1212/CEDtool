const ParserEngine = (() => {
  const MAX_SKU_LINES = 4;
  const FOOTER_PATTERN = /^(MERCHANDISE:|TAX:|TOTAL:|PLEASE NOTE:|TERMS AND CONDITIONS|\d+ OF \d+|\* PER |REVISION #:)/i;
  const HEADER_PATTERN = /^(LN|PRODUCT|DESCRIPTION|QTY|PRICE|PER \*|EXT PRICE|QUOTE:)$/i;

  function getMetadata() {
    return {
      id: 'parser',
      name: 'SPA SKU Quote Parser',
      version: '0.3.0',
      actions: ['parseInvoice']
    };
  }

  function parseInvoice(payload) {
    const text = String(payload && payload.text ? payload.text : '').trim();
    if (!text) throw new Error('Quote text is required.');

    const catalog = PriceEngine.list().items || [];
    const catalogItems = catalog
      .map(item => ({
        ...item,
        normalizedSku: normalizeSku_(item.sku),
        compactSku: compactSku_(item.sku)
      }))
      .filter(item => item.normalizedSku && item.compactSku.length >= 4)
      .sort((a, b) => b.compactSku.length - a.compactSku.length);

    const lines = normalizeLines_(text);
    const anchors = findSkuAnchors_(lines, catalogItems);
    const items = [];

    anchors.forEach((anchor, index) => {
      const nextAnchor = anchors[index + 1];
      const endIndex = nextAnchor
        ? nextAnchor.lineIndex
        : findDocumentEnd_(lines, anchor.lineIndex + anchor.lineCount);

      const blockLines = lines.slice(anchor.lineIndex, endIndex);
      const item = parseAnchoredBlock_(blockLines, anchor);

      if (item) {
        items.push({
          ...item,
          sourceOrder: items.length + 1,
          sourceLine: anchor.lineIndex + 1
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
      matchedCount: items.length,
      newSkuCount: 0,
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

  function findSkuAnchors_(lines, catalogItems) {
    const anchors = [];
    let coveredUntil = -1;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (lineIndex <= coveredUntil) continue;
      if (FOOTER_PATTERN.test(lines[lineIndex]) || HEADER_PATTERN.test(lines[lineIndex])) continue;

      const anchor = findAnchorAtLine_(lines, lineIndex, catalogItems);
      if (!anchor) continue;

      anchors.push(anchor);
      coveredUntil = lineIndex + anchor.lineCount - 1;
    }

    return anchors;
  }

  function findAnchorAtLine_(lines, lineIndex, catalogItems) {
    for (let lineCount = 1; lineCount <= MAX_SKU_LINES; lineCount += 1) {
      const parts = lines.slice(lineIndex, lineIndex + lineCount);
      if (parts.length !== lineCount) break;
      if (parts.some(line => FOOTER_PATTERN.test(line))) break;

      const joined = parts.join(' ');
      const candidateText = removeLinePrefix_(joined);
      const compactCandidate = compactSku_(candidateText);

      for (const item of catalogItems) {
        const compactIndex = compactCandidate.indexOf(item.compactSku);
        if (compactIndex < 0) continue;

        // A real item anchor must appear near the beginning of the candidate,
        // after only a line number or vendor code.
        if (compactIndex > 12) continue;

        return {
          lineIndex,
          lineCount,
          sku: item.normalizedSku,
          catalogItem: item,
          matchSource: lineCount > 1 ? 'SPA_SKU_SPLIT_ANCHOR' : 'SPA_SKU_ANCHOR'
        };
      }
    }

    return null;
  }

  function removeLinePrefix_(value) {
    return String(value)
      .replace(/^\d{1,3}\s+/, '')
      .replace(/^T\s+\d+(?:\.\d+)?\s+/, '')
      .replace(/^[A-Z]{2,10}\s+/, '')
      .trim();
  }

  function parseAnchoredBlock_(blockLines, anchor) {
    const cleanLines = trimAtFooter_(blockLines);
    const flat = cleanLines.join(' ');

    const fullPrice = flat.match(
      /(?:^|\s)(\d+(?:\.\d+)?)\s+\$?([\d,]+\.\d{2})\s+E\s+\$?([\d,]+\.\d{2})(?=\s|$)/i
    );

    const partialPrice = fullPrice
      ? null
      : flat.match(/(?:^|\s)(\d+(?:\.\d+)?)\s+\$?([\d,]+\.\d{2})\s+E(?=\s|$)/i);

    const match = fullPrice || partialPrice;
    if (!match) return null;

    const quantity = Number(match[1]);
    const price = toNumber_(match[2]);
    const extPrice = fullPrice
      ? toNumber_(match[3])
      : Number((quantity * price).toFixed(2));

    return {
      sku: anchor.sku,
      description: anchor.catalogItem.description || '',
      invoiceDescription: extractInvoiceDescription_(cleanLines, anchor, match.index),
      quantityOrdered: quantity,
      quantityShipped: quantity,
      price,
      extPrice,
      catalogMatch: true,
      catalogPrice: anchor.catalogItem.price,
      catalogExtPrice: anchor.catalogItem.extPrice || null,
      matchSource: anchor.matchSource,
      sourceText: cleanLines.join('\n')
    };
  }

  function extractInvoiceDescription_(lines, anchor, priceIndex) {
    const candidates = [];

    lines.forEach((line, index) => {
      if (index < anchor.lineCount) return;
      if (FOOTER_PATTERN.test(line) || HEADER_PATTERN.test(line)) return;
      if (/^\d{1,3}$/.test(line)) return;
      if (/^E$/i.test(line)) return;
      if (/^\$?[\d,]+\.\d{2}$/.test(line)) return;
      if (/^\d+(?:\.\d+)?\s+\$?[\d,]+\.\d{2}\s+E/i.test(line)) return;
      if (!/[A-Z]/i.test(line)) return;

      candidates.push(line);
    });

    if (!candidates.length) return '';

    const first = candidates[0];
    return first.length <= 180 ? first : first.slice(0, 180).trim();
  }

  function trimAtFooter_(lines) {
    const result = [];
    for (const line of lines) {
      if (FOOTER_PATTERN.test(line)) break;
      result.push(line);
    }
    return result;
  }

  function findDocumentEnd_(lines, fromIndex) {
    for (let index = fromIndex; index < lines.length; index += 1) {
      if (FOOTER_PATTERN.test(lines[index])) return index;
    }
    return lines.length;
  }

  function extractDocumentInfo_(text) {
    const quoteNumberMatch = text.match(/\b(Q\d{5,})\b/i);
    const quoteDateMatch = text.match(/Quote Date:[\s\S]{0,180}?(\d{2}\/\d{2}\/\d{2,4})/i);

    return {
      type: 'QUOTE',
      number: quoteNumberMatch ? quoteNumberMatch[1].toUpperCase() : '',
      date: quoteDateMatch ? quoteDateMatch[1] : ''
    };
  }

  function normalizeSku_(value) {
    return String(value == null ? '' : value)
      .trim()
      .replace(/\s+/g, ' ')
      .toUpperCase();
  }

  function compactSku_(value) {
    return String(value == null ? '' : value)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  function toNumber_(value) {
    const number = Number(String(value == null ? '' : value).replace(/[$,]/g, ''));
    return Number.isFinite(number) ? number : null;
  }

  return { getMetadata, parseInvoice };
})();
