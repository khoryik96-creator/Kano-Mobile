import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Image } from 'react-native';
import type { ImageSourcePropType } from 'react-native';

import { NotesListScreen } from './screens/NotesListScreen';
import { NoteEditorScreen } from './screens/NoteEditorScreen';
import { OwlChatScreen } from './screens/OwlChatScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { theme } from './theme';

// Navigation: a bottom tab bar (Notes / Owl / Settings); the Notes tab is a stack so the
// list can push the editor.

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

// Tab icons. Without a tabBarIcon, React Navigation draws its placeholder "missing icon"
// box. Filled when the tab is active, outline when not. These are Material Design
// Icons (Apache-2.0) pre-rendered to PNG at 1x/2x/3x and tinted at runtime: an icon
// FONT (@expo/vector-icons) would need the expo-font native package, which this
// project doesn't ship — that broke the build's JS bundle step.
function tabIcon(active: ImageSourcePropType, inactive: ImageSourcePropType = active) {
  function TabIcon({ focused, color, size }: { focused: boolean; color: string; size: number }) {
    return <Image source={focused ? active : inactive} style={{ width: size, height: size, tintColor: color }} />;
  }
  return TabIcon;
}
const NotesIcon = tabIcon(require('../assets/tab/notes.png'), require('../assets/tab/notes-outline.png'));
const OwlIcon = tabIcon(require('../assets/tab/owl.png'));
const SettingsIcon = tabIcon(require('../assets/tab/settings.png'), require('../assets/tab/settings-outline.png'));

function NotesStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: theme.surface },
        headerTitleStyle: { color: theme.text, fontWeight: '800' },
        headerTintColor: theme.primary,
      }}
    >
      <Stack.Screen name="NotesList" component={NotesListScreen} options={{ title: 'Notes' }} />
      <Stack.Screen name="NoteEditor" component={NoteEditorScreen} options={{ title: 'Note' }} />
    </Stack.Navigator>
  );
}

export function RootNavigator() {
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={{
          tabBarActiveTintColor: theme.primary,
          tabBarInactiveTintColor: theme.faint,
          tabBarStyle: { backgroundColor: theme.surface, borderTopColor: theme.border },
          tabBarLabelStyle: { fontWeight: '700', fontSize: 12 },
          headerStyle: { backgroundColor: theme.surface },
          headerTitleStyle: { color: theme.text, fontWeight: '800' },
          headerTintColor: theme.primary,
        }}
      >
        <Tab.Screen name="NotesTab" component={NotesStack} options={{ title: 'Notes', headerShown: false, tabBarIcon: NotesIcon }} />
        <Tab.Screen name="Owl" component={OwlChatScreen} options={{ title: 'The Owl', tabBarIcon: OwlIcon }} />
        <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarIcon: SettingsIcon }} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
