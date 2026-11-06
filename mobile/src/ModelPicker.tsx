import {
  Column,
  Icon,
  OutlinedTextField,
  Row,
  Surface,
  Text,
  TextButton,
  useMaterialColors,
  useNativeState,
} from '@expo/ui/jetpack-compose';
import { fillMaxWidth, paddingAll, weight } from '@expo/ui/jetpack-compose/modifiers';
import { useState } from 'react';
import { Linking } from 'react-native';

import { icons } from './icons';
import { GEMINI_LIMITS_PAGE, ModelOption, Provider } from './phone/cloud';
import { rounded } from './ui';

const ROWS = 12;

export const PROVIDER_CHOICES: { value: Provider; label: string }[] = [
  { value: 'gemini', label: 'Gemini' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'custom', label: 'Diğer' },
];

export const PROVIDER_HINTS: Record<Provider, string> = {
  gemini: "Anahtarı aistudio.google.com'dan alırsın. Ücretsiz katmanda Google yazdıklarını eğitim için kullanabilir. Google limitleri yayınlamıyor: yanında 'yaklaşık' yazanlar kesin değil.",
  openrouter: "Anahtarı openrouter.ai/keys'ten alırsın. Kamil yalnızca veriyi saklamayan sağlayıcıları ister; bu yüzden bazı ücretsiz modeller çalışmayabilir, o zaman başka birini seç. PDF syllabus okuma yalnızca Gemini'de var.",
  custom: 'OpenAI biçimini konuşan herhangi bir servis, örneğin Groq. Adresi https ile yaz. PDF syllabus okuma yalnızca Gemini\'de var.',
};

/** The models a key may call, each with what is known of its limits. Long lists are searched, not scrolled through. */
export function ModelList({ options, value, provider, onPick }: {
  options: ModelOption[];
  value: string;
  provider: Provider;
  onPick: (id: string) => void;
}) {
  const colors = useMaterialColors();
  const searchState = useNativeState('');
  const [search, setSearch] = useState('');
  const words = search.trim().toLocaleLowerCase('tr');
  const shown = options.filter((option) => !words || option.id.toLowerCase().includes(words)).slice(0, ROWS);
  if (!options.length) return null;
  return (
    <Column modifiers={[fillMaxWidth()]} verticalArrangement={{ spacedBy: 6 }}>
      {options.length > ROWS ? (
        <OutlinedTextField value={searchState} onValueChange={setSearch} singleLine modifiers={[fillMaxWidth()]}>
          <OutlinedTextField.Label>
            <Text>{`Model ara (${options.length} model)`}</Text>
          </OutlinedTextField.Label>
        </OutlinedTextField>
      ) : null}
      {shown.map((option) => {
        const chosen = option.id === value;
        return (
          <Surface
            key={option.id}
            color={chosen ? colors.secondaryContainer : colors.surfaceContainerHigh}
            shape={rounded(14)}
            onClick={() => onPick(option.id)}
            modifiers={[fillMaxWidth()]}>
            <Row modifiers={[paddingAll(10)]} horizontalArrangement={{ spacedBy: 8 }} verticalAlignment="center">
              <Column modifiers={[weight(1)]}>
                <Text color={chosen ? colors.onSecondaryContainer : colors.onSurface} style={{ typography: 'labelLarge', fontWeight: '700' }}>{option.id}</Text>
                <Text color={option.free ? colors.primary : colors.onSurfaceVariant} style={{ typography: 'labelSmall' }}>{option.note}</Text>
              </Column>
              {chosen ? <Icon source={icons.taskDone} size={18} tint={colors.onSecondaryContainer} /> : null}
            </Row>
          </Surface>
        );
      })}
      {provider === 'gemini' ? (
        <TextButton onClick={() => void Linking.openURL(GEMINI_LIMITS_PAGE)}>
          <Text>Kendi limitlerini AI Studio'da gör</Text>
        </TextButton>
      ) : null}
    </Column>
  );
}
