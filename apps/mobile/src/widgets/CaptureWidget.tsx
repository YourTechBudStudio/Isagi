"use no memo";

import React from "react";
import { FlexWidget, SvgWidget, TextWidget } from "react-native-android-widget";

const CAPTURE_BOLT_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13 2L5 14H11L10 22L19 10H13L13 2Z" stroke="#7dc4e4" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

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
 *   surface-1:    #494d64  (Surface 1 — used for subtle border)
 */
export function CaptureWidget(): React.ReactElement {
  return (
    <FlexWidget
      style={{
        height: "match_parent",
        width: "match_parent",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 16,
        backgroundColor: "#24273a",
        borderRadius: 20,
        borderWidth: 1,
        borderColor: "#494d64",
      }}
      clickAction="OPEN_URI"
      clickActionData={{ uri: "isagi://capture" }}
      accessibilityLabel="Commit a spark"
    >
      <SvgWidget
        svg={CAPTURE_BOLT_SVG}
        style={{
          width: 30,
          height: 30,
          marginRight: 10,
        }}
      />
      <TextWidget
        text="Capture"
        maxLines={1}
        truncate="END"
        style={{
          color: "#cad3f5",
          fontSize: 19,
          fontWeight: "700",
          letterSpacing: 0.3,
        }}
      />
    </FlexWidget>
  );
}
