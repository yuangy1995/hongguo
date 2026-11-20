const { updateFeed } = require('../../package.json');

function appUpdateSource() {
  const feed = updateFeed;
  const repository = `${feed.owner}/${feed.repo}`;
  return {
    feed,
    releasesUrl: `https://github.com/${repository}/releases`,
    latestApiUrl: `https://api.github.com/repos/${repository}/releases/latest`,
  };
}

const desktopSource = appUpdateSource();

function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(value || ''));
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function availableRelease(data, currentVersion, source = desktopSource) {
  if (!data || data.draft || data.prerelease) return null;
  const next = versionParts(data.tag_name), current = versionParts(currentVersion);
  if (!next || !current) return null;
  const difference = next.findIndex((part, i) => part !== current[i]);
  if (difference < 0 || next[difference] < current[difference]) return null;
  return {
    version: next.join('.'),
    // Never open a remote-provided URL; only this project's release page.
    url: `${source.releasesUrl}/tag/${encodeURIComponent(data.tag_name)}`,
  };
}

module.exports = { appUpdateSource, availableRelease };
