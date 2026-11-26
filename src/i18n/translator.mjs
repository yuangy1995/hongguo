export function formatMessage(message, values) {
  return typeof message === 'string' && values !== undefined
    ? message.replace(/\{(\d+)\}/g, (placeholder, index) => values[index] == null ? placeholder : String(values[index]))
    : message;
}

export function createTranslator(english, templates) {
const normalize = text => text.replace(/\s+/g, ' ').trim();
const patterns = Object.entries(templates).map(([key, value]) => {
  const ids = [];
  const expression = normalize(key).split(/(\{\d+\})/).map(part => {
    if (/^\{\d+\}$/.test(part)) { ids.push(part); return '(.*?)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return { regex: new RegExp(`^${expression}$`), ids, value, weight: key.replace(/\{\d+\}/g, '').length };
}).sort((a, b) => b.weight - a.weight);

const cache = new Map();
const MAX_CACHE = 2048;

function remember(raw, translated) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(raw, translated);
  return translated;
}

function translate(value, values) {
  if (typeof value !== 'string' || value.length > 4096) return value;
  if (values === undefined) {
    const hit = cache.get(value);
    if (hit !== undefined) return hit;
  }
  const key = normalize(value);
  if (values !== undefined) return formatMessage(english[key] ?? templates[value] ?? templates[key] ?? value, values);
  if (Object.hasOwn(english, key)) {
    return remember(value, (value.match(/^\s+/)?.[0] ? ' ' : '') + english[key] + (value.match(/\s+$/)?.[0] ? ' ' : ''));
  }
  for (const { regex, ids, value: translation } of patterns) {
    const match = key.match(regex);
    if (match) return remember(value, translation.replace(/\{\d+\}/g, id => match[ids.indexOf(id) + 1] ?? id));
  }
  return remember(value, value);
}

return translate;
}
