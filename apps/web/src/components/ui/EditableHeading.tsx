import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";

type EditableHeadingProps = {
  readonly initialValue: string;
  readonly onSave: (value: string) => void;
  readonly className?: string;
  readonly placeholder?: string;
};

export function EditableHeading({
  initialValue,
  onSave,
  className,
  placeholder = "Untitled",
}: EditableHeadingProps) {
  const [value, setValue] = useState(initialValue);
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync state if initialValue changes externally
  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      // Optional: select all text on focus for quick replacement,
      // or place cursor at the end. Placing at the end is more Notion-like.
      const length = inputRef.current.value.length;
      inputRef.current.setSelectionRange(length, length);
    }
  }, [isEditing]);

  const handleBlur = () => {
    setIsEditing(false);
    const trimmed = value.trim();
    if (trimmed !== initialValue) {
      if (trimmed === "") {
        setValue(initialValue); // Revert if empty
      } else {
        setValue(trimmed);
        onSave(trimmed);
      }
    } else {
      setValue(initialValue);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleBlur();
    }
    if (e.key === "Escape") {
      setValue(initialValue);
      setIsEditing(false);
    }
  };

  return (
    <div
      className={cn(
        "group relative -ml-3 inline-flex items-center rounded-lg px-3 py-1 transition-colors duration-300 ease-out",
        !isEditing && "cursor-text hover:bg-white/5",
        className,
      )}
      onClick={() => setIsEditing(true)}
    >
      <div className="relative grid">
        {/* Invisible span to dictate the width of the grid cell based on text content */}
        <span className="invisible col-start-1 row-start-1 min-w-[2ch] whitespace-pre">
          {value || placeholder}
        </span>

        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={e => setValue(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={cn(
            "placeholder:text-text-tertiary col-start-1 row-start-1 m-0 w-full bg-transparent p-0 text-inherit outline-none",
            !isEditing && "pointer-events-none",
          )}
          readOnly={!isEditing}
          tabIndex={0}
        />
      </div>
    </div>
  );
}
