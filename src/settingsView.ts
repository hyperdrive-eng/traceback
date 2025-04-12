import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

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
      await this._extensionContext.globalState.update('logFilePath', logPath);
      
      // Refresh logs in the explorer
      vscode.commands.executeCommand('traceback.refreshLogs');
      
      // Notify webview about the change
      this._panel.webview.postMessage({ 
        command: 'updateLogFilePath', 
        path: logPath
      });
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

      // Set this as the log file path
      await this._extensionContext.globalState.update('logFilePath', tempFilePath);
      
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
    const axiomDataset = this._extensionContext.globalState.get<string>('axiomDataset') || 'otel-demo-traces';
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
        }
        button {
          background-color: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          padding: 8px 12px;
          border-radius: 2px;
          cursor: pointer;
        }
        button:hover {
          background-color: var(--vscode-button-hoverBackground);
        }
        .current-setting {
          margin-top: 5px;
          font-size: 12px;
          color: var(--vscode-descriptionForeground);
        }
        textarea.code-sample {
          height: 200px;
          font-family: var(--vscode-editor-font-family);
          color: var(--vscode-input-placeholderForeground);
        }
        .status {
          margin-top: 10px;
          padding: 5px;
          font-size: 12px;
          color: var(--vscode-notificationsInfoForeground);
          background-color: var(--vscode-notificationsInfoBackground);
          border-radius: 2px;
          display: none;
        }
      </style>
    </head>
    <body>
      <header>
        <h1>TraceBack Settings</h1>
      </header>
      
      <h2>Choose Data</h2>
      
      <h3>Copy/Paste</h3>
        <label for="logText">Paste log content:</label>
        <textarea id="logText" class="code-sample" placeholder="checkout  | {&quot;message&quot;:&quot;Initializing new client&quot;,&quot;severity&quot;:&quot;info&quot;,&quot;timestamp&quot;:&quot;2025-04-11T12:35:59.036299716Z&quot;}
checkout  | {&quot;message&quot;:&quot;ClientID is the default of 'sarama', you should consider setting it to something application-specific.&quot;,&quot;severity&quot;:&quot;info&quot;,&quot;timestamp&quot;:&quot;2025-04-11T12:35:59.037147591Z&quot;}
checkout  | {&quot;message&quot;:&quot;ClientID is the default of 'sarama', you should consider setting it to something application-specific.&quot;,&quot;severity&quot;:&quot;info&quot;,&quot;timestamp&quot;:&quot;2025-04-11T12:35:59.037198133Z&quot;}
checkout  | {&quot;message&quot;:&quot;client/metadata fetching metadata for all topics from broker kafka:9092\\n&quot;,&quot;severity&quot;:&quot;info&quot;,&quot;timestamp&quot;:&quot;2025-04-11T12:35:59.039354508Z&quot;}
checkout  | {&quot;message&quot;:&quot;Connected to broker at kafka:9092 (unregistered)\\n&quot;,&quot;severity&quot;:&quot;info&quot;,&quot;timestamp&quot;:&quot;2025-04-11T12:35:59.045927425Z&quot;}
checkout  | {&quot;message&quot;:&quot;client/brokers registered new broker #1 at kafka:9092&quot;,&quot;severity&quot;:&quot;info&quot;,&quot;timestamp&quot;:&quot;2025-04-11T12:35:59.067391466Z&quot;}
checkout  | {&quot;message&quot;:&quot;Successfully initialized new client&quot;,&quot;severity&quot;:&quot;info&quot;,&quot;timestamp&quot;:&quot;2025-04-11T12:35:59.067508841Z&quot;}
checkout  | {&quot;message&quot;:&quot;service config: \\u0026{productCatalogSvcAddr:product-catalog:3550 cartSvcAddr:cart:7070 currencySvcAddr:currency:7001 shippingSvcAddr:shipping:50050 emailSvcAddr:http://email:6060 paymentSvcAddr:payment:50051 kafkaBrokerSvcAddr:kafka:9092 UnimplementedCheckoutServiceServer:{} KafkaProducerClient:0x400021c100 shippingSvcClient:0x4000402030 productCatalogSvcClient:0x4000402350 cartSvcClient:0x4000402670 currencySvcClient:0x4000402990 emailSvcClient:0x4000402cb0 paymentSvcClient:0x4000402fd0}&quot;,&quot;severity&quot;:&quot;info&quot;,&quot;timestamp&quot;:&quot;2025-04-11T12:35:59.067947175Z&quot;}"></textarea>
        <button id="loadText">Parse and Load</button>

        <h3>Public URL</h3>
          <label for="logUrl">Log URL:</label>
          <input type="text" id="logUrl" placeholder="https://raw.githubusercontent.com/hyperdrive-eng/playground/refs/heads/main/logs/checkout.log">
          <button id="loadUrl">Load URL</button>
        
        <h3>Local File</h3>
          <button id="selectFile">Select File</button>
          <div class="current-setting" id="currentLogFile">
            ${logFilePath ? `Current: ${logFilePath}` : 'No log file selected'}
          </div>
        
        <h3>Axiom</h3>
          <label for="axiomApiKey">API Key:</label>
          <input type="password" id="axiomApiKey" placeholder="xapt-01234567-89ab-cdef-0123-456789abcdef">
          
          <label for="axiomDataset">Dataset Name:</label>
          <input type="text" id="axiomDataset" value="${axiomDataset}" placeholder="otel-demo-traces">
          
          <label for="axiomQuery">Trace ID:</label>
          <input type="text" id="axiomQuery" placeholder="5bb959fd715610b1f395edcc344aba6b">
          
          <button id="saveAxiomSettings">Save Settings & Load Trace</button>
      
      <h2>Select Repository</h2>
      
        <h3>Local Repository</h3>
          <button id="selectRepo">Select Repository</button>
          <div class="current-setting" id="currentRepoPath">
            ${repoPath ? `Current: ${repoPath}` : 'No repository selected'}
          </div>
      
      <div id="statusMessage" class="status"></div>
      
      <script>
        const vscode = acquireVsCodeApi();
        
        // Event listeners for buttons
        document.getElementById('selectFile').addEventListener('click', () => {
          vscode.postMessage({ command: 'selectLogFile' });
        });
        
        document.getElementById('loadUrl').addEventListener('click', () => {
          const url = document.getElementById('logUrl').value;
          vscode.postMessage({ command: 'loadFromUrl', url });
        });
        
        document.getElementById('loadText').addEventListener('click', () => {
          const text = document.getElementById('logText').value;
          vscode.postMessage({ command: 'loadFromText', text });
        });
        
        document.getElementById('saveAxiomSettings').addEventListener('click', () => {
          const apiKey = document.getElementById('axiomApiKey').value;
          const dataset = document.getElementById('axiomDataset').value;
          const query = document.getElementById('axiomQuery').value;
          vscode.postMessage({ 
            command: 'saveAxiomSettings', 
            apiKey, 
            dataset, 
            query 
          });
        });
        
        document.getElementById('selectRepo').addEventListener('click', () => {
          vscode.postMessage({ command: 'selectRepository' });
        });
        
        // Clear placeholder when focusing on textarea
        document.getElementById('logText').addEventListener('focus', function() {
          if (this.placeholder === this.getAttribute('placeholder')) {
            this.placeholder = '';
          }
        });
        
        // Restore placeholder when blurring from textarea if empty
        document.getElementById('logText').addEventListener('blur', function() {
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