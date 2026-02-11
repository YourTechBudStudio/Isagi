"use no memo";

import React from "react";
import { FlexWidget, TextWidget } from "react-native-android-widget";

/**
 * Android home screen widget — tap to capture a spark.
 *
 * The entire widget surface is the tap target (no nested button).
 * Opens the capture screen via deep link.
 *
 * Catppuccin Macchiato palette (hardcoded hex — primitives don't support NativeWind):
 *   canvas:       #24273a  (Base)
 *   spark:        #7dc4e4  (Sapphire)
 *   text-primary: #cad3f5  (Text)
 *   overlay-0:    #6e738d  (Overlay 0 — used for subtle border)
 */
export function CaptureWidget(): React.ReactElement {
  return (
    <FlexWidget
      style={{
        height: "match_parent",
        width: "match_parent",
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: "#24273a",
        borderRadius: 20,
        borderWidth: 1,
        borderColor: "#494d64",
      }}
      clickAction="OPEN_URI"
      clickActionData={{ uri: "isagi://capture" }}
      accessibilityLabel="Capture a spark"
    >
      <TextWidget
        text={"\u26A1"}
        style={{
          fontSize: 24,
        }}
      />
    </FlexWidget>
  );
}
