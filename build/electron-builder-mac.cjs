const { build, macRelease, updateFeed } = require('../package.json');

module.exports = {
  ...build,
  extraMetadata: { version: macRelease.version },
  buildVersion: macRelease.version,
  publish: updateFeed,
  mac: {
    ...build.mac,
    artifactName: 'hongguo-downloader-${version}-mac-${arch}.${ext}',
  },
};
