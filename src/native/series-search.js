const { seasonTitle, sourceOf, findTitleSequels } = require('./watch-history');

const normalizeTitle = title => String(title || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const score = (title, keyword) => !keyword ? 2 : title === keyword ? 0 : title.includes(keyword) ? 1 : 2;
function rankedUnique(results, keyword) {
  const seen = new Set(), normalized = normalizeTitle(keyword);
  return results.filter(item => {
    if (!item?.series_id || !item.series_title) return false;
    const id = String(item.series_id);
    if (seen.has(id)) return false;
    seen.add(id); return true;
  }).sort((a, b) => score(normalizeTitle(a.series_title), normalized) - score(normalizeTitle(b.series_title), normalized));
}

function nextSeasonQueries(base, season) {
  if (!base || !Number.isInteger(season) || season < 1 || season > 99) return [];
  const digits = '零一二三四五六七八九';
  const chinese = season < 10 ? digits[season] : `${season < 20 ? '' : digits[Math.floor(season / 10)]}十${season % 10 ? digits[season % 10] : ''}`;
  return [`${base}第${chinese}季`, `${base}第${season}季`];
}

// The player can read additional pages of the original query. Supplements remain bounded.
async function searchSeries(keyword, search, knownSeries = [], { afterSeason = 1, deadline = 0, pageLimit = 1, seasonMatch } = {}) {
  const kw = String(keyword || '').trim();
  if (!kw || kw.length > 200) return { success: false, results: [], error: '请输入 1 至 200 字的搜索词' };
  const primary = await search(kw, { fuzzy: true, deadline });
  if (!primary?.success) return primary || { success: false, results: [], error: '搜索暂不可用' };
  const results = [...(primary.results || [])], parsed = seasonTitle(kw);
  let page = primary;
  let incomplete = primary.partial === true;
  for (let number = 2; page.hasMore && number <= pageLimit; number++) {
    if (deadline && Date.now() >= deadline) break;
    try {
      const next = await search(kw, { fuzzy: false, page: number, channel: primary.channel, cursor: page.cursor, deadline });
      if (!next?.success) break;
      results.push(...(next.results || []));
      incomplete ||= next.partial === true;
      page = next;
    } catch { break; }
  }
  if (pageLimit > 1 && page.hasMore) incomplete = true;
  let queries = [];
  if (parsed.base && !parsed.invalid && parsed.season <= 99) {
    if (parsed.explicit) {
      if (!results.some(item => normalizeTitle(item.series_title) === normalizeTitle(kw))) queries = [parsed.base];
    } else {
      const seasons = [...results, ...knownSeries]
        .filter(item => !seasonMatch || seasonMatch(item))
        .map(item => seasonTitle(item.series_title))
        .filter(item => !item.invalid && (seasonMatch || item.base === parsed.base));
      if (seasons.length) {
        const knownSeasons = new Set(seasons.map(item => item.season));
        let nextSeason = afterSeason + 1;
        while (nextSeason <= 99 && knownSeasons.has(nextSeason)) nextSeason++;
        queries = nextSeasonQueries(parsed.base, nextSeason);
      }
    }
  }
  const errors = [];
  if (queries.length) {
    if (deadline && Date.now() >= deadline) {
      errors.push('搜索时间预算已用完');
    } else {
      // 并行发起同轮补充季数查询，保持按候选顺序合并结果与错误
      const settled = await Promise.all(queries.map(async query => {
        try {
          const response = await search(query, { fuzzy: false, deadline });
          if (!response?.success) throw new Error(response?.error || '来源未返回结果');
          return { ok: true, results: response.results || [] };
        } catch (error) {
          return { ok: false, message: error.message };
        }
      }));
      for (const item of settled) {
        if (item.ok) results.push(...item.results);
        else errors.push(item.message);
      }
    }
  }
  const supplementError = errors.length ? `补充搜索未完成：${[...new Set(errors)].join('；')}` : '';
  const partialErrors = [primary.error, supplementError].filter(Boolean);
  return { ...primary, results: rankedUnique(results, kw), ...(incomplete ? { partial: true } : {}), ...(partialErrors.length ? { partial: true, error: partialErrors.join('；') } : {}) };
}

async function findSeriesSequels(series, localCandidates, search, { localOnly = false, deadline = 0 } = {}) {
  const parsed = seasonTitle(series?.series_title), source = sourceOf(String(series?.series_id || ''));
  if (!source) return { success: false, results: [], error: '此来源暂不支持查找下一季，请按完整剧名搜索。' };
  if (!parsed.base || parsed.invalid || parsed.season > 99) return { success: false, results: [], error: '剧名或季数无法识别，请按完整剧名搜索。' };
  const local = findTitleSequels(series, localCandidates);
  if (localOnly) return { success: true, results: local, candidates: local };
  try {
    const response = await searchSeries(parsed.base, search, [series, ...local], { afterSeason: parsed.season, deadline });
    if (!response?.success) throw new Error(response?.error || '来源搜索失败');
    // Keep the unfiltered candidates so lower seasons in the same family can reuse one search.
    const candidates = [...local, ...(response.results || [])];
    return { success: true, results: findTitleSequels(series, candidates), candidates, ...(response.partial ? { partial: true, error: response.error } : {}) };
  } catch (error) {
    return { success: local.length > 0, results: local, candidates: local, partial: true, error: `联网查找未完成：${error.message}${local.length ? '；已保留本机候选。' : '；可稍后重试。'}` };
  }
}

async function findSeriesSeasons(series, localCandidates, search, { localOnly = false, deadline = 0 } = {}) {
  const source = sourceOf(String(series?.series_id));
  const { base, season: currentSeason, invalid } = seasonTitle(series?.series_title);
  if (!source || !base || invalid || currentSeason > 99) return { unsupported: true, results: [] };

  // 红果同一部剧跨季可能在剧名末尾增减「啊」或「呀」。此规则只用于播放器切季。
  const stem = title => title.replace(/[啊呀]$/u, '');
  const matchParticle = source === 'hongguo' && Array.from(stem(base)).length >= 6;
  const sameSeries = candidate => {
    if (sourceOf(String(candidate?.series_id)) !== source) return false;
    const name = seasonTitle(candidate.series_title);
    return !name.invalid && (name.base === base
      || matchParticle && name.explicit && stem(name.base) === stem(base));
  };
  const seasons = new Map();
  const add = (candidates, registered) => {
    for (const candidate of candidates) {
      if (!sameSeries(candidate)) continue;
      const { base: candidateBase, season, explicit } = seasonTitle(candidate.series_title);
      if (season > 99) continue;
      const priority = (explicit ? 2 : 0) + Number(candidateBase === base);
      const previous = seasons.get(season);
      if (previous && (previous.series_id === String(series.series_id) || previous.priority >= priority)) continue;
      seasons.set(season, { season, explicit, registered, priority,
        series_id: String(candidate.series_id), series_title: candidate.series_title });
    }
  };
  const results = () => [...seasons.values()].sort((left, right) => left.season - right.season)
    .map(({ priority, ...item }) => item);
  add([series, ...localCandidates], true);
  if (localOnly) return { results: results() };

  const keyword = matchParticle ? stem(base) : base;
  const lookup = async (query, until) => {
    try {
      const response = await searchSeries(query, search, results(),
        { afterSeason: 0, deadline: until, pageLimit: 6, seasonMatch: sameSeries });
      add(response?.results || [], false);
      return response?.success === true && response.partial !== true;
    } catch {
      return false;
    }
  };
  const canRetryWithFullTitle = keyword !== base;
  const firstDeadline = canRetryWithFullTitle && deadline ? Math.min(deadline, Date.now() + 14000) : deadline;
  let complete = await lookup(keyword, firstDeadline);
  const hasEarlierGap = currentSeason > 1 && Array.from({ length: currentSeason - 1 }, (_, i) => i + 1)
    .some(season => !seasons.has(season));
  if (canRetryWithFullTitle && (hasEarlierGap || seasons.size === 1) && (!deadline || Date.now() < deadline)) {
    const foundWithFullTitle = await lookup(base, deadline);
    complete ||= foundWithFullTitle;
  }
  return { results: results(), partial: !complete };
}

module.exports = { searchSeries, findSeriesSequels, findSeriesSeasons };
