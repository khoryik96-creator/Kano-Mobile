import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ScrollView, Alert } from 'react-native';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';

import { useKano } from '../state';
import { validateApiKey } from '../../src/ui';
import { DRIVE_OAUTH_SCOPES } from '../../src/platform';
import { GOOGLE_OAUTH, googleConfigured } from '../config';
import type { AiProvider } from '../../src/core/ai';

// Lets the auth browser tab hand the result back to the app (recommended once at load).
WebBrowser.maybeCompleteAuthSession();

export function SettingsScreen() {
  const { settings, updateSettings, completeGoogleSignIn, busy, status } = useKano();
  const [provider, setProvider] = useState<AiProvider>(settings.provider);
  const [claudeApiKey, setClaudeApiKey] = useState(settings.claudeApiKey);
  const [deepSeekApiKey, setDeepSeekApiKey] = useState(settings.deepSeekApiKey);
  const [userName, setUserName] = useState(settings.userName);

  // Google sign-in via expo-auth-session's Google provider. It handles the native
  // redirect/client-type details; we pass the Drive scope and hand the returned token to
  // the app state, which persists it and pulls the cloud notes.
  const [request, response, promptAsync] = Google.useAuthRequest({
    androidClientId: GOOGLE_OAUTH.androidClientId,
    webClientId: GOOGLE_OAUTH.webClientId,
    scopes: ['openid', 'email', ...DRIVE_OAUTH_SCOPES],
  });

  useEffect(() => {
    if (response?.type !== 'success') return;
    const auth = response.authentication;
    if (!auth?.accessToken) return;
    void (async () => {
      let email = '';
      try {
        const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: 'Bearer ' + auth.accessToken },
        });
        email = String(((await r.json()) as { email?: string })?.email || '');
      } catch {
        /* email is best-effort */
      }
      const expiresAt =
        auth.issuedAt && auth.expiresIn
          ? (auth.issuedAt + auth.expiresIn) * 1000
          : Date.now() + (auth.expiresIn ? auth.expiresIn * 1000 : 3_600_000);
      await completeGoogleSignIn({ accessToken: auth.accessToken, expiresAt, email, refreshToken: auth.refreshToken || undefined });
    })();
  }, [response, completeGoogleSignIn]);

  const onSave = async () => {
    const key = provider === 'deepseek' ? deepSeekApiKey : claudeApiKey;
    const check = validateApiKey(provider, key);
    if (!check.ok) {
      Alert.alert('Check the API key', check.message || 'Invalid key');
      return;
    }
    await updateSettings({ ...settings, provider, claudeApiKey, deepSeekApiKey, userName });
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.section}>Google Drive</Text>
      {settings.googleEmail ? (
        <Text style={styles.connected}>● Signed in as {settings.googleEmail}</Text>
      ) : (
        <Text style={styles.hint}>Sign in to sync notes with the Kano extension.</Text>
      )}
      {!googleConfigured() ? <Text style={styles.warn}>Set EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID first (see docs/RUNNING_ON_DEVICE.md).</Text> : null}
      <Pressable style={[styles.btn, styles.primary]} onPress={() => void promptAsync()} disabled={busy || !request || !googleConfigured()}>
        <Text style={styles.primaryText}>{settings.googleEmail ? 'Re-sign in' : 'Sign in with Google'}</Text>
      </Pressable>

      <Text style={styles.section}>AI provider</Text>
      <View style={styles.providerRow}>
        {(['claude', 'deepseek'] as AiProvider[]).map((p) => (
          <Pressable key={p} style={[styles.chip, provider === p && styles.chipOn]} onPress={() => setProvider(p)}>
            <Text style={[styles.chipText, provider === p && styles.chipTextOn]}>{p === 'claude' ? 'Claude' : 'DeepSeek'}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>Claude API key</Text>
      <TextInput style={styles.input} placeholder="sk-ant-…" value={claudeApiKey} onChangeText={setClaudeApiKey} autoCapitalize="none" autoCorrect={false} secureTextEntry />
      <Text style={styles.label}>DeepSeek API key</Text>
      <TextInput style={styles.input} placeholder="sk-…" value={deepSeekApiKey} onChangeText={setDeepSeekApiKey} autoCapitalize="none" autoCorrect={false} secureTextEntry />

      <Text style={styles.section}>The Owl</Text>
      <Text style={styles.label}>Your name (how The Owl addresses you)</Text>
      <TextInput style={styles.input} placeholder="e.g. Sam" value={userName} onChangeText={setUserName} />

      <Pressable style={[styles.btn, styles.primary, styles.save]} onPress={() => void onSave()} disabled={busy}>
        <Text style={styles.primaryText}>Save settings</Text>
      </Pressable>
      {status ? <Text style={styles.status}>{status}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, gap: 8 },
  section: { fontSize: 16, fontWeight: '700', marginTop: 16, color: '#111' },
  hint: { color: '#555' },
  connected: { color: '#16a34a', fontWeight: '600' },
  warn: { color: '#b45309' },
  label: { color: '#333', marginTop: 8, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  providerRow: { flexDirection: 'row', gap: 8 },
  chip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, backgroundColor: '#f0f0f0' },
  chipOn: { backgroundColor: '#2563eb' },
  chipText: { fontWeight: '600', color: '#111' },
  chipTextOn: { color: '#fff' },
  btn: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8, backgroundColor: '#f0f0f0', alignItems: 'center' },
  primary: { backgroundColor: '#2563eb' },
  primaryText: { color: '#fff', fontWeight: '700' },
  save: { marginTop: 20 },
  status: { color: '#555', fontSize: 12, marginTop: 8 },
});
