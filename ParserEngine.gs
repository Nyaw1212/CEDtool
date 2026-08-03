const ParserEngine = (() => {
  const NUMBERED_HEADER = /^(\d{1,3})\s+([A-Z][A-Z0-9&.-]{1,15})\s+(.+)$/i;
  const INVOICE_HEADER = /^T\s+(\d+(?:\.\d+)?)\s+([A-Z][A-Z0-9&.-]{1,15})\s+(.+)$/i;
  const STACKED_VENDOR_LINE = /^([A-Z][A-Z0-9&.-]{1,15})\s+(.+)$/i;
  const PRICE_SEQUENCE = /(?:^|\s)(\d+(?:\.\d+)?)\s+\$?([\d,]+\.\d{2})\s+E(?:\s+\$?([\d,]+\.\d{2}))?(?=\s|$)/i;
  const MIN_MATCH_SCORE = 0.72;
  const MAX_STACKED_SKU_LINES = 3;

  function getMetadata() {
    return {
      id: 'parser',
      name: 'Greentech Two-Page Format Parser',
      version: '0.7.0',
      actions: ['parseInvoice']
    };
  }

  function parseInvoice(payload) {
    const text = String(payload && payload.text ? payload.text : '').trim();
    if (!text) throw new Error('Invoice or quote text is required.');

    const catalog = (PriceEngine.list().items || []).map(prepareCatalogItem_);
    const lines = normalizeLines_(text);
    const starts = findItemStarts_(lines);
    const items = [];

    starts.forEach((start, index) => {
      const end = index + 1 < starts.length ? starts[index + 1].lineIndex : lines.length;
      const block = lines.slice(start.lineIndex, end);
      const parsed = parseBlock_(block, start);
      if (!parsed) return;

      const match = findBestCatalogMatch_(parsed, catalog);
      const catalogItem = match ? match.item : null;

      items.push({
        parsedSku: parsed.sku,
        sku: parsed.sku,
        vendor: start.vendor,
        spaSku: catalogItem ? catalogItem.sku : '',
        description: parsed.description || (catalogItem ? catalogItem.description : ''),
        invoiceDescription: parsed.description,
        quantityOrdered: parsed.quantity,
        quantityShipped: parsed.quantity,
        price: parsed.price,
        extPrice: parsed.extPrice,
        catalogMatch: Boolean(catalogItem),
        catalogPrice: catalogItem ? catalogItem.price : null,
        catalogExtPrice: catalogItem ? catalogItem.extPrice || null : null,
        matchScore: match ? match.score : 0,
        matchSource: match ? match.source : 'NO_MATCH',
        sourceOrder: items.length + 1,
        sourceLine: start.lineIndex + 1,
        sourceText: block.join('\n')
      });
    });

    const info = extractDocumentInfo_(text);
    return {
      success: true,
      documentType: info.type,
      invoice: { number: info.number, date: info.date },
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

  function findItemStarts_(lines) {
    const starts = [];
    const inlineLines = new Set();

    lines.forEach((line, lineIndex) => {
      let match = line.match(NUMBERED_HEADER);
      let source = 'NUMBERED_QUOTE';

      if (!match) {
        match = line.match(INVOICE_HEADER);
        source = 'T_INVOICE';
      }

      if (!match) return;

      const vendor = normalizeSku_(match[2]);
      const sku = normalizeSku_(match[3]);
      if (!looksLikeSku_(sku)) return;
      if (!hasPriceBeforeNextInlineHeader_(lines, lineIndex + 1)) return;

      starts.push({ lineIndex, lineCount: 1, vendor, sku, source });
      inlineLines.add(lineIndex);
    });

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (inlineLines.has(lineIndex)) continue;
      const stacked = detectStackedStart_(lines, lineIndex);
      if (!stacked) continue;

      starts.push(stacked);
      lineIndex += stacked.lineCount - 1;
    }

    return dedupeAndSortStarts_(starts);
  }

  function detectStackedStart_(lines, lineIndex) {
    const first = lines[lineIndex] || '';
    const match = first.match(STACKED_VENDOR_LINE);
    if (!match) return null;

    const vendor = normalizeSku_(match[1]);
    if (isExcludedVendorWord_(vendor)) return null;

    const firstSkuPart = normalizeSku_(match[2]);
    if (!firstSkuPart || /\s{2,}/.test(firstSkuPart)) return null;

    for (let lineCount = MAX_STACKED_SKU_LINES; lineCount >= 1; lineCount -= 1) {
      const parts = [firstSkuPart];
      let valid = true;

      for (let offset = 1; offset < lineCount; offset += 1) {
        const continuation = lines[lineIndex + offset] || '';
        if (!/^[A-Z0-9.+/_-]+$/i.test(continuation)) {
          valid = false;
          break;
        }
        parts.push(continuation);
      }

      if (!valid) continue;

      const sku = normalizeStackedSku_(parts);
      if (!looksLikeSku_(sku)) continue;
      if (!hasStackedPriceNearby_(lines, lineIndex + lineCount)) continue;

      return {
        lineIndex,
        lineCount,
        vendor,
        sku,
        source: lineCount > 1 ? 'STACKED_SPLIT_SKU' : 'STACKED_SKU'
      };
    }

    return null;
  }

  function normalizeStackedSku_(parts) {
    if (parts.length === 1) return normalizeSku_(parts[0]);

    // PDF extraction may split a SKU such as QM-HUG-02-M1-US into
    // QM-HUG / 02-M / 1-US. Compact matching still resolves it to SPA SKU.
    return normalizeSku_(parts.join('-').replace(/--+/g, '-'));
  }

  function hasPriceBeforeNextInlineHeader_(lines, fromIndex) {
    const buffer = [];

    for (let index = fromIndex; index < Math.min(lines.length, fromIndex + 16); index += 1) {
      if (NUMBERED_HEADER.test(lines[index]) || INVOICE_HEADER.test(lines[index])) break;
      buffer.push(lines[index]);
      if (PRICE_SEQUENCE.test(buffer.join(' '))) return true;
    }

    return false;
  }

  function hasStackedPriceNearby_(lines, fromIndex) {
    const buffer = [];

    for (let index = fromIndex; index < Math.min(lines.length, fromIndex + 10); index += 1) {
      const line = lines[index];
      if (isDocumentFooter_(line)) break;
      buffer.push(line);
      if (PRICE_SEQUENCE.test(buffer.join(' '))) return true;
    }

    return false;
  }

  function parseBlock_(block, start) {
    const body = block.slice(start.lineCount || 1);
    const flat = body.join(' ');
    const priceMatch = flat.match(PRICE_SEQUENCE);
    if (!priceMatch) return null;

    const quantity = Number(priceMatch[1]);
    const price = toNumber_(priceMatch[2]);
    const extPrice = priceMatch[3]
      ? toNumber_(priceMatch[3])
      : Number((quantity * price).toFixed(2));

    return {
      sku: start.sku,
      description: findDescription_(body, start.source),
      quantity,
      price,
      extPrice
    };
  }

  function findDescription_(body, source) {
    const priceStart = findPriceStartIndex_(body);

    if (/^STACKED/.test(source)) {
      // In the stacked page layout, descriptions follow the price columns.
      for (let index = Math.max(priceStart + 1, 0); index < body.length; index += 1) {
        const line = body[index];
        if (isDescriptionLine_(line)) return truncate_(line, 180);
      }
    }

    // In the inline layout, the description appears before the price row.
    const end = priceStart >= 0 ? priceStart : body.length;
    for (let index = 0; index < end; index += 1) {
      const line = body[index];
      if (isDescriptionLine_(line)) return truncate_(line, 180);
    }

    return '';
  }

  function findPriceStartIndex_(body) {
    for (let start = 0; start < body.length; start += 1) {
      const candidate = body.slice(start, Math.min(body.length, start + 5)).join(' ');
      if (PRICE_SEQUENCE.test(candidate)) return start;
    }
    return -1;
  }

  function isDescriptionLine_(line) {
    if (!line || !/[A-Z]/i.test(line)) return false;
    if (/^(E|LN|PRODUCT|QTY|PRICE|PER \*|EXT PRICE|QUOTE:|MERCHANDISE:|TAX:|TOTAL:)/i.test(line)) return false;
    if (/^\$?[\d,]+\.\d{2}$/.test(line)) return false;
    if (/^\d+(?:\.\d+)?$/.test(line)) return false;
    if (NUMBERED_HEADER.test(line) || INVOICE_HEADER.test(line)) return false;
    return true;
  }

  function isExcludedVendorWord_(value) {
    return /^(GREENTECH|CUSTOMER|CONTACT|MAYER|SHIP|QUOTE|UPDATED|EXPIRES|FREIGHT|FOB|DOMESTIC|GROUNDING|T-BOLT|RD|HUG|TERMS|PLEASE)$/i.test(value);
  }

  function isDocumentFooter_(line) {
    return /^(MERCHANDISE:|TAX:|TOTAL:|PLEASE NOTE:|TERMS AND CONDITIONS|\d+ OF \d+|\* PER )/i.test(line);
  }

  function dedupeAndSortStarts_(starts) {
    const seen = new Set();
    return starts
      .sort((a, b) => a.lineIndex - b.lineIndex)
      .filter(start => {
        const key = `${start.lineIndex}:${compactSku_(start.sku)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function looksLikeSku_(value) {
    const text = normalizeSku_(value);
    if (text.length < 3 || text.length > 100) return false;
    return /[A-Z]/.test(text) && /[0-9]/.test(text);
  }

  function prepareCatalogItem_(item) {
    return {
      ...item,
      compactSku: compactSku_(item.sku),
      normalizedDescription: normalizeText_(item.description),
      compactDescription: compactSku_(item.description)
    };
  }

  function findBestCatalogMatch_(parsed, catalog) {
    const parsedSku = compactSku_(parsed.sku);
    const parsedDescription = normalizeText_(parsed.description);
    let best = null;

    for (const item of catalog) {
      let score = 0;
      let source = 'FUZZY';

      if (parsedSku === item.compactSku) {
        score = 1;
        source = 'EXACT_SKU';
      } else if (
        parsedSku.length >= 6 &&
        (item.compactDescription.includes(parsedSku) || parsedSku.includes(item.compactSku))
      ) {
        score = 0.96;
        source = 'SKU_IN_DESCRIPTION';
      } else {
        const skuScore = similarity_(parsedSku, item.compactSku);
        const descriptionScore = tokenSimilarity_(parsedDescription, item.normalizedDescription);
        score = Math.max(skuScore, descriptionScore, skuScore * 0.7 + descriptionScore * 0.3);
        source = descriptionScore > skuScore ? 'DESCRIPTION_MATCH' : 'FUZZY_SKU';
      }

      if (!best || score > best.score) best = { item, score, source };
    }

    return best && best.score >= MIN_MATCH_SCORE ? best : null;
  }

  function similarity_(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const distance = levenshtein_(a, b);
    return 1 - distance / Math.max(a.length, b.length);
  }

  function levenshtein_(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
      let diagonal = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const saved = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
        diagonal = saved;
      }
    }
    return row[b.length];
  }

  function tokenSimilarity_(a, b) {
    const left = new Set(String(a || '').split(/\s+/).filter(token => token.length > 1));
    const right = new Set(String(b || '').split(/\s+/).filter(token => token.length > 1));
    if (!left.size || !right.size) return 0;
    let intersection = 0;
    left.forEach(token => { if (right.has(token)) intersection += 1; });
    return intersection / new Set([...left, ...right]).size;
  }

  function extractDocumentInfo_(text) {
    const invoice = text.match(/INVOICE\s+NO\.\s+INVOICE\s+DATE[\s\S]*?(\d+\s*-\s*\d+)\s+(\d{2}\/\d{2}\/\d{2,4})/i);
    if (invoice) return { type: 'INVOICE', number: invoice[1], date: invoice[2] };

    const quote = text.match(/\b(Q\d{5,})\b/i);
    const date = text.match(/Quote Date:[\s\S]{0,180}?(\d{2}\/\d{2}\/\d{2,4})/i);
    return {
      type: quote ? 'QUOTE' : 'DOCUMENT',
      number: quote ? quote[1].toUpperCase() : '',
      date: date ? date[1] : ''
    };
  }

  function normalizeSku_(value) {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toUpperCase();
  }

  function compactSku_(value) {
    return String(value == null ? '' : value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function normalizeText_(value) {
    return String(value == null ? '' : value)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function toNumber_(value) {
    const number = Number(String(value == null ? '' : value).replace(/[$,]/g, ''));
    return Number.isFinite(number) ? number : null;
  }

  function truncate_(value, maxLength) {
    const text = String(value || '');
    return text.length <= maxLength ? text : text.slice(0, maxLength).trim();
  }

  return { getMetadata, parseInvoice };
})();
