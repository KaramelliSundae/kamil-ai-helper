import {
  AlertDialog,
  Column,
  HorizontalDivider,
  Icon,
  Row,
  Surface,
  Text,
  TextButton,
  useMaterialColors,
} from '@expo/ui/jetpack-compose';
import { fillMaxWidth, padding, paddingAll, weight } from '@expo/ui/jetpack-compose/modifiers';
import { useMemo, useState } from 'react';
import { Linking } from 'react-native';

import { icons } from './icons';
import { Block, hostOf, linkRisk, LinkRisk, parseMail } from './mailText';
import { rounded } from './ui';

/**
 * The text of a mail, laid out for reading. Only plain text reaches this view: the server's sandbox has
 * already turned the HTML into words, so nothing in a mail can run, load or track anything here. Links
 * open only when tapped, always show where they really go, and ask first when that is outside the school.
 */
export function MailBody({ body }: { body: string }) {
  const parsed = useMemo(() => parseMail(body), [body]);
  const [english, setEnglish] = useState(false);
  const [quoted, setQuoted] = useState(false);
  const [asking, setAsking] = useState<{ url: string; host: string; risk: LinkRisk } | null>(null);

  const open = (url: string) => {
    const risk = linkRisk(url);
    if (risk.level === 'school') void Linking.openURL(url);
    else setAsking({ url, host: hostOf(url), risk });
  };

  return (
    <Column modifiers={[fillMaxWidth()]} verticalArrangement={{ spacedBy: 14 }}>
      <Blocks blocks={parsed.main} onLink={open} />
      {parsed.english.length ? (
        <Toggle open={english} onToggle={() => setEnglish(!english)} icon={icons.translate}
          label={english ? 'İngilizcesini gizle' : 'İngilizcesini göster'} />
      ) : null}
      {english ? <Blocks blocks={parsed.english} onLink={open} /> : null}
      {parsed.quoted.length ? (
        <Toggle open={quoted} onToggle={() => setQuoted(!quoted)} icon={icons.arrowDown}
          label={quoted ? 'Önceki mesajları gizle' : 'Önceki mesajları göster'} />
      ) : null}
      {quoted ? <Blocks blocks={parsed.quoted} onLink={open} muted /> : null}
      {asking ? <LinkDialog target={asking} onClose={() => setAsking(null)} /> : null}
    </Column>
  );
}

function Blocks({ blocks, onLink, muted }: { blocks: Block[]; onLink: (url: string) => void; muted?: boolean }) {
  const colors = useMaterialColors();
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'divider':
            return <HorizontalDivider key={index} color={colors.outlineVariant} />;
          case 'link':
            return (
              <LinkCard key={index} url={block.url} name={block.name} host={block.host} service={block.service}
                onClick={() => onLink(block.url)} />
            );
          case 'bullets':
            return (
              <Column key={index} verticalArrangement={{ spacedBy: 6 }}>
                {block.items.map((item, i) => (
                  <Row key={i} horizontalArrangement={{ spacedBy: 10 }}>
                    <Text color={colors.primary} style={{ typography: 'bodyLarge', fontWeight: '700' }}>•</Text>
                    <Text color={colors.onSurface} modifiers={[weight(1)]} style={{ typography: 'bodyLarge', lineHeight: 25 }}>
                      {item}
                    </Text>
                  </Row>
                ))}
              </Column>
            );
          default:
            if (block.signature || muted) {
              return (
                <Text key={index} color={colors.onSurfaceVariant} style={{ typography: 'bodyMedium', lineHeight: 21 }}>
                  {block.text}
                </Text>
              );
            }
            return (
              <Text key={index} color={colors.onSurface}
                style={{ typography: block.label ? 'titleSmall' : 'bodyLarge', fontWeight: block.label ? '700' : undefined, lineHeight: 25, lineBreak: 'paragraph' }}>
                {block.text}
              </Text>
            );
        }
      })}
    </>
  );
}

function LinkCard({ url, name, host, service, onClick }: {
  url: string;
  name: string;
  host: string;
  service?: string;
  onClick: () => void;
}) {
  const colors = useMaterialColors();
  const suspicious = linkRisk(url).level === 'suspicious';
  // The real host is always on the card, so a link cannot pass itself off as somewhere else.
  const where = service && service !== name ? `${service} · ${host}` : host;
  return (
    <Surface color={colors.secondaryContainer} contentColor={colors.onSecondaryContainer} shape={rounded(18)} onClick={onClick}
      modifiers={[fillMaxWidth()]}>
      <Row modifiers={[paddingAll(14)]} horizontalArrangement={{ spacedBy: 12 }} verticalAlignment="center">
        <Icon source={icons.link} size={22} tint={colors.onSecondaryContainer} />
        <Column modifiers={[weight(1)]}>
          <Text maxLines={2} overflow="ellipsis" style={{ typography: 'titleSmall', fontWeight: '600' }}>{name}</Text>
          {where !== name ? (
            <Text maxLines={1} overflow="ellipsis" color={suspicious ? colors.error : colors.onSurfaceVariant}
              style={{ typography: 'bodySmall' }}>
              {where}
            </Text>
          ) : null}
        </Column>
        <Icon source={suspicious ? icons.warning : icons.openInNew} size={18}
          tint={suspicious ? colors.error : colors.onSecondaryContainer} />
      </Row>
    </Surface>
  );
}

function Toggle({ onToggle, icon, label }: { open: boolean; onToggle: () => void; icon: number; label: string }) {
  const colors = useMaterialColors();
  return (
    <Surface color={colors.surfaceContainerHigh} shape={rounded(14)} onClick={onToggle}>
      <Row modifiers={[padding(14, 10, 16, 10)]} horizontalArrangement={{ spacedBy: 8 }} verticalAlignment="center">
        <Icon source={icon} size={18} tint={colors.primary} />
        <Text color={colors.primary} style={{ typography: 'labelLarge', fontWeight: '600' }}>
          {label}
        </Text>
      </Row>
    </Surface>
  );
}

export function LinkDialog({ target, onClose }: { target: { url: string; host: string; risk: LinkRisk }; onClose: () => void }) {
  const suspicious = target.risk.level === 'suspicious';
  return (
    <AlertDialog onDismissRequest={onClose}>
      <AlertDialog.Title>
        <Text>{suspicious ? 'Bu bağlantı şüpheli' : 'Bağlantı açılsın mı?'}</Text>
      </AlertDialog.Title>
      <AlertDialog.Text>
        <Text>
          {`${target.risk.reason}\n\nGideceği yer: ${target.host}\n\nSpam olabilecek maillerdeki bağlantılarda şifre ya da kişisel bilgi girme.`}
        </Text>
      </AlertDialog.Text>
      <AlertDialog.ConfirmButton>
        <TextButton onClick={() => { onClose(); void Linking.openURL(target.url); }}>
          <Text>{suspicious ? 'Yine de aç' : 'Aç'}</Text>
        </TextButton>
      </AlertDialog.ConfirmButton>
      <AlertDialog.DismissButton>
        <TextButton onClick={onClose}>
          <Text>Vazgeç</Text>
        </TextButton>
      </AlertDialog.DismissButton>
    </AlertDialog>
  );
}
