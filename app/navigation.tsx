import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { NotesListScreen } from './screens/NotesListScreen';
import { NoteEditorScreen } from './screens/NoteEditorScreen';
import { OwlChatScreen } from './screens/OwlChatScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { theme } from './theme';

// Navigation: a bottom tab bar (Notes / Owl / Settings); the Notes tab is a stack so the
// list can push the editor.

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

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
        <Tab.Screen name="NotesTab" component={NotesStack} options={{ title: 'Notes', headerShown: false }} />
        <Tab.Screen name="Owl" component={OwlChatScreen} options={{ title: 'The Owl' }} />
        <Tab.Screen name="Settings" component={SettingsScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
