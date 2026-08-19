import React from 'react';
import { LogBox } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { KanoProvider } from './app/state';
import { RootNavigator } from './app/navigation';

// Silence dev-only deprecation warnings emitted by react-native-render-html (used to
// render Owl replies). It calls `defaultProps` on function/memo components, which React
// deprecates but still supports; the warnings are harmless and do not appear in release
// builds. Filtering only these exact messages keeps every other warning visible.
LogBox.ignoreLogs([
  'Support for defaultProps will be removed from function components',
  'Support for defaultProps will be removed from memo components',
]);

// Expo entry. Wraps the app in the Kano state provider (which wires platform + core + ui)
// and the navigation tree.

export default function App() {
  return (
    <SafeAreaProvider>
      <KanoProvider>
        <StatusBar style="auto" />
        <RootNavigator />
      </KanoProvider>
    </SafeAreaProvider>
  );
}
