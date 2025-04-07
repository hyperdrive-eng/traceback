# TraceBack

> [!WARNING]  
> This extension is in **beta**. Not all features are available.

A VS Code extension that brings telemetry data (traces, logs, and metrics) into your code.

## Features

- Click on any telemetry entry to highlight the corresponding line of code
- View variable values next to their declarations
- Navigate code execution by clicking on telemetry entries

## Requirements

- Have an [Axiom.co](https://axiom.co) account
- Have an Axiom API key with `Query` access to your Axiom dataset

## Usage

1. Install the TraceBack extension
2. Open the TraceBack extension from the VS Code activity bar
3. Paste your Axiom `API key`
4. Paste a `trace ID` from your Axiom dataset
5. Click on any telemetry entry to see the details
6. The relevant code will be highlighted

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
