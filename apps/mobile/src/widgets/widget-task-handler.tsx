import React from "react";
import type { WidgetTaskHandlerProps } from "react-native-android-widget";

import { CaptureWidget } from "./CaptureWidget";

/**
 * Task handler for Android home screen widget events.
 *
 * The widget is static (no state), so we render the same
 * CaptureWidget component for all lifecycle events.
 */
export async function widgetTaskHandler(
  props: WidgetTaskHandlerProps,
): Promise<void> {
  const nameToWidget: Record<string, React.ReactElement> = {
    CaptureWidget: <CaptureWidget />,
  };

  switch (props.widgetAction) {
    case "WIDGET_ADDED":
    case "WIDGET_UPDATE":
    case "WIDGET_RESIZED":
      props.renderWidget(
        nameToWidget[props.widgetInfo.widgetName] ?? <CaptureWidget />,
      );
      break;

    case "WIDGET_DELETED":
      // Nothing to clean up for a static widget.
      break;

    case "WIDGET_CLICK":
      // Click actions are handled declaratively via OPEN_URI.
      break;

    default:
      break;
  }
}
