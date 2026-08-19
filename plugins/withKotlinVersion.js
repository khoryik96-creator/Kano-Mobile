const { withGradleProperties } = require('@expo/config-plugins');

// Expo config plugin — set the Android Kotlin version so expo-modules-core selects a
// Compose Compiler that matches the Kotlin the toolchain actually runs.
//
// expo-modules-core picks its Compose Compiler from a hardcoded map keyed by the
// Kotlin version: 1.9.24 -> 1.5.14, 1.9.25 -> 1.5.15. The Expo SDK 52 template defaults
// the reported Kotlin version to 1.9.25 (so it picks Compose 1.5.15), but React Native
// 0.76 pins the Kotlin Gradle plugin actually used for compilation to 1.9.24 — so the
// build fails: "Compose Compiler 1.5.15 requires Kotlin 1.9.25 but you appear to be
// using Kotlin 1.9.24".
//
// Aligning the reported version to 1.9.24 makes expo-modules-core pick Compose 1.5.14,
// which matches the 1.9.24 compiler. Set via the `android.kotlinVersion` Gradle property
// (read by the template's build.gradle) at prebuild time, so it survives `expo prebuild`.

const KEY = 'android.kotlinVersion';
const VALUE = '1.9.24';

module.exports = function withKotlinVersion(config) {
  return withGradleProperties(config, (cfg) => {
    cfg.modResults = cfg.modResults.filter((item) => !(item.type === 'property' && item.key === KEY));
    cfg.modResults.push({ type: 'property', key: KEY, value: VALUE });
    return cfg;
  });
};
