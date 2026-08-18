import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { KanoProvider } from './app/state';
import { RootNavigator } from './app/navigation';

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
