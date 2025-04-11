# TraceBack

A VS Code extension that brings telemetry data (traces, logs, and metrics) into your code.

## Get started

1. Install extension
    1. [Download](https://github.com/hyperdrive-eng/traceback/releases) latest `.vsix` 
    1. Install VSIX
1. Open settings
1. Add a data source (local file, public URL, copy/paste, Axiom.co)
1. Select a log from the sidebar

## Features

- Click on any telemetry entry to highlight the corresponding line of code
- View variable values next to their declarations
- Navigate code execution by clicking on telemetry entries


## Development

### Setup

```sh
# Install dependencies
npm install

# Compile the extension
npm run compile

# Package the extension
npm run package
```

### Run Extension

1. Build extension

   ```sh
   npm install
   npm run compile
   ```

2. Open directory in VS Code or Cursor

   ```sh
   cursor .
   # or
   code .
   ```

3. Launch extension

   1. Press F5 to open a new window with your extension loaded
   2. If you make changes to your extension, restart the extension development host
