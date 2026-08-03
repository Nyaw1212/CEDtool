const ParserEngine = (() => {
  const NUMBERED_HEADER = /^(\d{1,3})\s+([A-Z][A-Z0-9&.-]{1,15})\s+(.+)$/i;
  const INVOICE_HEADER = /^T\s+(\d+(?:\.\d+)?)\s+([A-Z][A-Z0-9&.-]{1,15})\s+(.+)$/i;
  const PRICE_SEQUENCE = /(?:^|\s)(\d+(?:\.\d+)?)\s+\$?([\d,]+\.\d{2})\s+E(?:\s+\$?([\d,]+\.\d{2}))?(?=\s|$)/i;
  const MIN_MATCH_SCORE = 0.72;

  function getMetadata() {
    return {
      id: 'parser',
      name: 'Greentech Format Parser',
      version: '0.6.0',
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
      if (!hasPriceBeforeNextHeader_(lines, lineIndex + 1)) return;

      starts.push({
        lineIndex,
        vendor,
        sku,
        source
      });
    });

    return starts;
  }

  function hasPriceBeforeNextHeader_(lines, fromIndex) {
    const buffer = [];

    for (let index = fromIndex; index < Math.min(lines.length, fromIndex + 14); index += 1) {
      if (NUMBERED_HEADER.test(lines[index]) || INVOICE_HEADER.test(lines[index])) break;
      buffer.push(lines[index]);
      if (PRICE_SEQUENCE.test(buffer.join(' '))) return true;
    }

    return false;
  }

  function parseBlock_(block, start) {
    const body = block.slice(1);
    const flat = body.join(' ');
    const priceMatch = flat.match(PRICE_SEQUENCE);
    if (!priceMatch) return null;

    const quantity = Number(priceMatch[1]);
    const price = toNumber_(priceMatch[2]);
    const extPrice = priceMatch[3]
      ? toNumber_(priceMatch[3])
      : Number((quantity * price).toFixed(2));

    const description = findDescription_(body);

    return {
      sku: start.sku,
      description,
      quantity,
      price,
      extPrice
    };
  }

  function findDescription_(body) {
    for (const line of body) {
      if (PRICE_SEQUENCE.test(line)) continue;
      if (/^(E|MERCHANDISE:|TAX:|TOTAL:|PLEASE NOTE:|TERMS AND CONDITIONS)/i.test(line)) continue;
      if (/^\$?[\d,]+\.\d{2}$/.test(line)) continue;
      if (/^\d+(?:\.\d+)?$/.test(line)) continue;
      if (!/[A-Z]/i.test(line)) continue;
      return line.length <= 180 ? line : line.slice(0, 180).trim();
    }
    return '';
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
      } else if (parsedSku.length >= 6 && item.compactDescription.includes(parsedSku)) {
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
    return { type: quote ? 'QUOTE' : 'DOCUMENT', number: quote ? quote[1].toUpperCase() : '', date: date ? date[1] : '' };
  }

  function normalizeSku_(value) {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toUpperCase();
  }

  function compactSku_(value) {
    return String(value == null ? '' : value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function normalizeText_(value) {
    return String(value == null ? '' : value).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function toNumber_(value) {
    const number = Number(String(value == null ? '' : value).replace(/[$,]/g, ''));
    return Number.isFinite(number) ? number : null;
  }

  return { getMetadata, parseInvoice };
})();
