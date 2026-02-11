import { CaptureSheet } from "@/components/capture/CaptureSheet";

/**
 * Capture route — presented as a transparent modal.
 * Reachable via:
 *   - In-app FAB (router.push('/capture'))
 *   - Android widget deep link (isagi://capture)
 */
export default function CaptureScreen(): React.ReactElement {
  return <CaptureSheet />;
}
