import {
  Box,
  Column,
  Host,
  Icon,
  LoadingIndicator,
  NavigationBar,
  NavigationBarItem,
  Text,
  useMaterialColors,
} from '@expo/ui/jetpack-compose';
import { background, fillMaxSize, fillMaxWidth, imePadding, weight } from '@expo/ui/jetpack-compose/modifiers';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Keyboard } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { api, Connection, ItemDetail, loadConnection } from './src/api';
import { checkEvents, startBackgroundChecks } from './src/background';
import { setAppConfig } from './src/config';
import { icons } from './src/icons';
import { ChatIntent, ChatScreen } from './src/screens/ChatScreen';
import { DraftsScreen } from './src/screens/DraftsScreen';
import { EventsScreen } from './src/screens/EventsScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { TodayScreen } from './src/screens/TodayScreen';

const TABS = [
  { id: 'today', label: 'Bugün', icon: icons.today, selected: icons.todayFill },
  { id: 'chat', label: 'Sohbet', icon: icons.chat, selected: icons.chatFill },
  { id: 'events', label: 'Bildirim', icon: icons.notifications, selected: icons.notificationsFill },
  { id: 'drafts', label: 'Onaylar', icon: icons.outgoingMail, selected: icons.outgoingMailFill },
  { id: 'settings', label: 'Ayarlar', icon: icons.settings, selected: icons.settingsFill },
] as const;

type TabId = (typeof TABS)[number]['id'];

function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setShown(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return shown;
}

function Shell() {
  const colors = useMaterialColors();
  const keyboard = useKeyboardShown();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<TabId>('today');
  const [openEventId, setOpenEventId] = useState<number | null>(null);
  const [chatIntent, setChatIntent] = useState<ChatIntent | null>(null);
  const [geminiReady, setGeminiReady] = useState(false);

  useEffect(() => {
    if (!connection) return;
    api.chatSetup(connection).then(
      (setup) => {
        setGeminiReady(setup.models.some((model) => model.id === 'gemini'));
        setAppConfig({ schoolDomain: setup.schoolDomain ?? '', webmailUrl: setup.webmailUrl ?? '' });
      },
      () => setGeminiReady(false),
    );
  }, [connection]);

  const solve = useCallback((detail: ItemDetail) => {
    const course = detail.course ? `${detail.course} dersindeki ` : '';
    setChatIntent({
      model: 'gemini',
      text: `${course}"${detail.title}" ödevini benim için hazırla. Ayrıntıları ödevin anahtarıyla al: ${detail.key}`,
    });
    setTab('chat');
  }, []);
  const clearIntent = useCallback(() => setChatIntent(null), []);
  const clearOpenEvent = useCallback(() => setOpenEventId(null), []);

  useEffect(() => {
    loadConnection()
      .then((saved) => {
        setConnection(saved);
        if (!saved) setTab('settings');
      })
      .finally(() => setReady(true));
    void startBackgroundChecks().catch(() => undefined);
    // Tapping a notification opens its details; a deadline alarm opens the day's list.
    const tapped = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data ?? {};
      if (typeof data.eventId === 'number') {
        setOpenEventId(data.eventId);
        setTab('events');
      } else {
        setTab(typeof data.itemKey === 'string' ? 'today' : 'events');
      }
    });
    const active = AppState.addEventListener('change', (state) => {
      if (state === 'active') void checkEvents().catch(() => undefined);
    });
    return () => {
      tapped.remove();
      active.remove();
    };
  }, []);

  if (!ready) {
    return (
      <Box contentAlignment="center" modifiers={[fillMaxSize(), background(colors.surface)]}>
        <LoadingIndicator />
      </Box>
    );
  }

  const screen = !connection || tab === 'settings' ? (
    <SettingsScreen
      connection={connection}
      onSaved={(next) => {
        setConnection(next);
        if (!next) setTab('settings');
      }}
    />
  ) : tab === 'today' ? (
    <TodayScreen connection={connection} onOpenDrafts={() => setTab('drafts')} onSolve={geminiReady ? solve : undefined} />
  ) : tab === 'chat' ? (
    <ChatScreen connection={connection} intent={chatIntent} onIntentUsed={clearIntent} />
  ) : tab === 'events' ? (
    <EventsScreen
      connection={connection}
      openEventId={openEventId}
      onOpened={clearOpenEvent}
      onSolve={geminiReady ? solve : undefined}
    />
  ) : (
    <DraftsScreen connection={connection} />
  );

  return (
    // Edge-to-edge windows are not resized for the keyboard, so the layout lifts itself above it.
    <Column modifiers={[fillMaxSize(), background(colors.surface), imePadding()]}>
      <Column modifiers={[fillMaxWidth(), weight(1)]}>{screen}</Column>
      {keyboard ? null : (
        <NavigationBar containerColor={colors.surfaceContainer}>
          {TABS.map(({ id, label, icon, selected }) => (
            <NavigationBarItem key={id} selected={tab === id} onClick={() => setTab(id)}>
              <NavigationBarItem.Icon>
                <Icon source={icon} size={24} />
              </NavigationBarItem.Icon>
              <NavigationBarItem.SelectedIcon>
                <Icon source={selected} size={24} />
              </NavigationBarItem.SelectedIcon>
              <NavigationBarItem.Label>
                <Text>{label}</Text>
              </NavigationBarItem.Label>
            </NavigationBarItem>
          ))}
        </NavigationBar>
      )}
    </Column>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Host style={{ flex: 1 }}>
        <Shell />
      </Host>
    </SafeAreaProvider>
  );
}
