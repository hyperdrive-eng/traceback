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
        h3 {
          margin-top: 25px;
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
      <div>
        <label for="logText">Paste log content:</label>
        <textarea id="logText" class="code-sample" placeholder="Paste logs here. You can find example logs at the example URL above."></textarea>
        <div style="display: flex; align-items: center; gap: 10px;">
          <button id="loadText">Parse and Load</button>
          <span style="font-size: 12px; color: var(--vscode-descriptionForeground);">
            Example logs: https://raw.githubusercontent.com/hyperdrive-eng/playground/refs/heads/main/logs/checkout.log
          </span>
        </div>
      </div>

      <h3>Public URL</h3>
      <div>
        <label for="logUrl">Log URL:</label>
        <input type="text" id="logUrl" placeholder="Enter URL to log file" style="width: 100%;">
        <div style="display: flex; align-items: center; gap: 10px; margin-top: 5px;">
          <button id="loadUrl">Load URL</button>
          <span style="font-size: 12px; color: var(--vscode-descriptionForeground);">
            Example URL: https://raw.githubusercontent.com/hyperdrive-eng/playground/refs/heads/main/logs/checkout.log
          </span>
        </div>
      </div>

      <h3>Local File</h3>
      <div>
        <div style="display: flex; align-items: center; gap: 10px;">
          <button id="selectFile">Select File</button>
          <span class="current-setting" id="currentLogFile">
            ${logFilePath ? `Current: ${logFilePath}` : 'No log file selected'}
          </span>
        </div>
      </div>
      
      <h3>Axiom</h3>
      <div>
        <label for="axiomApiKey">API Key:</label>
        <input type="password" id="axiomApiKey" placeholder="xapt-01234567-89ab-cdef-0123-456789abcdef">
        
        <label for="axiomDataset">Dataset Name:</label>
        <input type="text" id="axiomDataset" value="${axiomDataset}" placeholder="otel-demo-traces">
        
        <label for="axiomQuery">Trace ID:</label>
        <input type="text" id="axiomQuery" placeholder="5bb959fd715610b1f395edcc344aba6b">
        
        <button id="saveAxiomSettings">Save Settings & Load Trace</button>
      </div>
      
      <h2>Select Repository</h2>
      
      <h3>Local Repository</h3>
      <div>
        <div style="display: flex; align-items: center; gap: 10px;">
          <button id="selectRepo">Select Repository</button>
          <span class="current-setting" id="currentRepoPath">
            ${repoPath ? `Current: ${repoPath}` : 'No repository selected'}
          </span>
        </div>
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
        
        // Example URL and logs
        const exampleUrl = 'https://raw.githubusercontent.com/hyperdrive-eng/playground/refs/heads/main/logs/checkout.log';
        const exampleLogs = 'checkout  | {"message":"Initializing new client","severity":"info","timestamp":"2025-04-11T12:35:59.036299716Z"}\n' +
'checkout  | {"message":"ClientID is the default of \'sarama\', you should consider setting it to something application-specific.","severity":"info","timestamp":"2025-04-11T12:35:59.037147591Z"}\n' +
'checkout  | {"message":"ClientID is the default of \'sarama\', you should consider setting it to something application-specific.","severity":"info","timestamp":"2025-04-11T12:35:59.037198133Z"}\n' +
'checkout  | {"message":"client/metadata fetching metadata for all topics from broker kafka:9092\\n","severity":"info","timestamp":"2025-04-11T12:35:59.039354508Z"}\n' +
'checkout  | {"message":"Connected to broker at kafka:9092 (unregistered)\\n","severity":"info","timestamp":"2025-04-11T12:35:59.045927425Z"}\n' +
'checkout  | {"message":"client/brokers registered new broker #1 at kafka:9092","severity":"info","timestamp":"2025-04-11T12:35:59.067391466Z"}\n' +
'checkout  | {"message":"Successfully initialized new client","severity":"info","timestamp":"2025-04-11T12:35:59.067508841Z"}\n' +
'checkout  | {"message":"service config: \\u0026{productCatalogSvcAddr:product-catalog:3550 cartSvcAddr:cart:7070 currencySvcAddr:currency:7001 shippingSvcAddr:shipping:50050 emailSvcAddr:http://email:6060 paymentSvcAddr:payment:50051 kafkaBrokerSvcAddr:kafka:9092 UnimplementedCheckoutServiceServer:{} KafkaProducerClient:0x400021c100 shippingSvcClient:0x4000402030 productCatalogSvcClient:0x4000402350 cartSvcClient:0x4000402670 currencySvcClient:0x4000402990 emailSvcClient:0x4000402cb0 paymentSvcClient:0x4000402fd0}","severity":"info","timestamp":"2025-04-11T12:35:59.067947175Z"}\n' +
'checkout  | {"message":"starting to listen on tcp: \\"[::]:5050\\"","severity":"info","timestamp":"2025-04-11T12:35:59.069136633Z"}\n' +
'checkout  | {"message":"[PlaceOrder] user_id=\\"9d7e2a1c-16d1-11f0-9eeb-0242ac120019\\" user_currency=\\"USD\\"","severity":"info","timestamp":"2025-04-11T12:36:39.507327138Z"}\n' +
'checkout  | {"message":"payment went through (transaction_id: 7b28d895-918c-4961-b72e-cb108aa356dc)","severity":"info","timestamp":"2025-04-11T12:36:39.610940596Z"}\n' +
'checkout  | {"message":"order confirmation email sent to \\"reed@example.com\\"","severity":"info","timestamp":"2025-04-11T12:36:39.728697055Z"}\n' +
'checkout  | {"message":"sending to postProcessor","severity":"info","timestamp":"2025-04-11T12:36:39.728720096Z"}\n' +
'checkout  | {"message":"Message sent to Kafka: {orders \\u003cnil\\u003e [10 36 57 100 56 51 49 50 98 57 45 49 54 100 49 45 49 49 102 48 45 97 100 57 50 45 48 50 52 50 97 99 49 50 48 48 49 53 18 36 52 52 56 98 97 53 52 53 45 57 97 49 100 45 52 54 52 100 45 56 51 98 99 45 100 48 99 57 101 49 101 99 101 48 102 57 26 14 10 3 85 83 68 16 183 2 24 128 202 181 238 1 34 60 10 21 49 48 48 32 87 105 110 99 104 101 115 116 101 114 32 67 105 114 99 108 101 18 9 76 111 115 32 71 97 116 111 115 26 2 67 65 34 13 85 110 105 116 101 100 32 83 116 97 116 101 115 42 5 57 53 48 51 50 42 31 10 14 10 10 79 76 74 67 69 83 80 67 55 90 16 5 18 13 10 3 85 83 68 16 101 24 255 223 225 201 3] [{[116 114 97 99 101 112 97 114 101 110 116] [48 48 45 48 53 52 97 100 56 48 54 102 101 55 48 50 54 98 54 54 51 101 99 57 51 97 57 102 54 51 51 48 50 49 100 45 55 54 48 101 54 98 56 55 101 49 50 56 57 101 55 52 45 48 49]} {[98 97 103 103 97 103 101] [115 101 115 115 105 111 110 46 105 100 61 48 50 54 99 101 57 53 100 45 98 101 101 97 45 52 101 50 102 45 56 102 100 97 45 50 100 54 57 48 97 49 56 102 101 48 49 44 115 121 110 116 104 101 116 105 99 95 114 101 113 117 101 115 116 61 116 114 117 101]}] \\u003cnil\\u003e 0 0 0001-01-01 00:00:00 +0000 UTC 0 0 \\u003cnil\\u003e 0 0 false}","severity":"info","timestamp":"2025-04-11T12:36:39.728882346Z"}\n' +
'checkout  | {"message":"ClientID is the default of \'sarama\', you should consider setting it to something application-specific.","severity":"info","timestamp":"2025-04-11T12:36:39.731395555Z"}';

        // Example URL link and copy buttons
        // Event listeners removed as we simplified the UI

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