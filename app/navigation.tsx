import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

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
// box. Filled when the tab is active, outline when not. @expo/vector-icons ships with
// the `expo` package, so this adds no dependency.
type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];
function tabIcon(active: IconName, inactive: IconName = active) {
  function TabIcon({ focused, color, size }: { focused: boolean; color: string; size: number }) {
    return <MaterialCommunityIcons name={focused ? active : inactive} color={color} size={size} />;
  }
  return TabIcon;
}
const NotesIcon = tabIcon('note-text', 'note-text-outline');
const OwlIcon = tabIcon('owl');
const SettingsIcon = tabIcon('cog', 'cog-outline');

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
