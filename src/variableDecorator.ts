import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LogEntry } from './logExplorer';
import { 
  variableValueDecorationType, 
  clearDecorations 
} from './decorations';
import { findCodeLocation } from './processor';
import { VectorStore } from './vectorSearch';

/**
 * Class to handle decorating variables in the editor with their values
 */
export class VariableDecorator {
  private currentLog: LogEntry | undefined;
  
  constructor(private context: vscode.ExtensionContext) {}
  

  /**
   * Display a variable value in the editor
   */
  async decorateVariable(
    variableName: string, 
    variableValue: any, 
    currentLog: LogEntry
  ): Promise<void> {
    try {
      // Store the current log for use in hover messages
      this.currentLog = currentLog;
      
      // Clear any existing decorations first
      clearDecorations();

      const repoPath = this.context.globalState.get<string>('repoPath');
      if (!repoPath) {
        vscode.window.showErrorMessage('Repository root path is not set.');
        return;
      }

      // Try to find the variable in the source code
      const activeEditor = vscode.window.activeTextEditor;
      
      // Function to immediately find and highlight all instances of the variable in the document
      const immediatelyHighlightReferences = async (editor: vscode.TextEditor) => {
        // Find all instances of the variable in the current document
        const document = editor.document;
        const text = document.getText();
        const allRanges: vscode.Range[] = [];
        const regexPattern = new RegExp(`\\b${variableName}\\b`, 'g');
        let match;
        
        while ((match = regexPattern.exec(text)) !== null) {
          const pos = document.positionAt(match.index);
          const line = document.lineAt(pos.line);
          const lineText = line.text;
          
          const startChar = lineText.indexOf(variableName, pos.character - pos.line);
          if (startChar === -1) continue;
          
          const endChar = startChar + variableName.length;
          allRanges.push(new vscode.Range(pos.line, startChar, pos.line, endChar));
        }
        
        if (allRanges.length > 0) {
          // Use the active selection or first occurrence as primary
          let primaryRange = allRanges[0];
          
          // Apply decorations immediately
          this.applyVariableDecoration(
            editor,
            primaryRange,
            variableValue,
            allRanges
          );
          
          // Return the ranges for further processing
          return { primaryRange, allRanges };
        }
        
        return null;
      };
      
      // Function to find location and highlight if not already active
      const findAndHighlightLocation = async () => {
        if (currentLog && currentLog.jsonPayload.target) {
          const searchResult = await this.findVariableInProject(
            repoPath,
            variableName,
            currentLog
          );
          
          if (searchResult) {
            // Open the file
            const document = await vscode.workspace.openTextDocument(searchResult.file);
            const editor = await vscode.window.showTextDocument(document);
            
            // Now that the file is open, use the immediate highlighting function
            const immediateResult = await immediatelyHighlightReferences(editor);
            
            if (!immediateResult) {
              // Fallback to the search result if no immediate references found
              const primaryRange = new vscode.Range(
                searchResult.line, 
                searchResult.startChar, 
                searchResult.line, 
                searchResult.endChar
              );
              
              let allRanges: vscode.Range[] | undefined;
              if (searchResult.allMatches && searchResult.allMatches.length > 0) {
                allRanges = searchResult.allMatches.map(m => 
                  new vscode.Range(m.line, m.startChar, m.line, m.endChar)
                );
              }
              
              // Reveal the primary range and apply standard decorations
              editor.revealRange(primaryRange, vscode.TextEditorRevealType.InCenter);
              this.applyVariableDecoration(editor, primaryRange, variableValue, allRanges);
            }
            
            return { editor, document, searchResult };
          } else {
            vscode.window.showInformationMessage(
              `Could not find variable "${variableName}" in source code.`
            );
            return null;
          }
        }
        return null;
      };
      
      // First, try to highlight in the active editor immediately
      if (activeEditor) {
        const immediateResult = await immediatelyHighlightReferences(activeEditor);
        
        if (!immediateResult) {
          // If not found in active editor, search in the project
          await findAndHighlightLocation();
        }
      } else {
        // No active editor, so search in the project
        await findAndHighlightLocation();
      }
    } catch (error) {
      console.error('Error decorating variable:', error);
    }
  }


  /**
   * Apply the decoration to show the variable value
   */
  private applyVariableDecoration(
    editor: vscode.TextEditor,
    range: vscode.Range,
    value: any,
    allRanges?: vscode.Range[]
  ): void {
    // Format the value for display
    const formattedValue = this.formatValueForDecoration(value);
    
    // Prepare variable details for hover
    const type = typeof value;
    const typeDesc = Array.isArray(value) ? 'array' : type;
    
    // Format timestamp if available
    let timestamp = '';
    if (this.currentLog && this.currentLog.timestamp) {
      const date = new Date(this.currentLog.timestamp);
      timestamp = date.toLocaleTimeString() + '.' + date.getMilliseconds(); 
    }
    
    // Create the main decoration with hover message
    const mainDecoration = { 
      range,
      renderOptions: {
        after: {
          contentText: ` = ${formattedValue}`,
          fontWeight: 'bold',
          // Use theme-consistent colors that are high contrast and visible
          color: 'var(--vscode-symbolIcon-variableForeground, var(--vscode-editorInfo-foreground))', 
        }
      },
      hoverMessage: (() => {
        const markdown = new vscode.MarkdownString(
          `**Variable: \`${range.start.character > 0 ? editor.document.getText(range) : range}\`**\n\n` +
          `**Type:** ${typeDesc}\n` +
          `**Value:** ${this.formatExtendedValue(value)}\n` +
          (timestamp ? `**Timestamp:** ${timestamp}\n` : '') +
          (allRanges && allRanges.length > 1 ? `*${allRanges.length} occurrences found in this file*\n` : '') +
          `\n*From log in: ${this.currentLog?.jsonPayload.target || 'unknown location'}*\n\n` +
          `[Show in Variables](command:traceback.showLogs)`
        );
        // Enable command links in the markdown
        markdown.isTrusted = true;
        return markdown;
      })()
    };

    // Standard decorations
    // For the additional occurrences, create simpler decorations
    let decorations = [mainDecoration];
    
    if (allRanges && allRanges.length > 1) {
      // Filter out the primary range that already has the main decoration
      const secondaryRanges = allRanges.filter(r => 
        !(r.start.line === range.start.line && r.start.character === range.start.character));
      
      // Create decorations for all other occurrences - lighter styling
      const secondaryDecorations = secondaryRanges.map(r => ({
        range: r,
        renderOptions: {
          after: {
            contentText: ` = ${formattedValue}`,
            fontWeight: 'normal', // Less bold than the primary
            color: 'var(--vscode-symbolIcon-variableForeground, var(--vscode-editorInfo-foreground))',
            opacity: '0.8' // Slightly more transparent than the primary
          }
        },
        hoverMessage: mainDecoration.hoverMessage // Reuse the hover message
      }));
      
      // Add these to our decoration collection
      decorations = [...decorations, ...secondaryDecorations];
    }
    
    // Apply all decorations
    editor.setDecorations(variableValueDecorationType, decorations);
  }

  /**
   * Format a value for display in a decoration
   */
  private formatValueForDecoration(value: any): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    
    const type = typeof value;
    
    if (type === 'string') {
      if (value.length > 50) {
        return `"${value.substring(0, 47)}..."`;
      }
      return `"${value}"`;
    }
    
    if (type === 'object') {
      if (Array.isArray(value)) {
        if (value.length <= 3) {
          return `[${value.map(v => this.formatValueForDecoration(v)).join(', ')}]`;
        }
        return `Array(${value.length})`;
      }
      return JSON.stringify(value);
    }
    
    return String(value);
  }
  
  /**
   * Format a value with more detail for hover displays
   */
  private formatExtendedValue(value: any): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    
    const type = typeof value;
    
    if (type === 'string') {
      return `"${value}"`;
    }
    
    if (type === 'object') {
      if (Array.isArray(value)) {
        if (value.length <= 10) {
          return `[\n  ${value.map(v => this.formatValueForDecoration(v)).join(',\n  ')}\n]`;
        }
        return `Array with ${value.length} items`;
      }
      
      try {
        // Pretty print JSON with 2-space indentation
        return '```json\n' + JSON.stringify(value, null, 2) + '\n```';
      } catch (error) {
        return String(value);
      }
    }
    
    return String(value);
  }

  /**
   * Search for a variable in the project
   */
  private async findVariableInProject(
    repoPath: string,
    variableName: string,
    log: LogEntry
  ): Promise<{ 
    file: string; 
    line: number; 
    startChar: number; 
    endChar: number;
    allMatches?: Array<{ line: number; startChar: number; endChar: number }>;
  } | undefined> {
    try {
      // Initialize vector store if needed
      const vectorStore = VectorStore.getInstance();
      await vectorStore.indexWorkspace(repoPath);

      // Search for the variable using vector search
      const results = await vectorStore.search(variableName, 10);

      if (results.length > 0) {
        // Find the best match that actually contains the variable name
        for (const result of results) {
          const content = fs.readFileSync(result.file, 'utf8');
          const lines = content.split('\n');
          const line = lines[result.line];

          // Find the exact position of the variable in the line
          const startChar = line.indexOf(variableName);
          if (startChar >= 0) {
            // Make sure it's a proper variable reference
            const charBefore = startChar > 0 ? line[startChar - 1] : ' ';
            const charAfter = line[startChar + variableName.length];
            
            if (!/[a-zA-Z0-9_]/.test(charBefore) && (!/[a-zA-Z0-9_]/.test(charAfter) || !charAfter)) {
              // Find all other matches in the file
              const allMatches: Array<{ line: number; startChar: number; endChar: number }> = [];
              
              lines.forEach((lineText, lineNum) => {
                let pos = 0;
                while ((pos = lineText.indexOf(variableName, pos)) >= 0) {
                  const before = pos > 0 ? lineText[pos - 1] : ' ';
                  const after = lineText[pos + variableName.length];
                  
                  if (!/[a-zA-Z0-9_]/.test(before) && (!/[a-zA-Z0-9_]/.test(after) || !after)) {
                    allMatches.push({
                      line: lineNum,
                      startChar: pos,
                      endChar: pos + variableName.length
                    });
                  }
                  pos += variableName.length;
                }
              });

              return {
                file: result.file,
                line: result.line,
                startChar,
                endChar: startChar + variableName.length,
                allMatches
              };
            }
          }
        }
      }

      // If vector search didn't find a good match, try the old method
      const filePaths = await this.findRelevantFiles(repoPath, log.jsonPayload.target || '');
      
      for (const filePath of filePaths) {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        
        // Find all matches in this file
        const allMatches: Array<{ line: number; startChar: number; endChar: number }> = [];
        
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          let pos = 0;
          
          while ((pos = line.indexOf(variableName, pos)) >= 0) {
            const before = pos > 0 ? line[pos - 1] : ' ';
            const after = line[pos + variableName.length];
            
            if (!/[a-zA-Z0-9_]/.test(before) && (!/[a-zA-Z0-9_]/.test(after) || !after)) {
              allMatches.push({
                line: i,
                startChar: pos,
                endChar: pos + variableName.length
              });
            }
            pos += variableName.length;
          }
        }
        
        if (allMatches.length > 0) {
          // Use the first match as the primary one
          return {
            file: filePath,
            line: allMatches[0].line,
            startChar: allMatches[0].startChar,
            endChar: allMatches[0].endChar,
            allMatches
          };
        }
      }

      return undefined;
    } catch (error) {
      console.error('Error searching for variable:', error);
      return undefined;
    }
  }

  /**
   * Find relevant files to search for the variable
   */
  private async findRelevantFiles(repoPath: string, targetPath: string): Promise<string[]> {
    // For simplicity in the MVP, just return a curated list of files
    // This can be expanded to use more sophisticated search strategies later
    
    const sourceExtensions = ['.rs', '.ts', '.js', '.tsx', '.jsx', '.go', '.py', '.java'];
    const results: string[] = [];
    
    // Start with active editor if available
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      results.push(activeEditor.document.uri.fsPath);
    }
    
    // Find files based on target path if available
    if (targetPath) {
      const targetSegments = targetPath.split('/').filter(Boolean);
      
      // Try to match files in common directories that match any part of the target path
      for (const segment of targetSegments) {
        const files = await vscode.workspace.findFiles(
          `**/*${segment}*{${sourceExtensions.join(',')}}`,
          '**/node_modules/**',
          10
        );
        
        files.forEach(file => {
          if (!results.includes(file.fsPath)) {
            results.push(file.fsPath);
          }
        });
      }
    }
    
    return results;
  }
}