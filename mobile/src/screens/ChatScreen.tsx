import {
  AlertDialog,
  Box,
  Column,
  DropdownMenu,
  DropdownMenuItem,
  FilledIconButton,
  FilledTonalButton,
  FlowRow,
  Icon,
  IconButton,
  LoadingIndicator,
  ModalBottomSheet,
  Row,
  RNHostView,
  Spacer,
  SuggestionChip,
  Surface,
  Text,
  TextButton,
  TextField,
  useMaterialColors,
  useNativeState,
} from '@expo/ui/jetpack-compose';
import { fillMaxWidth, height, padding, paddingAll, verticalScroll, weight } from '@expo/ui/jetpack-compose/modifiers';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text as RNText, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, ChatMessage, ChatSetup, Connection, Conversation, ModelId } from '../api';
import { chat, useChat } from '../chatSession';
import { AnswerFigure, ChatGreeter, WaitingFigure } from '../kamil';
import { dative, formatDate } from '../format';
import { icons } from '../icons';
import { Notice, rounded } from '../ui';

const SUGGESTIONS = ['Bu hafta neler var?', 'Son duyurular ne?', 'Önemli bir mail geldi mi?', 'Yarın neye yetişmeliyim?'];
const PHONE_SUGGESTIONS = ['Bu hafta neler var?', 'Son duyurular ne?', 'Notlarım nasıl?', 'Yarın neye yetişmeliyim?'];
const FALLBACK_SETUP: ChatSetup = { firstName: null, models: [{ id: 'local', name: 'Kamil', detail: 'Yerel model.' }] };
const NO_MODEL = { id: 'gemini' as ModelId, name: 'Kamil', detail: '' };

/** Opens a fresh chat with a prepared question, for example from an assignment's details. */
/** The model writes light Markdown: bullets become "•" and **bold** becomes bold. Nothing else is parsed. */
export function markdownSpans(content: string): { text: string; bold: boolean }[] {
  const text = content.replace(/^[ \t]*[*-][ \t]+/gm, '• ');
  return text.split(/\*\*([\s\S]+?)\*\*/g).map((part, index) => ({ text: part, bold: index % 2 === 1 })).filter((span) => span.text);
}

const VISIBLE_STEPS = 3; // finished steps kept above the current one, so the box stays small

function Message({ message }: { message: ChatMessage }) {
  const colors = useMaterialColors();
  if (message.role === 'user') {
    return (
      <View style={[styles.mine, { backgroundColor: colors.surfaceContainerHigh }]}>
        <RNText selectable style={[styles.text, { color: colors.onSurface }]}>
          {message.content}
        </RNText>
      </View>
    );
  }
  // Like Claude and Gemini: the assistant's answer is plain text across the page, with a mark beside it.
  return (
    <View style={styles.theirs}>
      <RNText style={[styles.mark, { color: colors.primary }]}>✦</RNText>
      <RNText selectable style={[styles.text, styles.answer, { color: colors.onSurface }]}>
        {markdownSpans(message.content).map((span, index) => (
          <RNText key={index} style={span.bold ? styles.bold : undefined}>
            {span.text}
          </RNText>
        ))}
      </RNText>
    </View>
  );
}

function HistorySheet({ connection, current, onPick, onNew, onClose }: {
  connection: Connection;
  current: number | null;
  onPick: (id: number) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const colors = useMaterialColors();
  const [list, setList] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  const load = useCallback(() => {
    api.conversations(connection).then(setList, (reason: Error) => setError(reason.message));
  }, [connection]);

  useEffect(load, [load]);

  const remove = async (id: number) => {
    await api.deleteConversation(connection, id).catch(() => undefined);
    if (id === current) onNew();
    load();
  };

  const removeAll = async () => {
    setConfirmAll(false);
    await api.deleteAllConversations(connection).catch(() => undefined);
    onNew();
    load();
  };

  return (
    <ModalBottomSheet onDismissRequest={onClose}>
      <Column modifiers={[fillMaxWidth(), verticalScroll(), padding(16, 0, 16, 24)]} verticalArrangement={{ spacedBy: 8 }}>
        <Row modifiers={[fillMaxWidth()]} verticalAlignment="center">
          <Text color={colors.onSurface} modifiers={[weight(1)]} style={{ typography: 'titleLarge', fontWeight: '700' }}>
            Sohbetler
          </Text>
          {list && list.length > 0 ? (
            <TextButton onClick={() => setConfirmAll(true)}>
              <Icon source={icons.deleteAll} size={18} />
              <Text modifiers={[paddingAll(4)]}>Tümünü sil</Text>
            </TextButton>
          ) : null}
        </Row>
        <FilledTonalButton onClick={onNew} modifiers={[fillMaxWidth()]}>
          <Icon source={icons.newChat} size={18} />
          <Text modifiers={[paddingAll(4)]}>Yeni sohbet</Text>
        </FilledTonalButton>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {!list && !error ? <LoadingIndicator modifiers={[paddingAll(16)]} /> : null}
        {list && list.length === 0 ? <Notice>Henüz kayıtlı sohbet yok.</Notice> : null}
        {(list ?? []).map((conversation) => (
          <Surface
            key={conversation.id}
            color={conversation.id === current ? colors.secondaryContainer : colors.surfaceContainerLow}
            shape={rounded(20)}
            onClick={() => onPick(conversation.id)}
            modifiers={[fillMaxWidth()]}>
            <Row modifiers={[padding(16, 6, 4, 6)]} verticalAlignment="center">
              <Column modifiers={[weight(1)]}>
                <Text color={colors.onSurface} maxLines={1} overflow="ellipsis" style={{ typography: 'titleMedium' }}>
                  {conversation.title}
                </Text>
                <Text color={colors.onSurfaceVariant} style={{ typography: 'bodySmall' }}>
                  {formatDate(conversation.updatedAt)}
                </Text>
              </Column>
              <IconButton onClick={() => void remove(conversation.id)}>
                <Icon source={icons.delete} size={20} contentDescription="Sohbeti sil" />
              </IconButton>
            </Row>
          </Surface>
        ))}
      </Column>
      {confirmAll ? (
        <AlertDialog onDismissRequest={() => setConfirmAll(false)}>
          <AlertDialog.Title>
            <Text>Tüm sohbetler silinsin mi?</Text>
          </AlertDialog.Title>
          <AlertDialog.Text>
            <Text>Kamil'in kaydettiği notlar ve hatırlatmalar silinmez.</Text>
          </AlertDialog.Text>
          <AlertDialog.ConfirmButton>
            <TextButton onClick={() => void removeAll()}>
              <Text>Sil</Text>
            </TextButton>
          </AlertDialog.ConfirmButton>
          <AlertDialog.DismissButton>
            <TextButton onClick={() => setConfirmAll(false)}>
              <Text>Vazgeç</Text>
            </TextButton>
          </AlertDialog.DismissButton>
        </AlertDialog>
      ) : null}
    </ModalBottomSheet>
  );
}

export function ChatScreen({ connection }: { connection: Connection }) {
  const colors = useMaterialColors();
  const insets = useSafeAreaInsets();
  const session = useChat();
  const [setup, setSetup] = useState<ChatSetup | null>(null);
  const [modelMenu, setModelMenu] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // The box is native state; the store is the truth, so a draft survives a tab switch.
  const input = useNativeState(session.draft);
  const typed = useRef(session.draft);

  useEffect(() => {
    api.chatSetup(connection).then(setSetup, () => setSetup(FALLBACK_SETUP));
  }, [connection]);

  useEffect(() => {
    if (session.draft !== typed.current) {
      typed.current = session.draft;
      input.set(session.draft);
    }
  }, [input, session.draft]);

  const models = (setup ?? FALLBACK_SETUP).models;
  const model = session.model;
  const current = models.find((option) => option.id === model) ?? models[0] ?? NO_MODEL;
  const noModel = setup !== null && models.length === 0;
  const phone = connection.mode === 'phone';

  // Pick what this setup offers: a Gemini-only setup has no local model to fall back to.
  useEffect(() => {
    if (models.length && !models.some((option) => option.id === model)) chat.setModel(models[0].id);
  }, [model, models]);
  const conversationId = session.conversationId;
  const messages = session.messages;
  const sending = session.waitingOn !== null;
  const waitingLabel = session.steps[session.steps.length - 1] ?? (session.waitingOn === 'gemini' ? 'Model çalışıyor…' : 'Kamil düşünüyor…');
  const error = session.error;
  const text = session.draft;

  const startNew = useCallback(() => {
    chat.startNew();
    setHistoryOpen(false);
  }, []);

  const openConversation = useCallback(
    (id: number) => {
      setHistoryOpen(false);
      void chat.open(connection, id);
    },
    [connection],
  );

  useEffect(() => {
    void chat.refresh(connection);
    // Only on mount: later changes come from the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback((raw: string) => chat.send(connection, raw), [connection]);
  const setModel = (id: ModelId) => chat.setModel(id);
  const setText = (value: string) => {
    typed.current = value;
    chat.setDraft(value);
  };

  const canSend = text.trim().length > 0 && !sending;

  return (
    <Column modifiers={[fillMaxWidth(), weight(1)]}>
      <Spacer modifiers={[height(insets.top)]} />
      <Row modifiers={[fillMaxWidth(), padding(4, 4, 4, 4)]} verticalAlignment="center">
        <IconButton onClick={() => setHistoryOpen(true)}>
          <Icon source={icons.menu} size={24} contentDescription="Sohbet geçmişi" />
        </IconButton>
        <Box modifiers={[weight(1)]} contentAlignment="center">
          <DropdownMenu expanded={modelMenu} onDismissRequest={() => setModelMenu(false)}>
            <DropdownMenu.Trigger>
              <TextButton onClick={() => setModelMenu(true)}>
                <Text color={colors.onSurface} style={{ typography: 'titleMedium', fontWeight: '700' }}>
                  {current.name}
                </Text>
                <Icon source={icons.arrowDown} size={20} tint={colors.onSurfaceVariant} />
              </TextButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Items>
              {models.map((option) => (
                <DropdownMenuItem
                  key={option.id}
                  onClick={() => {
                    setModel(option.id);
                    setModelMenu(false);
                  }}>
                  <DropdownMenuItem.LeadingIcon>
                    <Icon source={option.id === 'gemini' ? icons.cloud : icons.sparkle} size={20} />
                  </DropdownMenuItem.LeadingIcon>
                  <DropdownMenuItem.Text>
                    {/* The supporting-text slot is not drawn by this menu, so the detail goes under the name. */}
                    <Column>
                      <Text style={{ typography: 'titleSmall' }}>{option.name}</Text>
                      <Text color={colors.onSurfaceVariant} style={{ typography: 'bodySmall' }}>
                        {option.detail}
                      </Text>
                    </Column>
                  </DropdownMenuItem.Text>
                  {option.id === model ? (
                    <DropdownMenuItem.TrailingIcon>
                      <Icon source={icons.taskDone} size={20} />
                    </DropdownMenuItem.TrailingIcon>
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenu.Items>
          </DropdownMenu>
        </Box>
        <IconButton onClick={startNew}>
          <Icon source={icons.newChat} size={24} contentDescription="Yeni sohbet" />
        </IconButton>
      </Row>

      {messages.length === 0 ? (
        <Column modifiers={[fillMaxWidth(), weight(1), padding(24, 24, 24, 8)]} verticalArrangement={{ spacedBy: 8 }}>
          <ChatGreeter />
          <Text color={colors.primary} style={{ typography: 'displaySmall', fontWeight: '700' }}>
            {setup?.firstName ? `Merhaba ${setup.firstName}` : 'Merhaba'}
          </Text>
          <Text color={colors.onSurfaceVariant} style={{ typography: 'headlineSmall' }}>
            Bugün neye bakalım?
          </Text>
          <Spacer modifiers={[weight(1)]} />
          <FlowRow horizontalArrangement={{ spacedBy: 8 }} verticalArrangement={{ spacedBy: 8 }}>
            {(phone ? PHONE_SUGGESTIONS : SUGGESTIONS).map((suggestion) => (
              <SuggestionChip key={suggestion} onClick={() => void send(suggestion)}>
                <SuggestionChip.Label>
                  <Text>{suggestion}</Text>
                </SuggestionChip.Label>
              </SuggestionChip>
            ))}
          </FlowRow>
        </Column>
      ) : (
        <RNHostView modifiers={[fillMaxWidth(), weight(1)]}>
          <View style={styles.listHost}>
            <FlatList
              inverted
              data={[...messages].reverse()}
              keyExtractor={(message) => String(message.id)}
              contentContainerStyle={styles.list}
              renderItem={({ item, index }) => (
                <>
                  <Message message={item} />
                  {index === 0 && !sending && item.role === 'assistant' ? <AnswerFigure /> : null}
                </>
              )}
            />
          </View>
        </RNHostView>
      )}

      <Column modifiers={[padding(12, 4, 12, 10)]} verticalArrangement={{ spacedBy: 8 }}>
        {sending ? (
          <Column modifiers={[padding(8, 0, 0, 0)]} verticalArrangement={{ spacedBy: 2 }}>
            {session.steps.slice(-(VISIBLE_STEPS + 1), -1).map((step, index) => (
              <Row key={`${index}-${step}`} horizontalArrangement={{ spacedBy: 8 }} verticalAlignment="center">
                <Icon source={icons.taskDone} size={16} tint={colors.outline} />
                <Text color={colors.outline} style={{ typography: 'bodySmall' }}>
                  {step}
                </Text>
              </Row>
            ))}
            <WaitingFigure label={waitingLabel} />
          </Column>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {noModel ? <Notice>Kamil'le konuşmak için Ayarlar'dan bir model anahtarı gir.</Notice> : null}
        <Surface color={colors.surfaceContainerHigh} shape={rounded(28)} modifiers={[fillMaxWidth()]}>
          <Row modifiers={[padding(4, 4, 8, 4)]} verticalAlignment="center">
            <TextField
              value={input}
              onValueChange={setText}
              maxLines={6}
              maxLength={4000}
              keyboardOptions={{ capitalization: 'sentences' }}
              colors={{
                focusedIndicatorColor: '#00000000',
                unfocusedIndicatorColor: '#00000000',
                focusedContainerColor: '#00000000',
                unfocusedContainerColor: '#00000000',
              }}
              modifiers={[weight(1)]}>
              <TextField.Placeholder>
                <Text>{`${dative(current.name)} sor`}</Text>
              </TextField.Placeholder>
            </TextField>
            <FilledIconButton enabled={canSend} onClick={() => void send(text)}>
              <Icon source={icons.send} size={22} contentDescription="Gönder" />
            </FilledIconButton>
          </Row>
        </Surface>
        {current.id === 'gemini' && !noModel ? (
          <Text color={colors.outline} modifiers={[padding(12, 0, 0, 0)]} style={{ typography: 'labelSmall' }}>
            {phone
              ? "Kamil bulut modelle çalışır: sorduğun Canvas bilgileri seçtiğin sağlayıcıya gider."
              : current.detail.includes('Mail açık')
                ? "Model bulutta çalışır. Mail izni açık: okul maillerin de sağlayıcıya gider."
                : 'Model bulutta çalışır. Okul maillerin ona gönderilmez.'}
          </Text>
        ) : null}
      </Column>

      {historyOpen ? (
        <HistorySheet
          connection={connection}
          current={conversationId}
          onPick={openConversation}
          onNew={startNew}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}
    </Column>
  );
}

const styles = StyleSheet.create({
  listHost: { flex: 1 },
  list: { paddingHorizontal: 16, paddingVertical: 8 },
  mine: { alignSelf: 'flex-end', maxWidth: '86%', borderRadius: 22, paddingHorizontal: 16, paddingVertical: 11, marginVertical: 6 },
  theirs: { flexDirection: 'row', gap: 10, marginVertical: 8, paddingRight: 8 },
  mark: { fontSize: 18, lineHeight: 24 },
  answer: { flex: 1 },
  text: { fontSize: 16, lineHeight: 24 },
  bold: { fontWeight: '700' },
});
