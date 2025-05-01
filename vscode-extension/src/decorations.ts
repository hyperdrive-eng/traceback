import * as vscode from 'vscode';

// Create decoration type for highlighting log lines
export const logLineDecorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(255, 255, 0, 0.2)',
  isWholeLine: true,
});

// Create decoration type for variable values
export const variableValueDecorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(65, 105, 225, 0.4)', // Made more opaque
  borderWidth: '2px', // Made thicker
  borderStyle: 'solid',
  borderColor: 'rgba(65, 105, 225, 0.7)', // Made more opaque
  after: {
    margin: '0 0 0 1em',
    contentText: 'test', // Added default text to test if decoration is working
    color: 'var(--vscode-editorInfo-foreground)',
    fontWeight: 'bold',
  },
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

export function clearDecorations(): void {
  // Clear all decorations
  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(logLineDecorationType, []);
    editor.setDecorations(variableValueDecorationType, []);
  }
}