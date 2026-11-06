import {
  Box,
  Column,
  Icon,
  PullToRefreshBox,
  Row,
  Shape,
  Spacer,
  Surface,
  Text,
  ToggleButton,
  useMaterialColors,
} from '@expo/ui/jetpack-compose';
import {
  background,
  clip,
  fillMaxSize,
  fillMaxWidth,
  height,
  padding,
  paddingAll,
  Shapes,
  size,
  weight,
  width,
  wrapContentWidth,
} from '@expo/ui/jetpack-compose/modifiers';
import type { BuiltinShape } from '@expo/ui/jetpack-compose/modifiers';
import { ReactNode } from 'react';
import type { ColorValue, ImageSourcePropType } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { icons } from './icons';

// Called, not rendered: shape props must be the element Shape returns, not a generic JSX element.
export function rounded(radius: number) {
  return Shape.RoundedCorner({ cornerRadii: { topStart: radius, topEnd: radius, bottomStart: radius, bottomEnd: radius } });
}

/** A row in a grouped list: the ends of a group are round, the rows between almost touch. */
export function groupedShape(first: boolean, last: boolean) {
  const top = first ? 24 : 6;
  const bottom = last ? 24 : 6;
  return Shape.RoundedCorner({ cornerRadii: { topStart: top, topEnd: top, bottomStart: bottom, bottomEnd: bottom } });
}

/** Expressive screens open with a large, heavy headline instead of a small app bar. */
export function Header({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  const colors = useMaterialColors();
  const insets = useSafeAreaInsets();
  return (
    <Column modifiers={[fillMaxWidth()]}>
      <Spacer modifiers={[height(insets.top + 12)]} />
      <Row modifiers={[fillMaxWidth()]} verticalAlignment="center">
        <Text color={colors.onSurface} modifiers={[weight(1)]} style={{ typography: 'displaySmall', fontWeight: '700', letterSpacing: -0.5 }}>
          {title}
        </Text>
        {actions}
      </Row>
      {subtitle ? (
        <Text color={colors.onSurfaceVariant} style={{ typography: 'titleMedium' }}>
          {subtitle}
        </Text>
      ) : null}
    </Column>
  );
}

/** An icon cut out of one of Material's expressive shapes. */
export function ShapeIcon({ icon, shape, container, content, dp = 48 }: {
  icon: ImageSourcePropType;
  shape: BuiltinShape;
  container: ColorValue;
  content: ColorValue;
  dp?: number;
}) {
  return (
    <Box contentAlignment="center" modifiers={[size(dp, dp), clip(shape), background(container)]}>
      <Icon source={icon} size={Math.round(dp / 2)} tint={content} />
    </Box>
  );
}

/** A full-width rounded card. Clickable when `onClick` is given. */
export function Panel({ children, onClick, color, radius = 28 }: {
  children: ReactNode;
  onClick?: () => void;
  color?: ColorValue;
  radius?: number;
}) {
  const colors = useMaterialColors();
  return (
    <Surface
      color={color ?? colors.surfaceContainerLow}
      shape={rounded(radius)}
      onClick={onClick}
      modifiers={[fillMaxWidth()]}>
      <Column modifiers={[paddingAll(18)]} verticalArrangement={{ spacedBy: 6 }}>
        {children}
      </Column>
    </Surface>
  );
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'error' }) {
  const colors = useMaterialColors();
  const error = tone === 'error';
  return (
    <Surface
      color={error ? colors.errorContainer : colors.secondaryContainer}
      contentColor={error ? colors.onErrorContainer : colors.onSecondaryContainer}
      shape={rounded(20)}
      modifiers={[fillMaxWidth()]}>
      <Row modifiers={[paddingAll(14)]} horizontalArrangement={{ spacedBy: 12 }} verticalAlignment="center">
        <Icon source={error ? icons.error : icons.sparkle} size={20} />
        <Text style={{ typography: 'bodyMedium' }} modifiers={[weight(1)]}>
          {children}
        </Text>
      </Row>
    </Surface>
  );
}

export const shapes = Shapes.Material;

export type Choice<T> = { value: T; label: string; count?: number };

/**
 * One of a few, as Material's toggle buttons: their corners morph on Compose's own spring, so the animation does not wait
 * for JavaScript. It only plays if this stays mounted, so keep it outside anything that is re-created by a `key`.
 */
export function Choices<T extends string | number>({ options, value, onChange }: {
  options: Choice<T>[];
  value: T | null | undefined;
  onChange: (value: T) => void;
}) {
  const colors = useMaterialColors();
  return (
    <Row modifiers={[fillMaxWidth()]} horizontalArrangement={{ spacedBy: 4 }}>
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <ToggleButton
            key={option.value}
            checked={checked}
            // Tapping the one already chosen changes nothing: there is always exactly one.
            onCheckedChange={() => {
              if (!checked) onChange(option.value);
            }}
            modifiers={[weight(1)]}>
            <Text maxLines={1} overflow="ellipsis" style={{ typography: 'labelLarge', fontWeight: '600' }}>{option.label}</Text>
            {option.count ? (
              <>
                <Spacer modifiers={[width(6)]} />
                <Surface color={checked ? colors.onPrimary : colors.primary} shape={rounded(50)}>
                  <Text
                    color={checked ? colors.primary : colors.onPrimary}
                    modifiers={[padding(6, 1, 6, 1)]}
                    style={{ typography: 'labelSmall', fontWeight: '700' }}>
                    {String(option.count)}
                  </Text>
                </Surface>
              </>
            ) : null}
          </ToggleButton>
        );
      })}
    </Row>
  );
}

/**
 * Pull to refresh with the indicator centred below the status bar. @expo/ui would pin it top-left, and
 * `align` has no effect there, so the indicator takes the full width and centres itself inside it.
 */
export function Refreshable({ refreshing, onRefresh, children }: {
  refreshing: boolean;
  onRefresh: () => void;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <PullToRefreshBox
      isRefreshing={refreshing}
      onRefresh={onRefresh}
      indicator={{ modifiers: [padding(0, insets.top, 0, 0), fillMaxWidth(), wrapContentWidth('centerHorizontally')] }}
      modifiers={[fillMaxSize()]}>
      {children}
    </PullToRefreshBox>
  );
}

export function SectionTitle({ icon, title }: { icon: ImageSourcePropType; title: string }) {
  const colors = useMaterialColors();
  return (
    <Row horizontalArrangement={{ spacedBy: 12 }} verticalAlignment="center">
      <ShapeIcon icon={icon} shape={shapes.Cookie4Sided} container={colors.secondaryContainer} content={colors.onSecondaryContainer} dp={40} />
      <Text color={colors.onSurface} style={{ typography: 'titleLarge', fontWeight: '700' }}>
        {title}
      </Text>
    </Row>
  );
}
