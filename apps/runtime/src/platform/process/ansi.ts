// Matches ANSI escape sequences (CSI/OSC color, cursor, and control codes) so
// captured terminal output can be rendered as plain text in non-terminal
// surfaces such as the command palette's setup-failure diagnostic. Built via
// RegExp from escape strings so the source stays free of literal control bytes.
const ansiPattern = new RegExp(
  '[\\u001b\\u009b][[\\]()#;?]*' +
    '(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)' +
    '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  'g',
);

export function stripAnsi(value: string): string {
  return value.replace(ansiPattern, '');
}
