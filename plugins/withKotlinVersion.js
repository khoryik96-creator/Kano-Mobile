const { withGradleProperties } = require('@expo/config-plugins');

// Expo config plugin — pin the Android Kotlin version to 1.9.25.
//
// Expo SDK 52 defaults Kotlin to 1.9.24, but expo-modules-core's Compose Compiler
// (1.5.15) requires Kotlin 1.9.25, failing the build with:
//   "This version (1.5.15) of the Compose Compiler requires Kotlin version 1.9.25
//    but you appear to be using Kotlin version 1.9.24".
// 1.9.25 is a patch bump and is the version the Compose Compiler expects. This sets
// the `android.kotlinVersion` Gradle property (read by the Expo template's
// build.gradle) at prebuild time, so it survives `expo prebuild`.

const KEY = 'android.kotlinVersion';
const VALUE = '1.9.25';

module.exports = function withKotlinVersion(config) {
  return withGradleProperties(config, (cfg) => {
    cfg.modResults = cfg.modResults.filter((item) => !(item.type === 'property' && item.key === KEY));
    cfg.modResults.push({ type: 'property', key: KEY, value: VALUE });
    return cfg;
  });
};
