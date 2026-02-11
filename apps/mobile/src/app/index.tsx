import { LinearGradient } from "expo-linear-gradient";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { BacklogHealth } from "@/components/home/BacklogHealth";
import { CaptureFab } from "@/components/home/CaptureFab";
import { FocusQueue } from "@/components/home/FocusQueue";
import { Greeting } from "@/components/home/Greeting";
import { ResumeCard } from "@/components/home/ResumeCard";
import { SparkTriage } from "@/components/home/SparkTriage";
import {
  MOCK_BACKLOG,
  MOCK_FOCUS_QUEUE,
  MOCK_RESUME,
  MOCK_SPARKS,
} from "@/constants/mock-data";

export default function HomeScreen(): React.ReactElement {
  return (
    <View className="bg-canvas flex-1">
      {/* Layered nebula wash — 3 overlapping gradients at different
          angles so the color field feels organic, not striped. */}
      <LinearGradient
        colors={["rgba(198, 160, 246, 0.035)", "transparent"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0.8, y: 0.55 }}
        style={styles.washMauve}
      />
      <LinearGradient
        colors={["transparent", "rgba(138, 173, 244, 0.03)", "transparent"]}
        start={{ x: 0.6, y: 0.25 }}
        end={{ x: 0.2, y: 0.85 }}
        style={styles.washBlue}
      />
      <LinearGradient
        colors={["transparent", "rgba(145, 215, 227, 0.025)"]}
        start={{ x: 0.1, y: 0.6 }}
        end={{ x: 0.5, y: 1 }}
        style={styles.washTeal}
      />

      <SafeAreaView className="flex-1" edges={["top"]}>
        {/* ScrollView must have zero style/className — see AGENTS.md */}
        <ScrollView showsVerticalScrollIndicator={false}>
          <View className="px-6 pt-6 pb-36">
            <Greeting />
            <ResumeCard item={MOCK_RESUME} />
            <FocusQueue items={MOCK_FOCUS_QUEUE} />
            <SparkTriage sparks={MOCK_SPARKS} />
            <BacklogHealth metrics={MOCK_BACKLOG} />

            {/* Footer quip */}
            <View className="items-center pt-2 pb-6">
              <Text className="font-body text-text-tertiary text-xs">
                No code on mobile. I respect your thumbs.
              </Text>
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>

      <CaptureFab />
    </View>
  );
}

const styles = StyleSheet.create({
  /* Every layer covers the full screen — gradient start/end
     points control where color appears, no hard View edges. */
  washMauve: {
    ...StyleSheet.absoluteFillObject,
  },
  washBlue: {
    ...StyleSheet.absoluteFillObject,
  },
  washTeal: {
    ...StyleSheet.absoluteFillObject,
  },
});
