import { useCallback, useRef } from "react";
import {
  type NativeSyntheticEvent,
  TextInput,
  type TextInputSelectionChangeEventData,
} from "react-native";

/** Regex for a bullet line: optional leading whitespace + `- ` + content. */
const BULLET_RE = /^(\s*)-\s(.*)$/;

interface SparkInputProps {
  readonly value: string;
  readonly onChangeText: (text: string) => void;
  readonly onContentSizeChange: (height: number) => void;
}

/**
 * Multiline text input with markdown-ish bullet continuation.
 *
 * Uses an onChangeText diff approach (not onKeyPress) because
 * Android soft keyboards don't reliably fire onKeyPress for Enter,
 * and React Native TextInput doesn't support e.preventDefault().
 *
 * When the user inserts a newline after a `- ` line:
 *   - If line has content after the bullet → new line with same indent + `- `
 *   - If line is an empty bullet → remove the bullet
 */
export function SparkInput({
  value,
  onChangeText,
  onContentSizeChange,
}: SparkInputProps): React.ReactElement {
  const prevTextRef = useRef(value);
  const selectionRef = useRef({ start: 0, end: 0 });
  const inputRef = useRef<TextInput>(null);

  const handleSelectionChange = useCallback(
    (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      selectionRef.current = e.nativeEvent.selection;
    },
    [],
  );

  const handleChangeText = useCallback(
    (newText: string) => {
      const oldText = prevTextRef.current;

      // Detect a single newline insertion by checking if the new text
      // is the old text with a `\n` inserted somewhere.
      const lengthDiff = newText.length - oldText.length;

      if (lengthDiff === 1) {
        // Find where the newline was inserted
        const insertPos = findInsertionPoint(oldText, newText);

        if (insertPos !== -1 && newText[insertPos] === "\n") {
          // Get the line before the newline
          const before = newText.slice(0, insertPos);
          const lastNewline = before.lastIndexOf("\n");
          const currentLine = before.slice(lastNewline + 1);

          const match = BULLET_RE.exec(currentLine);
          if (match) {
            const indent = match[1]; // leading whitespace
            const content = match[2]; // text after `- `

            if (content.length === 0) {
              // Empty bullet: remove the `- ` prefix and the newline
              const lineStart = lastNewline + 1;
              const cleaned =
                newText.slice(0, lineStart) + newText.slice(insertPos + 1);
              prevTextRef.current = cleaned;
              onChangeText(cleaned);

              requestAnimationFrame(() => {
                inputRef.current?.setSelection(lineStart, lineStart);
              });
              return;
            }

            // Continue bullet: insert same indent + `- ` after the newline
            const continuation = `${indent}- `;
            const withBullet =
              newText.slice(0, insertPos + 1) +
              continuation +
              newText.slice(insertPos + 1);
            prevTextRef.current = withBullet;
            onChangeText(withBullet);

            const newCursor = insertPos + 1 + continuation.length;
            requestAnimationFrame(() => {
              inputRef.current?.setSelection(newCursor, newCursor);
            });
            return;
          }
        }
      }

      // Default: pass through unchanged
      prevTextRef.current = newText;
      onChangeText(newText);
    },
    [onChangeText],
  );

  return (
    <TextInput
      ref={inputRef}
      value={value}
      onChangeText={handleChangeText}
      onSelectionChange={handleSelectionChange}
      onContentSizeChange={e =>
        onContentSizeChange(e.nativeEvent.contentSize.height)
      }
      multiline
      autoFocus
      textAlignVertical="top"
      placeholder={"What's on your mind? I promise not to judge... much."}
      placeholderTextColor="#6e738d"
      className="font-body text-text-primary min-h-[100px] flex-1 text-base leading-6"
    />
  );
}

/**
 * Find the index where a single character was inserted.
 * Returns -1 if the diff isn't a clean single-char insertion.
 */
function findInsertionPoint(oldText: string, newText: string): number {
  // Walk from the start to find where they diverge
  let i = 0;
  while (i < oldText.length && oldText[i] === newText[i]) {
    i++;
  }
  return i;
}
