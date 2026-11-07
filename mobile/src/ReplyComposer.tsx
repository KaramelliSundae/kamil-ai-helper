import {
  Button,
  Column,
  FilledTonalButton,
  Icon,
  OutlinedTextField,
  Text,
  TextButton,
  useMaterialColors,
  useNativeState,
} from '@expo/ui/jetpack-compose';
import { fillMaxWidth, paddingAll } from '@expo/ui/jetpack-compose/modifiers';
import { useEffect, useState } from 'react';
import { Linking } from 'react-native';

import { api, Connection } from './api';
import { ConfirmDialog } from './ConfirmDialog';
import { icons } from './icons';
import { replyLink } from './mailThread';
import { Notice } from './ui';

const BLANK = /\[[^\]\n]{1,80}\]/;

/**
 * A reply, written here. The text is the student's: the model only fills the box when asked, and nothing leaves without a tap
 * that names the recipient. The recipient starts as the last sender, and can be changed.
 */
export function ReplyComposer({ connection, itemKey, title, to, onSent, onSaved, onCancel }: {
  connection: Connection;
  itemKey: string;
  title: string;
  to: string;
  onSent: () => void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const colors = useMaterialColors();
  const toState = useNativeState(to);
  const bodyState = useNativeState('');
  const [recipient, setRecipient] = useState(to);
  const [body, setBody] = useState('');
  const [canSend, setCanSend] = useState(false);
  const [busy, setBusy] = useState<'writing' | 'sending' | 'saving' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const ready = recipient.trim().length > 0 && body.trim().length > 0 && !busy;

  useEffect(() => {
    api.canSendMail(connection).then(setCanSend, () => setCanSend(false));
  }, [connection]);

  const run = async (kind: 'writing' | 'sending' | 'saving', work: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await work();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'İşlem yapılamadı.');
    } finally {
      setBusy(null);
    }
  };

  const write = () => run('writing', async () => {
    const text = await api.replyText(itemKey);
    bodyState.set(text);
    setBody(text);
  });
  const send = () => run('sending', async () => {
    await api.sendReply(itemKey, recipient, body);
    onSent();
  });
  const save = () => run('saving', async () => {
    await api.saveReply(itemKey, recipient, body);
    onSaved();
  });
  const openInApp = () => {
    const link = replyLink(recipient, title, body);
    if (!link) {
      setError('Alıcı adresi geçersiz.');
      return;
    }
    Linking.openURL(link).catch(() => setError('Mail uygulaması açılamadı.'));
  };

  return (
    <Column modifiers={[fillMaxWidth()]} verticalArrangement={{ spacedBy: 10 }}>
      <Text color={colors.onSurface} style={{ typography: 'titleSmall', fontWeight: '700' }}>Yanıt</Text>
      <OutlinedTextField
        value={toState}
        onValueChange={setRecipient}
        singleLine
        keyboardOptions={{ keyboardType: 'email', autoCorrectEnabled: false }}
        modifiers={[fillMaxWidth()]}>
        <OutlinedTextField.Label>
          <Text>Kime</Text>
        </OutlinedTextField.Label>
      </OutlinedTextField>
      <OutlinedTextField
        value={bodyState}
        onValueChange={setBody}
        minLines={5}
        maxLines={14}
        keyboardOptions={{ capitalization: 'sentences' }}
        modifiers={[fillMaxWidth()]}>
        <OutlinedTextField.Label>
          <Text>Yanıtın</Text>
        </OutlinedTextField.Label>
      </OutlinedTextField>
      <FilledTonalButton enabled={!busy} onClick={() => void write()}>
        <Icon source={icons.cloud} size={18} />
        <Text modifiers={[paddingAll(4)]}>{busy === 'writing' ? 'Yazılıyor…' : 'Yapay zekayla yaz'}</Text>
      </FilledTonalButton>
      {BLANK.test(body) ? <Notice tone="error">Köşeli parantezli yerleri doldurmadan gönderme.</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {canSend ? (
        <Button enabled={ready} onClick={() => setConfirming(true)}>
          <Icon source={icons.send} size={18} />
          <Text modifiers={[paddingAll(4)]}>{busy === 'sending' ? 'Gönderiliyor…' : 'Gönder'}</Text>
        </Button>
      ) : (
        <Button enabled={ready} onClick={openInApp}>
          <Icon source={icons.send} size={18} />
          <Text modifiers={[paddingAll(4)]}>Mail uygulamasında aç</Text>
        </Button>
      )}
      <TextButton enabled={ready} onClick={() => void save()}>
        <Text>Taslağı Onaylar'a kaydet</Text>
      </TextButton>
      {canSend ? (
        <TextButton enabled={ready} onClick={openInApp}>
          <Text>Mail uygulamasında aç</Text>
        </TextButton>
      ) : null}
      <TextButton enabled={!busy} onClick={onCancel}>
        <Text>Vazgeç</Text>
      </TextButton>
      {confirming ? (
        <ConfirmDialog
          title="Mail gönderilsin mi?"
          text={`${recipient.trim()} adresine okul mailinden gidecek.${BLANK.test(body) ? '\n\nDikkat: içinde köşeli parantezli bir yer var.' : ''}`}
          confirm="Gönder"
          onConfirm={() => {
            setConfirming(false);
            void send();
          }}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </Column>
  );
}
