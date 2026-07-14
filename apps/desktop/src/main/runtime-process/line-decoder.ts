export interface DecodedLine {
  readonly payload: string;
  readonly ending: '' | '\n' | '\r\n';
}

/** Incrementally decodes UTF-8 chunks into lines without trimming or normalizing payload bytes. */
export class LosslessLineDecoder {
  readonly #decoder = new TextDecoder('utf-8');
  #carry = '';

  write(chunk: Uint8Array): readonly DecodedLine[] {
    this.#carry += this.#decoder.decode(chunk, { stream: true });
    return this.#takeCompleteLines();
  }

  end(): readonly DecodedLine[] {
    this.#carry += this.#decoder.decode();
    const complete = this.#takeCompleteLines();
    if (this.#carry.length === 0) return complete;
    const finalLine = { payload: this.#carry, ending: '' as const };
    this.#carry = '';
    return [...complete, finalLine];
  }

  #takeCompleteLines(): readonly DecodedLine[] {
    const lines: DecodedLine[] = [];
    let start = 0;
    for (let index = 0; index < this.#carry.length; index += 1) {
      if (this.#carry[index] !== '\n') continue;
      const hasCarriageReturn = index > start && this.#carry[index - 1] === '\r';
      lines.push({
        payload: this.#carry.slice(start, hasCarriageReturn ? index - 1 : index),
        ending: hasCarriageReturn ? '\r\n' : '\n',
      });
      start = index + 1;
    }
    this.#carry = this.#carry.slice(start);
    return lines;
  }
}
