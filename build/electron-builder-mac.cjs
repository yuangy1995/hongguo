const { build, macRelease, updateFeed } = require('../package.json');

module.exports = {
  ...build,
  extraMetadata: { version: macRelease.version },
  buildVersion: macRelease.version,
  publish: updateFeed,
  mac: {
    ...build.mac,
    extendInfo: { ...build.mac.extendInfo, LSFileQuarantineEnabled: true },
    artifactName: 'hongguo-downloader-${version}-mac-${arch}.${ext}',
  },
};
