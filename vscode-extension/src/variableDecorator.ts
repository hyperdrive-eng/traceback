import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LLMLogAnalysis } from './claudeService';
import { RustLogEntry } from './logExplorer';
import { 
  variableValueDecorationType, 
  clearDecorations 
} from './decorations';

/**
 * Class to handle decorating variables in the editor with their values from Rust logs
 */
export class VariableDecorator {
  private _disposables: vscode.Disposable[] = [];
  private _decorationType: vscode.TextEditorDecorationType = variableValueDecorationType;
  
  constructor(private context: vscode.ExtensionContext) {}

  /**
   * Display a variable value in the editor based on Rust log entries
   */
  async decorateVariable(
    editor: vscode.TextEditor,
    log: RustLogEntry,
    variableName: string,
    value: unknown
  ): Promise<void> {
    try {
      if (!log || !log.message) {
        console.warn('Invalid log entry provided');
        return;
      }

      const decorations: vscode.DecorationOptions[] = [];
      
      // Add decorations from the message
      this.addMessageDecorations(editor, log.message, variableName, value, decorations);
      
      // Add decorations from span fields
      if (log.span_root?.fields) {
        this.addSpanFieldDecorations(editor, log, variableName, decorations);
      }

      // Apply decorations
      editor.setDecorations(this._decorationType, decorations);
    } catch (error) {
      console.error('Error decorating variable:', error);
      // Clear any partial decorations
      editor.setDecorations(this._decorationType, []);
    }
  }

  private addMessageDecorations(
    editor: vscode.TextEditor,
    message: string,
    variableName: string,
    value: unknown,
    decorations: vscode.DecorationOptions[]
  ): void {
    const messageRegex = new RegExp(`\\b${variableName}\\b`, 'g');
    let match;
    
    while ((match = messageRegex.exec(message)) !== null) {
      const startPos = editor.document.positionAt(match.index);
      const endPos = editor.document.positionAt(match.index + variableName.length);
      
      decorations.push({
        range: new vscode.Range(startPos, endPos),
        renderOptions: {
          after: {
            contentText: ` = ${this.formatValue(value)}`,
            color: 'var(--vscode-editorInfo-foreground)'
          }
        }
      });
    }
  }

  private addSpanFieldDecorations(
    editor: vscode.TextEditor,
    log: RustLogEntry,
    variableName: string,
    decorations: vscode.DecorationOptions[]
  ): void {
    for (const field of log.span_root.fields) {
      if (field.name === variableName) {
        const index = log.message.indexOf(field.name);
        if (index !== -1) {
          const startPos = editor.document.positionAt(index);
          const endPos = editor.document.positionAt(index + field.name.length);
          
          decorations.push({
            range: new vscode.Range(startPos, endPos),
            renderOptions: {
              after: {
                contentText: ` = ${this.formatValue(field.value)}`,
                color: 'var(--vscode-editorInfo-foreground)'
              }
            }
          });
        }
      }
    }
  }

  private formatValue(value: unknown): string {
    if (typeof value === 'object' && value !== null) {
      return JSON.stringify(value, null, 2);
    }
    return String(value);
  }

  public dispose(): void {
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }
}