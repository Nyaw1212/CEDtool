const ParserEngine = (() => {
  const FOOTER_PATTERN = /^(MERCHANDISE:|TAX:|TOTAL:|PLEASE NOTE:|TERMS AND CONDITIONS|\d+ OF \d+|\* PER |QUOTE:|REVISION #:)/i;

  function getMetadata() {
    return {
      id: 'parser',
      name: 'Invoice and Quote Parser Engine',
      version: '0.2.1',
      actions: ['parseInvoice']
    };
  }

  function parseInvoice(payload) {
    const text = String(payload && payload.text ? payload.text : '').trim();
    if (!text) throw new Error('Invoice or quote text is required.');

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
      const nextStart = starts[index + 1];
      const end = nextStart ? nextStart.lineIndex : findDocumentEnd_(lines, start.lineIndex + 1);
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

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];

      // Invoice format: T 30 ENP IQ8HC-72-M-DOM-US ...
      if (/^T\s+\d+(?:\.\d+)?\s+/i.test(line)) {
        const knownSku = findKnownSkuNear_(lines, lineIndex, knownSkus, 3);
        if (knownSku) {
          starts.push({ lineIndex, sku: knownSku, source: 'INVOICE_CATALOG_ANCHOR' });
          continue;
        }

        const match = line.match(/^T\s+\d+(?:\.\d+)?\s+([A-Z0-9&.-]+)\s+(\S+)/i);
        if (match && match[1].toUpperCase() !== 'MISC') {
          const sku = normalizeSku_(match[2]);
          if (looksLikeSku_(sku)) starts.push({ lineIndex, sku, source: 'INVOICE_LINE_PATTERN' });
        }
        continue;
      }

      // Quote format page 1: 01 QCELL SPCD-00001
      const numberedInline = line.match(/^\d{1,3}\s+([A-Z][A-Z0-9&.-]+)\s+(.+)$/i);
      if (numberedInline) {
        const knownSku = findKnownSkuNear_(lines, lineIndex, knownSkus, 4);
        if (knownSku) {
          starts.push({ lineIndex, sku: knownSku, source: 'QUOTE_CATALOG_ANCHOR' });
          continue;
        }

        const sku = normalizeSku_(numberedInline[2].split(/\s+/)[0]);
        if (looksLikeSku_(sku)) starts.push({ lineIndex, sku, source: 'QUOTE_INLINE_PATTERN' });
        continue;
      }

      // Quote format page 2: SKU appears on its own after the grouped line numbers.
      const standalone = detectStandaloneSku_(lines, lineIndex, knownSkus);
      if (standalone) {
        starts.push({
          lineIndex,
          sku: standalone.sku,
          source: standalone.source,
          skuLineCount: standalone.lineCount
        });
      }
    }

    return dedupeStarts_(starts)
      .sort((a, b) => a.lineIndex - b.lineIndex);
  }

  function detectStandaloneSku_(lines, lineIndex, knownSkus) {
    const line = lines[lineIndex];
    if (!line || FOOTER_PATTERN.test(line) || /^\d{1,3}$/.test(line)) return null;
    if (/^(LN|PRODUCT|QTY|PRICE|PER \*|EXT PRICE|DESCRIPTION)$/i.test(line)) return null;

    for (let count = 3; count >= 1; count -= 1) {
      const parts = lines.slice(lineIndex, lineIndex + count);
      if (parts.length !== count) continue;
      if (parts.some(part => FOOTER_PATTERN.test(part))) continue;

      const joined = parts.join(' ');
      const withoutVendor = joined.replace(/^[A-Z]{2,8}\s+/, '');
      const compactCandidate = compactSku_(withoutVendor);

      const knownSku = knownSkus.find(sku => compactSku_(sku) === compactCandidate);
      if (knownSku && hasPriceNearby_(lines, lineIndex + count)) {
        return { sku: knownSku, lineCount: count, source: 'QUOTE_SPLIT_CATALOG_ANCHOR' };
      }

      if (count === 1 && isLikelyStandaloneSku_(withoutVendor) && hasPriceNearby_(lines, lineIndex + 1)) {
        return { sku: normalizeSku_(withoutVendor), lineCount: 1, source: 'QUOTE_STANDALONE_PATTERN' };
      }
    }

    return null;
  }

  function isLikelyStandaloneSku_(value) {
    const text = normalizeSku_(value);
    if (text.includes(' ')) return false;
    if (text.length < 4 || text.length > 45) return false;
    if (!/[A-Z]/.test(text) || !/[0-9]/.test(text)) return false;
    return /^[A-Z0-9.+/_-]+$/.test(text);
  }

  function hasPriceNearby_(lines, startIndex) {
    const nearby = lines.slice(startIndex, Math.min(lines.length, startIndex + 10)).join(' ');
    return /\$?[\d,]+\.\d{2}\s+E\s+\$?[\d,]+\.\d{2}/i.test(nearby) ||
      /\d+(?:\.\d+)?\s+\$?[\d,]+\.\d{2}\s+E/i.test(nearby);
  }

  function findKnownSkuNear_(lines, lineIndex, knownSkus, windowSize) {
    const windowText = lines
      .slice(lineIndex, Math.min(lines.length, lineIndex + windowSize))
      .join(' ')
      .toUpperCase();
    const compactWindow = compactSku_(windowText);

    for (const sku of knownSkus) {
      if (containsSku_(windowText, sku) || compactWindow.includes(compactSku_(sku))) return sku;
    }
    return '';
  }

  function dedupeStarts_(starts) {
    const seenLines = new Set();
    return starts.filter(start => {
      if (seenLines.has(start.lineIndex)) return false;
      seenLines.add(start.lineIndex);
      return true;
    });
  }

  function findDocumentEnd_(lines, fromIndex) {
    for (let index = fromIndex; index < lines.length; index += 1) {
      if (FOOTER_PATTERN.test(lines[index])) return index;
    }
    return lines.length;
  }

  function parseItemBlock_(blockLines, start, catalogMap) {
    const cleanBlock = trimBlockAtFooter_(blockLines);
    const flat = cleanBlock.join(' ');
    const firstLine = cleanBlock[0] || '';
    const catalogItem = catalogMap.get(normalizeSku_(start.sku)) || null;

    const invoiceQtyMatch = firstLine.match(/^T\s+(\d+(?:\.\d+)?)\s+/i);
    const fullMatches = Array.from(flat.matchAll(
      /(?:^|\s)(\d+(?:\.\d+)?)\s+\$?([\d,]+\.\d{2})\s+E\s+\$?([\d,]+\.\d{2})(?=\s|$)/gi
    ));
    const fullMatch = fullMatches.length ? fullMatches[0] : null;

    let shippedQty = null;
    let price = null;
    let extPrice = null;

    if (fullMatch) {
      shippedQty = Number(fullMatch[1]);
      price = toNumber_(fullMatch[2]);
      extPrice = toNumber_(fullMatch[3]);
    } else {
      const partial = flat.match(/(?:^|\s)(\d+(?:\.\d+)?)\s+\$?([\d,]+\.\d{2})\s+E(?=\s|$)/i);
      if (!partial) return null;
      shippedQty = Number(partial[1]);
      price = toNumber_(partial[2]);
      extPrice = Number((shippedQty * price).toFixed(2));
    }

    const orderedQty = invoiceQtyMatch ? Number(invoiceQtyMatch[1]) : shippedQty;
    const invoiceDescription = extractDescriptionFromBlock_(cleanBlock, start, shippedQty, price, extPrice);

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
      sourceText: cleanBlock.join('\n')
    };
  }

  function trimBlockAtFooter_(blockLines) {
    const output = [];
    for (const line of blockLines) {
      if (FOOTER_PATTERN.test(line)) break;
      output.push(line);
    }
    return output;
  }

  function extractDescriptionFromBlock_(blockLines, start, qty, price, extPrice) {
    const candidates = [];
    const skuLineCount = start.skuLineCount || 1;

    blockLines.forEach((line, index) => {
      let value = line;

      if (index === 0) {
        value = stripLinePrefixAndSku_(value, start.sku);
      } else if (index < skuLineCount) {
        return;
      }

      if (!value || FOOTER_PATTERN.test(value)) return;
      if (/^\d{1,3}$/.test(value)) return;
      if (/^E$/i.test(value)) return;
      if (/^\$?[\d,]+\.\d{2}$/.test(value)) return;
      if (/^(LN|PRODUCT|DESCRIPTION|QTY|PRICE|PER \*|EXT PRICE)$/i.test(value)) return;

      value = value
        .replace(new RegExp(`^${escapeRegex_(String(qty))}\\s+`), '')
        .replace(new RegExp(`\\s+${escapeRegex_(String(qty))}\\s+\\$?${escapeRegex_(formatPlain_(price))}\\s+E\\s+\\$?${escapeRegex_(formatPlain_(extPrice))}.*$`, 'i'), '')
        .replace(/\s+\d+(?:\.\d+)?\s+\$?[\d,]+\.\d{2}\s+E\s+\$?[\d,]+\.\d{2}.*$/i, '')
        .trim();

      if (!value || !/[A-Z]/i.test(value)) return;
      candidates.push(value);
    });

    if (!candidates.length) return '';

    // Greentech often repeats the same description twice. Keep the first unique phrase only.
    const unique = [];
    const seen = new Set();
    for (const candidate of candidates) {
      const key = candidate.toUpperCase();
      if (seen.has(key)) break;
      seen.add(key);
      unique.push(candidate);
      if (unique.join(' ').length > 160) break;
    }

    return unique.join(' ').replace(/\s+/g, ' ').trim();
  }

  function stripLinePrefixAndSku_(line, sku) {
    let value = String(line);
    value = value.replace(/^T\s+\d+(?:\.\d+)?\s+[A-Z0-9&.-]+\s+/i, '');
    value = value.replace(/^\d{1,3}\s+[A-Z][A-Z0-9&.-]+\s+/i, '');

    const skuPattern = new RegExp(`^${escapeRegex_(normalizeSku_(sku))}(?:\\s+|$)`, 'i');
    value = value.replace(skuPattern, '');
    return value.trim();
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
    const escaped = escapeRegex_(sku);
    return new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'i').test(upperLine);
  }

  function compactSku_(value) {
    return String(value == null ? '' : value).toUpperCase().replace(/[^A-Z0-9]/g, '');
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

  function escapeRegex_(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function formatPlain_(value) {
    return Number(value || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  return { getMetadata, parseInvoice };
})();
