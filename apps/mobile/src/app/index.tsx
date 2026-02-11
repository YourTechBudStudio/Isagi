import { ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { BacklogHealth } from "@/components/home/BacklogHealth";
import { CaptureFab } from "@/components/home/CaptureFab";
import { FocusQueue } from "@/components/home/FocusQueue";
import { Greeting } from "@/components/home/Greeting";
import { ResumeCard } from "@/components/home/ResumeCard";
import { SparkTriage } from "@/components/home/SparkTriage";
import { NebulaBackground } from "@/components/ui/NebulaBackground";
import {
  MOCK_BACKLOG,
  MOCK_FOCUS_QUEUE,
  MOCK_RESUME,
  MOCK_SPARKS,
} from "@/constants/mock-data";

export default function HomeScreen(): React.ReactElement {
  return (
    <NebulaBackground>
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
    </NebulaBackground>
  );
}
