/**
 * Custom entry point for the Expo Router app.
 *
 * This replaces the default `expo-router/entry` so we can also
 * register the Android widget task handler alongside the app.
 */
import "expo-router/entry";
import { registerWidgetTaskHandler } from "react-native-android-widget";

import { widgetTaskHandler } from "./src/widgets/widget-task-handler";

registerWidgetTaskHandler(widgetTaskHandler);
