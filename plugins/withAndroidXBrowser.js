const { withProjectBuildGradle } = require('@expo/config-plugins');

// Expo config plugin — pin androidx.browser to a version compatible with the Expo SDK
// 52 Android toolchain (compileSdk 35 / Android Gradle Plugin 8.6).
//
// react-native-app-auth transitively pulls androidx.browser:1.9.0, which demands
// compileSdk 36 + AGP 8.9.1 and fails the build with:
//   "Dependency 'androidx.browser:browser:1.9.0' requires ... compile against version 36".
// 1.8.0 provides the same CustomTabs APIs app-auth uses and builds cleanly on SDK 52.
// This runs at prebuild time and appends a resolutionStrategy to android/build.gradle,
// so it survives `expo prebuild` (no hand-editing of the generated project).

const MARKER = "force 'androidx.browser:browser:1.8.0'";
const BLOCK = `
// Added by plugins/withAndroidXBrowser.js — keep androidx.browser on a version the
// Expo SDK 52 toolchain (compileSdk 35 / AGP 8.6) can build against.
allprojects {
    configurations.all {
        resolutionStrategy {
            ${MARKER}
        }
    }
}
`;

module.exports = function withAndroidXBrowser(config) {
  return withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('withAndroidXBrowser: expected a groovy android/build.gradle');
    }
    if (!cfg.modResults.contents.includes(MARKER)) {
      cfg.modResults.contents += BLOCK;
    }
    return cfg;
  });
};
