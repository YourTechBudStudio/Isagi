import { SpeechSynthesizer } from '@yourtechbudstudio/fluidcast-core/speech';
import { layer, Session, type SessionConfig } from '@yourtechbudstudio/fluidcast-harness';
import { Context, Effect, Layer, Scope, Stream } from 'effect';
import { LanguageModel } from 'effect/ai';

import { silentWav } from './silent-wav.js';

/**
 * Real Fluidcast Harness sessions running in the page, so the fixture's runtime speaks the actual
 * session protocol (snapshots, events, rejections, pause and playback rules) instead of a
 * hand-written imitation. Only the model and the voice are fake: the model answers every turn with
 * the same short script at once, and the voice is silence.
 */

const line = (text: string) => JSON.stringify({ type: 'speak', speaker: 'host', text });
const script = `[${line('First line of the reply.')},${line('Second line.')},${line('Third line.')}]`;

const scriptedModel = LanguageModel.make({
  generateText: () => Effect.die('the fixture model only streams'),
  streamText: () => Stream.make({ type: 'text-delta' as const, id: 't', delta: script }),
});

const silentSynthesizer = SpeechSynthesizer.of({
  synthesize: () => Stream.make(silentWav()),
});

const config: SessionConfig = {
  instructions: 'Fixture voice.',
  speakers: [{ id: 'host', name: 'Host', personality: 'Dry.', voice: { name: 'alloy' } }],
  speechFormat: 'wav',
  tools: [],
  // A continuation waiting for `Start`, as a switched agent with an earlier answer opens.
  start: { message: 'Continue from where we left off.' },
};

/** Builds one live session that lives as long as the page. */
export const buildHarnessSession = (): Promise<Session['Service']> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const model = yield* scriptedModel;
      const context = yield* Layer.buildWithScope(
        layer(config).pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(LanguageModel.LanguageModel, model),
              Layer.succeed(SpeechSynthesizer, silentSynthesizer),
            ),
          ),
        ),
        scope,
      );
      return Context.get(context, Session);
    }),
  );
