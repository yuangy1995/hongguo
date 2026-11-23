const path = require('node:path');
const { build, macRelease } = require('../package.json');
const { verifyCatalinaApp } = require('../scripts/verify-catalina-app.cjs');

module.exports = {
  ...build,
  extraMetadata: { version: macRelease.version },
  buildVersion: macRelease.version,
  afterSign: ({ appOutDir, packager }) => verifyCatalinaApp(path.join(appOutDir, `${packager.appInfo.productFilename}.app`)),
  mac: {
    ...build.mac,
    artifactName: 'hongguo-catalina-${version}-mac-${arch}.${ext}',
  },
};
