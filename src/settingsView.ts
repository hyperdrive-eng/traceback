import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { loadLogs } from './processor';

/**
 * Settings webview panel for managing traceback extension settings
 */
export class SettingsView {
  public static currentPanel: SettingsView | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private readonly _extensionContext: vscode.ExtensionContext;

  /**
   * Create or show the settings panel
   */
  public static createOrShow(extensionContext: vscode.ExtensionContext) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // If we already have a panel, show it
    if (SettingsView.currentPanel) {
      SettingsView.currentPanel._panel.reveal(column);
      return;
    }

    // Otherwise, create a new panel
    const panel = vscode.window.createWebviewPanel(
      'tracebackSettings',
      'TraceBack Settings',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(extensionContext.extensionPath, 'resources'))
        ]
      }
    );

    SettingsView.currentPanel = new SettingsView(panel, extensionContext);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this._panel = panel;
    this._extensionContext = context;

    // Initial content
    this._update();

    // Listen for when the panel is disposed
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Update the content when the view changes
    this._panel.onDidChangeViewState(
      e => {
        if (this._panel.visible) {
          this._update();
        }
      },
      null,
      this._disposables
    );

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async message => {
        switch (message.command) {
          case 'selectLogFile':
            await this._selectLogFile();
            break;
          case 'loadFromUrl':
            await this._loadFromUrl(message.url);
            break;
          case 'loadFromText':
            await this._loadFromText(message.text);
            break;
          case 'loadRustLogs':
            await this._loadRustLogs(message.text);
            break;
          case 'saveAxiomSettings':
            await this._saveAxiomSettings(message.apiKey, message.dataset, message.query);
            break;
          case 'selectRepository':
            await this._selectRepository();
            break;
        }
      },
      null,
      this._disposables
    );
  }

  /**
   * Handle log file selection
   */
  private async _selectLogFile() {
    const options: vscode.OpenDialogOptions = {
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Select Log File',
      filters: {
        'Log Files': ['log', 'json'],
        'All Files': ['*'],
      },
    };

    const fileUri = await vscode.window.showOpenDialog(options);
    if (fileUri && fileUri[0]) {
      const logPath = fileUri[0].fsPath;
      try {
        // Read the file content
        const content = fs.readFileSync(logPath, 'utf8');
        
        // Save both the file path and content
        await this._extensionContext.globalState.update('logFilePath', logPath);
        await this._extensionContext.globalState.update('logContent', content);
        
        // Refresh logs in the explorer
        vscode.commands.executeCommand('traceback.refreshLogs');
        
        // Notify webview about the change
        this._panel.webview.postMessage({ 
          command: 'updateLogFilePath', 
          path: logPath
        });
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to read log file: ${error}`);
      }
    }
  }

  /**
   * Handle loading logs from a URL
   */
  private async _loadFromUrl(url: string) {
    if (!url || !url.startsWith('http')) {
      vscode.window.showErrorMessage('Please enter a valid URL starting with http:// or https://');
      return;
    }

    await this._extensionContext.globalState.update('logFilePath', url);
    
    // Refresh logs in the explorer
    vscode.commands.executeCommand('traceback.refreshLogs');
    
    // Notify webview of success
    this._panel.webview.postMessage({ 
      command: 'updateStatus', 
      message: `Loaded logs from URL: ${url}`
    });
  }

  /**
   * Handle loading logs from pasted text
   */
  private async _loadFromText(text: string) {
    if (!text || text.trim().length === 0) {
      vscode.window.showErrorMessage('Please paste log content first');
      return;
    }

    try {
      // Create a temporary file in the OS temp directory
      const tempDir = path.join(this._extensionContext.globalStorageUri.fsPath, 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const tempFilePath = path.join(tempDir, `pasted_logs_${Date.now()}.log`);
      fs.writeFileSync(tempFilePath, text);

      // Save both the file path and content
      await this._extensionContext.globalState.update('logFilePath', tempFilePath);
      await this._extensionContext.globalState.update('logContent', text);
      
      // Refresh logs in the explorer
      vscode.commands.executeCommand('traceback.refreshLogs');
      
      // Notify webview of success
      this._panel.webview.postMessage({ 
        command: 'updateStatus', 
        message: 'Loaded logs from pasted text'
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to process pasted logs: ${error}`);
    }
  }

  private async _loadRustLogs(text: string) {
    if (!text || text.trim().length === 0) {
      vscode.window.showErrorMessage('Please paste Rust log content first');
      return;
    }

    try {
      console.log('Processing Rust logs...');
      
      // First parse the logs to validate them
      const logs = await loadLogs(text);
      if (!logs || logs.length === 0) {
        vscode.window.showErrorMessage('No valid Rust logs found in the content');
        return;
      }
      
      // Create a temporary file in the OS temp directory
      const tempDir = path.join(this._extensionContext.globalStorageUri.fsPath, 'temp');
      console.log('Temp directory:', tempDir);
      
      if (!fs.existsSync(tempDir)) {
        console.log('Creating temp directory...');
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const tempFilePath = path.join(tempDir, `rust_logs_${Date.now()}.log`);
      console.log('Writing to temp file:', tempFilePath);
      
      // Split the text into lines and process each line
      const lines = text.split('\n');
      const processedLines = lines.map(line => {
        // Skip empty lines
        if (!line.trim()) return '';
        
        // Check if it's already in the right format
        if (line.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)) {
          return line;
        }
        
        // Convert Python-style timestamp to ISO format
        const match = line.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(INFO|WARN|ERROR|DEBUG)\s+\[([^\]]+)\]\s+(.+)$/);
        if (match) {
          const [_, timestamp, level, source, message] = match;
          // Convert space to T in timestamp
          const isoTimestamp = timestamp.replace(' ', 'T');
          return `${isoTimestamp}Z  ${level} ${source}: ${message}`;
        }
        
        return line;
      }).join('\n');

      // Ensure the text ends with a newline
      const normalizedText = processedLines.endsWith('\n') ? processedLines : processedLines + '\n';
      fs.writeFileSync(tempFilePath, normalizedText);

      console.log('Setting global state...');
      // Save both the file path and content
      await this._extensionContext.globalState.update('logFilePath', tempFilePath);
      await this._extensionContext.globalState.update('logContent', normalizedText);
      await this._extensionContext.globalState.update('logFormat', 'rust');
      
      // Show success message to user
      vscode.window.showInformationMessage('Rust logs loaded successfully');
      
      // Refresh logs in the explorer
      console.log('Refreshing logs...');
      await vscode.commands.executeCommand('traceback.refreshLogs');
      
      // Notify webview of success
      this._panel.webview.postMessage({ 
        command: 'updateStatus', 
        message: 'Loaded Rust logs successfully'
      });

      // Update the current file path display
      this._panel.webview.postMessage({
        command: 'updateLogFilePath',
        path: tempFilePath
      });
    } catch (error) {
      console.error('Error processing Rust logs:', error);
      vscode.window.showErrorMessage(`Failed to process Rust logs: ${error}`);
    }
  }

  /**
   * Handle saving Axiom settings and loading a trace
   */
  private async _saveAxiomSettings(apiKey: string, dataset: string, query: string) {
    if (apiKey) {
      await this._extensionContext.secrets.store('axiom-token', apiKey);
    }

    if (dataset) {
      await this._extensionContext.globalState.update('axiomDataset', dataset);
    }

    // If query is a trace ID, load it
    if (query && query.trim()) {
      await this._extensionContext.globalState.update('axiomTraceId', query);
      await this._extensionContext.globalState.update('logFilePath', `axiom:${query}`);
      
      // Refresh logs in the explorer
      vscode.commands.executeCommand('traceback.refreshLogs');
      
      // Notify webview of success
      this._panel.webview.postMessage({ 
        command: 'updateStatus', 
        message: `Loading Axiom trace: ${query}`
      });
    }
  }

  /**
   * Handle repository selection
   */
  private async _selectRepository() {
    const options: vscode.OpenDialogOptions = {
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select Repository Root',
      title: 'Select Repository Root Directory',
    };

    const fileUri = await vscode.window.showOpenDialog(options);
    if (fileUri && fileUri[0]) {
      const repoPath = fileUri[0].fsPath;
      await this._extensionContext.globalState.update('repoPath', repoPath);

      // Open the selected folder in VS Code
      await vscode.commands.executeCommand('vscode.openFolder', fileUri[0], {
        forceNewWindow: false,
      });

      // Show confirmation message
      vscode.window.showInformationMessage(`Repository path set to: ${repoPath}`);
    }
  }

  /**
   * Update webview content
   */
  private _update() {
    this._panel.title = 'TraceBack Settings';
    this._panel.webview.html = this._getHtmlForWebview();
  }

  /**
   * Generate HTML content for the webview
   */
  private _getHtmlForWebview() {
    // Get current settings
    const logFilePath = this._extensionContext.globalState.get<string>('logFilePath') || '';
    const repoPath = this._extensionContext.globalState.get<string>('repoPath') || '';

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>TraceBack Settings</title>
      <style>
        body {
          font-family: var(--vscode-font-family);
          color: var(--vscode-foreground);
          padding: 20px;
          max-width: 800px;
          margin: 0 auto;
        }
        header {
          display: flex;
          align-items: center;
          margin-bottom: 20px;
        }
        header img {
          width: 32px;
          height: 32px;
          margin-right: 10px;
        }
        h1 {
          font-size: 24px;
          font-weight: 600;
          margin: 0;
        }
        h2 {
          font-size: 18px;
          margin-top: 30px;
          margin-bottom: 10px;
          padding-bottom: 5px;
          border-bottom: 1px solid var(--vscode-panel-border);
        }
        h3 {
          font-size: 15px;
          margin-top: 20px;
          margin-bottom: 10px;
        }
        label {
          display: block;
          margin-bottom: 5px;
          color: var(--vscode-input-placeholderForeground);
        }
        input[type="text"], 
        input[type="password"],
        textarea {
          width: 100%;
          padding: 6px 8px;
          margin-bottom: 10px;
          background-color: var(--vscode-input-background);
          color: var(--vscode-input-foreground);
          border: 1px solid var(--vscode-input-border);
          border-radius: 2px;
          font-family: var(--vscode-font-family);
          font-size: var(--vscode-font-size);
        }
        input::placeholder,
        textarea::placeholder {
          color: var(--vscode-input-placeholderForeground);
          opacity: 0.7;
        }
        textarea.code-sample {
          height: 200px;
          font-family: var(--vscode-editor-font-family);
          line-height: 1.4;
          white-space: pre;
          tab-size: 2;
        }
        button {
          background-color: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          padding: 8px 12px;
          border-radius: 2px;
          cursor: pointer;
          font-family: var(--vscode-font-family);
          font-size: var(--vscode-font-size);
        }
        button:hover {
          background-color: var(--vscode-button-hoverBackground);
        }
        button:focus {
          outline: 1px solid var(--vscode-focusBorder);
          outline-offset: 2px;
        }
        .current-setting {
          margin-top: 5px;
          font-size: 12px;
          color: var(--vscode-descriptionForeground);
          font-style: italic;
        }
        .status {
          margin-top: 10px;
          padding: 8px;
          font-size: 13px;
          color: var(--vscode-notificationsInfoForeground);
          background-color: var(--vscode-notificationsInfoBackground);
          border-radius: 3px;
          display: none;
        }
        .setting-group {
          margin-bottom: 24px;
          padding: 12px;
          background-color: var(--vscode-editor-inactiveSelectionBackground);
          border-radius: 4px;
        }
        .setting-group:hover {
          background-color: var(--vscode-list-hoverBackground);
        }
      </style>
    </head>
    <body>
      <header>
        <h1>TraceBack Settings</h1>
      </header>
      
      <h2>Choose Data Source</h2>
      
      <div class="setting-group">
        <h3>Paste Rust Logs</h3>
        <label for="rustLogText">Paste Rust tracing logs:</label>
        <textarea id="rustLogText" class="code-sample" placeholder="2025-04-03T14:15:13.968281Z  INFO page_service_conn_main{peer_addr=127.0.0.1:60242 application_name=2915355 compute_mode=primary}:process_query{tenant_id=242066e8130a6fff431b8a53c160bdb7 timeline_id=4a5ba23fbb94b79e2bd7fdd36e080b2a}:handle_pagerequests:request:handle_get_page_request{rel=1663/5/16396 blkno=12750 req_lsn=FFFFFFFF/FFFFFFFF shard_id=0000}: handle_get_page_at_lsn_request_batched:tokio_epoll_uring_ext::thread_local_system{thread_local=12 attempt_no=0}: successfully launched system"></textarea>
        <button id="loadRustText">Parse and Load</button>
      </div>

      <div class="setting-group">
        <h3>Upload Log File</h3>
        <button id="selectFile">Select File</button>
        <div class="current-setting" id="currentLogFile">
          ${logFilePath ? `Current: ${logFilePath}` : 'No file selected'}
        </div>
      </div>
      
      <h2>Select Repository</h2>
      <div class="setting-group">
        <button id="selectRepo">Select Repository</button>
        <div class="current-setting" id="currentRepoPath">
          ${repoPath ? `Current: ${repoPath}` : 'No repository selected'}
        </div>
      </div>
      
      <div id="statusMessage" class="status"></div>
      
      <script>
        const vscode = acquireVsCodeApi();
        
        // Event listeners for buttons
        document.getElementById('selectFile').addEventListener('click', () => {
          vscode.postMessage({ command: 'selectLogFile' });
        });
        
        document.getElementById('loadRustText').addEventListener('click', () => {
          try {
            const textarea = document.getElementById('rustLogText');
            const text = textarea.value;
            
            if (!text || text.trim().length === 0) {
              showStatus('Please paste Rust log content first');
              return;
            }
            
            console.log('Sending Rust logs to extension...');
            vscode.postMessage({ command: 'loadRustLogs', text });
            
            // Clear the textarea after successful send
            textarea.value = '';
            showStatus('Processing Rust logs...');
          } catch (error) {
            console.error('Error sending Rust logs:', error);
            showStatus('Error sending Rust logs: ' + error.message);
          }
        });
        
        document.getElementById('selectRepo').addEventListener('click', () => {
          vscode.postMessage({ command: 'selectRepository' });
        });
        
        // Clear placeholder when focusing on textarea
        const rustLogText = document.getElementById('rustLogText');
        rustLogText.addEventListener('focus', function() {
          if (this.placeholder === this.getAttribute('placeholder')) {
            this.placeholder = '';
          }
        });
        
        rustLogText.addEventListener('blur', function() {
          if (!this.value) {
            this.placeholder = this.getAttribute('placeholder');
          }
        });
        
        // Handle messages from the extension
        window.addEventListener('message', event => {
          const message = event.data;
          switch (message.command) {
            case 'updateLogFilePath':
              document.getElementById('currentLogFile').textContent = \`Current: \${message.path}\`;
              showStatus('Log file selected successfully');
              break;
            case 'updateStatus':
              showStatus(message.message);
              break;
          }
        });
        
        function showStatus(message) {
          const statusElem = document.getElementById('statusMessage');
          statusElem.textContent = message;
          statusElem.style.display = 'block';
          
          // Hide after 3 seconds
          setTimeout(() => {
            statusElem.style.display = 'none';
          }, 3000);
        }
      </script>
    </body>
    </html>`;
  }

  public dispose() {
    SettingsView.currentPanel = undefined;

    // Clean up resources
    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }
}