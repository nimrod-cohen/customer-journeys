// A number field you can TYPE in freely; the value is read and applied only when you
// leave the field or press Enter.
//
// Why not a plain onChange: the app loads preact/compat, which turns an input's
// onChange into a per-KEYSTROKE event. A field that parsed and rewrote itself on each
// keystroke erased the dot of "1." and turned "1.4" into 14 (clamped to 3). The raw
// text lives in local state while focused and is only synced from the stored value
// when the field is not being edited.
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

type InputProps = Omit<JSX.IntrinsicElements['input'], 'value' | 'onInput' | 'onChange' | 'onBlur' | 'onKeyDown'>;

export function CommitInput<T extends number>(
  props: InputProps & {
    value: T | undefined;
    /** Raw text → the value to store (undefined = clear back to the default). */
    parse: (raw: string) => T | undefined;
    onCommit: (v: T | undefined) => void;
  },
): JSX.Element {
  const { value, parse, onCommit, ...rest } = props;
  const shown = value === undefined ? '' : String(value);
  const [text, setText] = useState(shown);
  const editing = useRef(false);

  // Follow the stored value (undo, another tab's change) — but never mid-typing.
  useEffect(() => {
    if (!editing.current) setText(shown);
  }, [shown]);

  const commit = (raw: string): void => {
    editing.current = false;
    const v = parse(raw);
    setText(v === undefined ? '' : String(v));
    if (v !== value) onCommit(v);
  };

  return (
    <input
      type="text"
      {...rest}
      value={text}
      onInput={(e) => {
        editing.current = true;
        setText((e.target as HTMLInputElement).value);
      }}
      onBlur={(e) => commit((e.target as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
      }}
    />
  );
}
