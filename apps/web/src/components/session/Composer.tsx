import {
  ChevronRight,
  CornerDownRight,
  FileCode,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";

type ComposerProps = {
  readonly modeLabel: string;
  readonly modelLabel: string;
  readonly speedLabel: string;
  readonly placeholder: string;
  readonly disclaimer: string;
};

export function Composer({
  modeLabel,
  modelLabel,
  speedLabel,
  placeholder,
  disclaimer,
}: ComposerProps) {
  return (
    <div className="from-canvas via-canvas pointer-events-none absolute right-0 bottom-0 left-0 bg-linear-to-t to-transparent p-6 pt-12">
      <div className="pointer-events-auto mx-auto max-w-3xl">
        <div className="bg-canvas-elevated focus-within:border-accent-violet/50 focus-within:ring-accent-violet/20 overflow-hidden rounded-2xl border border-white/10 shadow-2xl transition-all focus-within:ring-1">
          <div className="p-4 pb-2">
            <textarea
              className="text-text-primary placeholder:text-text-tertiary max-h-50 min-h-11 w-full resize-none bg-transparent text-[15px] focus:outline-none"
              placeholder={placeholder}
              rows={1}
            />
          </div>

          <div className="flex items-center justify-between border-t border-white/5 bg-white/2 px-3 py-2.5">
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                leadingIcon={
                  <Sparkles className="text-accent-violet h-3.5 w-3.5" />
                }
                trailingIcon={
                  <ChevronRight className="h-3 w-3 rotate-90 opacity-50" />
                }
                className="font-medium"
              >
                {modeLabel}
              </Button>

              <div className="mx-1 h-3 w-px bg-white/10" />

              <Button
                variant="ghost"
                size="sm"
                trailingIcon={
                  <ChevronRight className="h-3 w-3 rotate-90 opacity-50" />
                }
                className="font-medium"
              >
                {modelLabel}
              </Button>

              <Button
                variant="ghost"
                size="sm"
                trailingIcon={
                  <ChevronRight className="h-3 w-3 rotate-90 opacity-50" />
                }
                className="font-medium"
              >
                {speedLabel}
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <IconButton
                icon={<FileCode className="h-4 w-4" />}
                variant="subtle"
                size="sm"
              />
              <IconButton
                icon={<CornerDownRight className="h-4 w-4" />}
                size="sm"
                className="text-text-primary bg-white/10 hover:bg-white/20"
              />
            </div>
          </div>
        </div>

        <div className="text-text-tertiary mt-3 text-center text-[11px] font-light">
          {disclaimer}
        </div>
      </div>
    </div>
  );
}
