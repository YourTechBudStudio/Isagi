import { motion } from "framer-motion";
import { ArrowRight, Clock, Play, Zap } from "lucide-react";

import { getHomeRevealTransition } from "@/components/home/homeMotion";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import type { HomeResumeContext } from "@/lib/mock/home.mock";

type HomeResumeHeroProps = {
  readonly context: HomeResumeContext;
};

export function HomeResumeHero({ context }: HomeResumeHeroProps) {
  const isScratch = context.kind === "scratch";

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={getHomeRevealTransition(0.1)}
      className="mb-12"
    >
      <SectionHeading
        icon={
          <Play
            className={
              isScratch
                ? "fill-accent-cyan/20 text-accent-cyan h-5 w-5"
                : "fill-accent-blue/20 text-accent-blue h-5 w-5"
            }
          />
        }
        title="Resume Context"
      />

      <div className="group relative cursor-pointer">
        <div
          className={
            isScratch
              ? "from-accent-cyan/20 to-accent-blue/15 absolute -inset-0.5 rounded-2xl bg-gradient-to-r opacity-0 blur transition duration-700 group-hover:opacity-40"
              : "from-accent-blue/20 to-accent-cyan/20 absolute -inset-0.5 rounded-2xl bg-gradient-to-r opacity-0 blur transition duration-700 group-hover:opacity-40"
          }
        />

        <SurfaceCard
          tone={isScratch ? "cyan" : "blue"}
          className="relative overflow-hidden p-6 transition-all duration-500"
        >
          <div
            className={
              isScratch
                ? "bg-accent-cyan/10 pointer-events-none absolute top-0 right-0 translate-x-16 -translate-y-16 rounded-full p-32 blur-3xl"
                : "bg-accent-blue/10 pointer-events-none absolute top-0 right-0 translate-x-16 -translate-y-16 rounded-full p-32 blur-3xl"
            }
          />
          <div className="relative z-10 flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <span
                  className={
                    isScratch
                      ? "group-hover:text-accent-cyan text-text-primary text-xl font-medium transition-colors duration-300"
                      : "group-hover:text-accent-blue text-text-primary text-xl font-medium transition-colors duration-300"
                  }
                >
                  {context.title}
                </span>
                {isScratch && (
                  <Badge tone="cyan" icon={<Zap className="h-3 w-3" />}>
                    Scratch
                  </Badge>
                )}
                <Badge
                  tone={isScratch ? "cyan" : "blue"}
                  icon={<Clock className="h-3 w-3" />}
                  className={
                    isScratch
                      ? "border-accent-cyan/10"
                      : "border-accent-blue/10"
                  }
                >
                  {context.lastActiveLabel}
                </Badge>
              </div>
              <p className="text-text-secondary text-sm font-light">
                {context.projectLabel}
              </p>
            </div>
            <Button
              variant="primary"
              size="lg"
              trailingIcon={<ArrowRight className="h-4 w-4" />}
              className="w-full group-hover:scale-105 md:w-auto"
            >
              Jump In
            </Button>
          </div>
        </SurfaceCard>
      </div>
    </motion.section>
  );
}
