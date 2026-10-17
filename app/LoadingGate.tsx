import React from 'react';
import { View, Image, ActivityIndicator, StyleSheet } from 'react-native';

import { useKano } from './state';
import { theme } from './theme';

// Hold the app on a brief splash until saved state has been read. Without this, a
// screen could mount before start-up finished — the Settings form would show empty key
// boxes, and pressing Save would then ERASE the real stored key. Start-up is a few
// local reads, so in practice this is a flash.
export function LoadingGate({ children }: { children: React.ReactNode }) {
  const { ready } = useKano();
  if (ready) return <>{children}</>;
  return (
    <View style={styles.root}>
      <Image source={require('../assets/logo.png')} style={styles.logo} resizeMode="contain" />
      <ActivityIndicator color={theme.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20, backgroundColor: theme.bg },
  logo: { width: 72, height: 72 },
});
