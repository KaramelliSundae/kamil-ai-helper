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

/** Expressive screens open with a large, heavy headline instead of a small app bar. */
export function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  const colors = useMaterialColors();
  const insets = useSafeAreaInsets();
  return (
    <Column modifiers={[fillMaxWidth()]}>
      <Spacer modifiers={[height(insets.top + 12)]} />
      <Text color={colors.onSurface} style={{ typography: 'displaySmall', fontWeight: '700', letterSpacing: -0.5 }}>
        {title}
      </Text>
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
