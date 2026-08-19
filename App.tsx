import React from 'react';
import { LogBox } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { KanoProvider } from './app/state';
import { RootNavigator } from './app/navigation';

// react-native-render-html (used to render Owl replies) still calls React's deprecated
// `defaultProps` on function/memo components. React logs a "Support for defaultProps
// will be removed" warning via console.error, which shows up both in the on-device
// LogBox overlay and in the Metro terminal. It is harmless and dev-only (release builds
// strip these), so we filter just those exact messages from both surfaces. Every other
// warning/error still passes through untouched.
const IGNORED_WARNINGS = ['Support for defaultProps will be removed'];

LogBox.ignoreLogs(IGNORED_WARNINGS);

const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && IGNORED_WARNINGS.some((msg) => (args[0] as string).includes(msg))) {
    return;
  }
  originalConsoleError(...args);
};

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
