/**
 * Whether a key event's target edits text: a form control or contenteditable content. Duck-typed
 * rather than `instanceof HTMLElement`, so it also answers for elements of another same-origin
 * document's realm.
 */
export function isEditableEventTarget(target: EventTarget | null): boolean {
  if (target === null || typeof (target as Partial<Element>).closest !== 'function') {
    return false;
  }
  const element = target as HTMLElement;
  const tagName = element.tagName.toLowerCase();
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    element.isContentEditable === true ||
    Boolean(element.closest('[contenteditable="true"]'))
  );
}
