import { View } from 'react-native';

import type { BoundingBox } from '../../api/types';
import { mapBoxToView } from '../../logic/boxMapping';
import { theme } from '../../ui/theme';

/** Draws Gemini's box over an image shown with resizeMode="cover" in a view of `view` size. */
export function BoundingBoxOverlay(props: {
  box: BoundingBox | null;
  image: { width: number; height: number };
  view: { width: number; height: number };
}) {
  const rect = mapBoxToView(props.box, props.image, props.view);
  if (!rect) return null;
  return (
    <View
      testID="patient-bounding-box"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        position: 'absolute',
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        borderWidth: 4,
        borderColor: theme.color.box,
        borderRadius: theme.radius.sm,
      }}
    />
  );
}
